from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import gzip
from hashlib import sha256
import json
import math
from pathlib import Path
import re
from typing import Callable
from uuid import UUID, uuid5

import ezdxf
from ezdxf import const


VERIFIER_VERSION = "1.2.0"
APPID = "GUJIAN_TRACE_V1"
CONTRACT_REVISION_NAMESPACE = UUID("e145714a-5f3c-58d8-bcc7-b34965cc5f8b")
EXPECTED_LAYOUTS = {"T0B-01", "T0B-02"}
EXPECTED_HATCH_DEFINITIONS = {
    "stone": [(45.0, (0.0, 0.0), (0.0, 24.0), []), (135.0, (0.0, 0.0), (0.0, 24.0), [])],
    "timber": [(0.0, (0.0, 0.0), (0.0, 18.0), [])],
    "earth": [(0.0, (0.0, 0.0), (0.0, 24.0), [1.0, -7.0]), (90.0, (12.0, 0.0), (24.0, 0.0), [0.0, -8.0])],
    "ceramic": [(45.0, (0.0, 0.0), (0.0, 18.0), [])],
}
FORBIDDEN_ENTITY_TYPES = {
    "ACAD_PROXY_ENTITY",
    "ACAD_PROXY_OBJECT",
    "IMAGE",
    "IMAGEDEF",
    "PDFUNDERLAY",
    "DGNUNDERLAY",
    "DWFUNDERLAY",
    "UNDERLAY",
}
FORBIDDEN_TEXT_MARKERS = (".dwg", "downloads", "file://", "http://", "https://")
ABSOLUTE_PATH = re.compile(r"(?i)(?:^|[^A-Za-z0-9_])[A-Z]:[\\/]")
TOLERANCE_MM = 0.001


class DXFVerificationError(ValueError):
    pass


@dataclass
class DXFBundle:
    contract_path: Path
    ir_path: Path
    manifest_path: Path
    font_path: Path
    dxf_path: Path
    sidecar_path: Path
    record_path: Path
    contract: dict
    ir: dict
    manifest: dict
    font: dict
    record: dict
    sidecar: list[dict]
    state: dict
    hashes: dict[str, str]
    sidecar_bytes: bytes
    double_build: dict


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise DXFVerificationError(message)


def _hash_bytes(value: bytes) -> str:
    return sha256(value).hexdigest()


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_hash(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def _point(value) -> list[float]:
    return [round(float(value[0]), 9), round(float(value[1]), 9)]


def _close(first: float, second: float, tolerance: float = TOLERANCE_MM) -> bool:
    return abs(float(first) - float(second)) <= tolerance


def _points_error(first: list[list[float]], second: list[list[float]]) -> float:
    if len(first) != len(second):
        return math.inf
    return max((abs(float(a[axis]) - float(b[axis])) for a, b in zip(first, second) for axis in range(2)), default=0.0)


def _apply(matrix: list[list[float]], point: list[float]) -> list[float]:
    return [
        float(matrix[0][0]) * point[0] + float(matrix[0][1]) * point[1] + float(matrix[0][2]),
        float(matrix[1][0]) * point[0] + float(matrix[1][1]) * point[1] + float(matrix[1][2]),
    ]


def _parse_scalar(value: str):
    if value in {"true", "false", "null"} or value.startswith("[") or value.startswith("{"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass
    return value


def _parse_xdata(entity) -> dict | None:
    if not entity.has_xdata(APPID):
        return None
    parsed: dict[str, object] = {}
    for tag in entity.get_xdata(APPID):
        _require(tag.code == 1000 and "=" in str(tag.value), f"{entity.dxf.handle} contains malformed XDATA")
        key, raw = str(tag.value).split("=", 1)
        value = _parse_scalar(raw)
        if key in parsed:
            if not isinstance(parsed[key], list) or key == "derivationTransform":
                if key == "derivationTransform" and isinstance(parsed[key], list) and parsed[key] and isinstance(parsed[key][0], list):
                    parsed[key].append(value)
                    continue
                parsed[key] = [parsed[key]]
            parsed[key].append(value)
        else:
            parsed[key] = value
    cad_object_id = parsed.pop("cadObjectId", None)
    for key in ("sourceRefs",):
        if key in parsed and not isinstance(parsed[key], list):
            parsed[key] = [parsed[key]]
    return {"cadObjectId": cad_object_id, "provenance": parsed}


def _entity_record(entity, space: str, layout_name: str | None = None, parent_handle: str | None = None) -> dict:
    kind = entity.dxftype()
    record = {
        "handle": str(entity.dxf.handle).upper(),
        "dxftype": kind,
        "space": space,
        "layoutName": layout_name,
        "parentHandle": parent_handle,
        "layer": entity.dxf.get("layer", None),
        "xdata": _parse_xdata(entity),
        "data": {},
    }
    data = record["data"]
    if kind == "LINE":
        data["points"] = [_point(entity.dxf.start), _point(entity.dxf.end)]
    elif kind == "LWPOLYLINE":
        data["points"] = [_point(item) for item in entity.get_points("xy")]
        data["closed"] = bool(entity.closed)
    elif kind == "HATCH":
        data.update(
            {
                "patternName": entity.dxf.pattern_name,
                "solidFill": int(entity.dxf.solid_fill),
                "associative": int(entity.dxf.associative),
                "patternScale": float(entity.dxf.pattern_scale),
                "patternAngle": float(entity.dxf.pattern_angle),
                "patternLines": [
                    {
                        "angle": float(line.angle),
                        "base": _point(line.base_point),
                        "offset": _point(line.offset),
                        "dash": [float(item) for item in line.dash_length_items],
                    }
                    for line in entity.pattern.lines
                ],
                "rings": [],
            }
        )
        for path in entity.paths:
            _require(path.__class__.__name__ == "PolylinePath", f"{record['handle']} uses a non-polyline HATCH boundary")
            data["rings"].append(
                {
                    "points": [_point(item) for item in path.vertices],
                    "closed": bool(path.is_closed),
                    "flags": int(path.path_type_flags),
                }
            )
    elif kind == "DIMENSION":
        data.update(
            {
                "measurement": float(entity.get_measurement()),
                "text": entity.dxf.get("text", ""),
                "dimstyle": entity.dxf.dimstyle,
                "geometry": entity.dxf.geometry,
            }
        )
    elif kind == "MTEXT":
        data.update(
            {
                "text": entity.text,
                "plainText": entity.plain_text(),
                "style": entity.dxf.style,
                "insert": _point(entity.dxf.insert),
                "height": float(entity.dxf.char_height),
            }
        )
    elif kind in {"INSERT", "ATTRIB"}:
        if kind == "INSERT":
            data.update(
                {
                    "blockName": entity.dxf.name,
                    "insert": _point(entity.dxf.insert),
                    "xscale": float(entity.dxf.get("xscale", 1.0)),
                    "yscale": float(entity.dxf.get("yscale", 1.0)),
                    "attributeHandles": [str(item.dxf.handle).upper() for item in entity.attribs],
                    "attributes": {item.dxf.tag: item.dxf.text for item in entity.attribs},
                }
            )
        else:
            data.update({"tag": entity.dxf.tag, "text": entity.dxf.text, "style": entity.dxf.style, "insert": _point(entity.dxf.insert)})
    elif kind == "VIEWPORT":
        data.update(
            {
                "id": int(entity.dxf.id),
                "status": int(entity.dxf.status),
                "center": _point(entity.dxf.center),
                "width": float(entity.dxf.width),
                "height": float(entity.dxf.height),
                "viewCenter": _point(entity.dxf.view_center_point),
                "viewHeight": float(entity.dxf.view_height),
                "flags": int(entity.dxf.flags),
                "locked": bool(entity.dxf.flags & const.VSF_VIEWPORT_ZOOM_LOCKING),
            }
        )
    return record


def _extract_state(dxf_path: Path) -> dict:
    doc = ezdxf.readfile(dxf_path)
    entities: dict[str, dict] = {}
    model_handles: list[str] = []
    paper_handles: dict[str, list[str]] = {}

    def register(entity, space: str, layout_name: str | None = None, parent_handle: str | None = None) -> None:
        record = _entity_record(entity, space, layout_name, parent_handle)
        handle = record["handle"]
        _require(handle not in entities, f"duplicate DXF handle {handle}")
        entities[handle] = record
        if entity.dxftype() == "INSERT":
            for attribute in entity.attribs:
                register(attribute, space, layout_name, handle)

    for entity in doc.modelspace():
        register(entity, "model")
        model_handles.append(str(entity.dxf.handle).upper())
        if entity.dxftype() == "INSERT":
            model_handles.extend(str(item.dxf.handle).upper() for item in entity.attribs)

    layouts: dict[str, dict] = {}
    for layout in doc.layouts:
        if layout.name == "Model":
            continue
        handles: list[str] = []
        for entity in layout:
            register(entity, "paper", layout.name)
            handles.append(str(entity.dxf.handle).upper())
            if entity.dxftype() == "INSERT":
                handles.extend(str(item.dxf.handle).upper() for item in entity.attribs)
        paper_handles[layout.name] = handles
        low, high = layout.get_paper_limits()
        layouts[layout.name] = {
            "paperLow": _point(low),
            "paperHigh": _point(high),
            "dxf": {
                "paperWidth": float(layout.dxf_layout.dxf.paper_width),
                "paperHeight": float(layout.dxf_layout.dxf.paper_height),
                "units": int(layout.dxf_layout.dxf.plot_paper_units),
                "rotation": int(layout.dxf_layout.dxf.plot_rotation),
            },
            "handles": handles,
        }

    styles = {style.dxf.name: style.dxf.get("font", "") for style in doc.styles}
    blocks = [
        {"name": block.name, "flags": int(block.block.dxf.get("flags", 0)), "xrefPath": block.block.dxf.get("xref_path", "")}
        for block in doc.blocks
    ]
    all_types = Counter(entity.dxftype() for entity in doc.entitydb.values() if entity.is_alive)
    audit = doc.audit()
    raw = dxf_path.read_text(encoding="utf-8", errors="ignore")
    external_markers = [marker for marker in FORBIDDEN_TEXT_MARKERS if marker in raw.lower()]
    if ABSOLUTE_PATH.search(raw):
        external_markers.append("absolute-path")
    return {
        "dxfVersion": doc.dxfversion,
        "insunits": int(doc.header.get("$INSUNITS", 0)),
        "measurement": int(doc.header.get("$MEASUREMENT", 0)),
        "tdcreate": float(doc.header.get("$TDCREATE", 0.0)),
        "tdupdate": float(doc.header.get("$TDUPDATE", 0.0)),
        "entities": entities,
        "modelHandles": model_handles,
        "paperHandles": paper_handles,
        "layouts": layouts,
        "layoutNames": [layout.name for layout in doc.layouts],
        "styles": styles,
        "blocks": blocks,
        "allEntityTypes": dict(all_types),
        "auditErrors": len(audit.errors),
        "auditFixes": len(audit.fixes),
        "externalMarkers": external_markers,
    }


def default_paths(root: Path) -> dict[str, Path]:
    contract = next(root.rglob("t0b-v2-drawing-package-contract.json"))
    output = contract.parent / "t0b-v2-outputs" / "native-dxf"
    return {
        "contract": contract,
        "ir": contract.parent / "t0b-v2-outputs" / "drawing-package-ir" / "drawing-package.ir.json.gz",
        "manifest": contract.parent / "t0b-v2-outputs" / "geometry-manifest.json",
        "font": root / "workers" / "cad" / "t0b_v2" / "logical_font_config.json",
        "dxf": output / "T0B.dxf",
        "sidecar": output / "T0B-source-map.ndjson",
        "record": output / "T0B-dxf-build-record.json",
        "report": output / "dxf-verification.json",
    }


def _double_build_evidence(root: Path | None, current_hashes: dict[str, str]) -> dict:
    if root is None:
        return {"status": "not-run", "allByteIdentical": False}
    mapping = {"dxf": "T0B.dxf", "sidecar": "T0B-source-map.ndjson", "record": "T0B-dxf-build-record.json"}
    files = {}
    for key, name in mapping.items():
        first = _file_hash(root / "run1" / name)
        second = _file_hash(root / "run2" / name)
        files[key] = {"run1Sha256": first, "run2Sha256": second, "matchesCanonical": first == current_hashes[key]}
    passed = all(item["run1Sha256"] == item["run2Sha256"] and item["matchesCanonical"] for item in files.values())
    return {"status": "passed" if passed else "failed", "runs": 2, "allByteIdentical": passed, "files": files}


def parse_autocad_audit(summary_path: Path | None, canonical_sha256: str) -> dict:
    if summary_path is None:
        return {"status": "not-run", "passed": False}
    raw = summary_path.read_bytes()
    _require(b"\x00" not in raw, "AutoCAD audit summary is not clean UTF-8")
    summary = json.loads(raw.decode("utf-8"))
    serialized = json.dumps(summary, ensure_ascii=False, sort_keys=True)
    _require(ABSOLUTE_PATH.search(serialized) is None, "AutoCAD audit summary contains an absolute path")
    _require("c:\\users" not in serialized.lower() and "claude_jiajia" not in serialized.lower(), "AutoCAD audit summary exposes a user or workspace path")
    _require(summary.get("schemaVersion") == "t0b-v2-autocad-audit-summary-1", "AutoCAD audit summary schema differs")
    _require(summary.get("tool") == {"product": "AutoCAD Core Console 2024", "version": "U.61.0.0 (UNICODE)"}, "AutoCAD audit tool identity differs")
    _require(summary.get("commandCategories") == ["OPEN", "AUDIT"], "AutoCAD audit command scope differs")
    _require(summary.get("canonicalDxfSha256") == canonical_sha256, "AutoCAD audit summary is bound to another DXF")
    audit_copy = summary.get("auditCopy", {})
    result = summary.get("result", {})
    conclusions = summary.get("conclusions", {})
    original = summary.get("originalTemporaryLog", {})
    _require(re.fullmatch(r"[0-9a-f]{64}", str(original.get("sha256", ""))) is not None, "original AutoCAD log SHA-256 is invalid")
    _require(original.get("retained") is False and isinstance(original.get("sanitization"), str), "raw AutoCAD log retention boundary differs")
    passed = (
        summary.get("status") == "passed"
        and result == {
            "exitCode": 0,
            "errorsFound": 0,
            "errorsFixed": 0,
            "objectsDeleted": 0,
            "defaultPaperViewportLayerRepairs": 0,
            "hatchObjectsDeleted": 0,
        }
        and audit_copy == {
            "preAuditSha256": canonical_sha256,
            "postAuditSha256": canonical_sha256,
            "byteIdenticalToCanonicalBefore": True,
            "byteIdenticalToCanonicalAfter": True,
        }
        and conclusions == {
            "defaultPaperViewportsRemainOnLayerZero": True,
            "allNativeHatchesSurviveAudit": True,
            "canonicalDxfModified": False,
        }
    )
    return {
        "status": "passed" if passed else "failed",
        "passed": passed,
        "summaryArtifact": {"path": summary_path.name, "sha256": _hash_bytes(raw)},
        **summary,
    }


def parse_negative_test_log(log_path: Path | None) -> dict:
    if log_path is None:
        return {"status": "not-run", "passed": False}
    raw = log_path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) or (len(raw) > 4 and raw[1::2].count(0) > len(raw) // 8):
        text = raw.decode("utf-16")
    else:
        text = raw.decode("utf-8", errors="replace")
    count_match = re.search(r"Ran\s+(\d+)\s+tests?", text)
    count = int(count_match.group(1)) if count_match else 0
    passed = count >= 12 and re.search(r"^OK\s*$", text, flags=re.MULTILINE) is not None
    return {
        "status": "passed" if passed else "failed",
        "passed": passed,
        "tests": count,
        "log": {"path": log_path.name, "sha256": _hash_bytes(raw)},
        "coverage": [
            "contract-hash-and-units",
            "structural-coordinates-xdata",
            "hatch-boundary-pattern",
            "dimension-delete-explode",
            "annotation-missing-override",
            "layout-viewport-scale-lock",
            "sidecar-handle-delete-duplicate",
            "external-dependency-font-path",
            "false-L1-qualification",
            "output-hash-determinism",
            "failed-AutoCAD-audit",
            "AutoCAD-audit-summary-hash-path-tamper",
        ],
    }


def load_bundle(paths: dict[str, Path], double_build_root: Path | None = None) -> DXFBundle:
    sidecar_bytes = paths["sidecar"].read_bytes()
    sidecar = [json.loads(line) for line in sidecar_bytes.decode("utf-8").splitlines() if line]
    hashes = {key: _file_hash(paths[key]) for key in ("contract", "ir", "manifest", "font", "dxf", "sidecar", "record")}
    return DXFBundle(
        contract_path=paths["contract"],
        ir_path=paths["ir"],
        manifest_path=paths["manifest"],
        font_path=paths["font"],
        dxf_path=paths["dxf"],
        sidecar_path=paths["sidecar"],
        record_path=paths["record"],
        contract=json.loads(paths["contract"].read_text(encoding="utf-8")),
        ir=json.loads(gzip.decompress(paths["ir"].read_bytes()).decode("utf-8")),
        manifest=json.loads(paths["manifest"].read_text(encoding="utf-8")),
        font=json.loads(paths["font"].read_text(encoding="utf-8")),
        record=json.loads(paths["record"].read_text(encoding="utf-8")),
        sidecar=sidecar,
        state=_extract_state(paths["dxf"]),
        hashes=hashes,
        sidecar_bytes=sidecar_bytes,
        double_build=_double_build_evidence(double_build_root, hashes),
    )


def _sidecar_indexes(bundle: DXFBundle) -> tuple[dict[str, dict], dict[str, dict]]:
    by_id: dict[str, dict] = {}
    by_handle: dict[str, dict] = {}
    for row in bundle.sidecar:
        cad_id = row.get("cadObjectId")
        handle = str(row.get("handle", "")).upper()
        _require(cad_id not in by_id, f"sidecar duplicates cadObjectId {cad_id}")
        _require(handle not in by_handle, f"sidecar duplicates handle {handle}")
        by_id[cad_id] = row
        by_handle[handle] = row
    return by_id, by_handle


def verify_inputs_header_status(bundle: DXFBundle) -> dict:
    contract, ir, record, state = bundle.contract, bundle.ir, bundle.record, bundle.state
    signature_payload = {key: value for key, value in contract.items() if key not in {"contractSignature", "contractRevisionId"}}
    signature = _canonical_hash(signature_payload)
    _require(signature == contract["contractSignature"], "DrawingPackageContract signature is invalid")
    _require(str(uuid5(CONTRACT_REVISION_NAMESPACE, signature)) == contract["contractRevisionId"], "DrawingPackageContract revision is invalid")
    ir_payload = dict(ir)
    ir_hash = ir_payload.pop("drawingPackageIrSha256", None)
    _require(ir_hash == _canonical_hash(ir_payload), "DrawingPackageIR canonical hash is invalid")
    _require(state["dxfVersion"] == "AC1032", "DXF must be AC1032/R2018")
    _require(state["insunits"] == 4 and state["measurement"] == 1, "DXF unit header is not metric millimetres")
    _require(ir["modelSpace"]["unit"] == "mm" and ir["modelSpace"]["insunits"] == 4 and ir["modelSpace"]["scale"] == "1:1", "IR model-space unit or scale is invalid")
    _require(record["schemaVersion"] == "t0b-v2-native-dxf-build-1" and record["status"] == "generated-not-qualified" and record["L1"] is False, "DXF build record qualification is invalid")
    _require(ir["qualificationBoundary"]["status"] == "generated-not-qualified" and ir["qualificationBoundary"]["L1"] is False and ir["qualificationBoundary"]["generatorMaySetEligible"] is False, "IR qualification was elevated")
    _require(record.get("crossFormatOutputs") == {"sourceIrRequired": True, "status": "generated-by-separate-ir-consumer"}, "DXF build record cross-format boundary differs")
    _require(state["auditErrors"] == 0, "ezdxf independent audit found errors")
    return {
        "dxfVersion": state["dxfVersion"],
        "insunits": state["insunits"],
        "modelSpaceScale": "1:1",
        "contractRevisionId": contract["contractRevisionId"],
        "drawingPackageIrSha256": ir_hash,
        "ezdxfAuditErrors": state["auditErrors"],
    }


def verify_structural_geometry(bundle: DXFBundle) -> dict:
    by_id, _ = _sidecar_indexes(bundle)
    entities = bundle.state["entities"]
    expected: dict[str, tuple[dict, dict]] = {}
    for stage in bundle.ir["modelSpace"]["viewStages"]:
        for line in stage["structuralLines"]:
            _require(line["cadObjectId"] not in expected, f"IR duplicates structural id {line['cadObjectId']}")
            expected[line["cadObjectId"]] = (stage, line)
    actual_ids = {row["cadObjectId"] for row in bundle.sidecar if row.get("objectClass") == "structural"}
    _require(len(expected) == 51114 and actual_ids == set(expected), "DXF structural object set differs from the 51,114 IR objects")
    max_model_error = 0.0
    max_inverse_error = 0.0
    for cad_id, (stage, line) in expected.items():
        row = by_id[cad_id]
        entity = entities.get(str(row["handle"]).upper())
        _require(entity is not None and entity["space"] == "model", f"{cad_id} is missing from model space")
        _require(entity["dxftype"] == line["cadObjectType"] and entity["layer"] == line["layer"], f"{cad_id} native type or layer differs")
        points = entity["data"].get("points", [])
        error = _points_error(points, line["modelSpacePointsMm"])
        max_model_error = max(max_model_error, error)
        _require(error <= TOLERANCE_MM, f"{cad_id} model-space coordinates differ from IR")
        inverse = [_apply(stage["modelSpaceToView"], point) for point in points]
        inverse_error = _points_error(inverse, line["viewPointsMm"])
        max_inverse_error = max(max_inverse_error, inverse_error)
        _require(inverse_error <= TOLERANCE_MM, f"{cad_id} inverse staging does not recover ViewGeometry")
        _require(entity["xdata"] == {"cadObjectId": cad_id, "provenance": line["xdata"]}, f"{cad_id} structural XDATA differs from IR")
        if entity["dxftype"] == "LWPOLYLINE":
            should_close = len(points) > 2 and _points_error([points[0]], [points[-1]]) <= TOLERANCE_MM
            _require(entity["data"]["closed"] == should_close, f"{cad_id} polyline closure differs")
    return {"structuralObjects": len(expected), "maxModelSpaceErrorMm": max_model_error, "maxInverseErrorMm": max_inverse_error}


def _canonical_ring(points: list[list[float]]) -> tuple[tuple[float, float], ...]:
    values = [(round(float(point[0]), 3), round(float(point[1]), 3)) for point in points]
    if len(values) > 1 and values[0] == values[-1]:
        values.pop()
    _require(len(values) >= 3, "HATCH ring has fewer than three points")
    rotations = []
    for candidate in (values, list(reversed(values))):
        rotations.extend(tuple(candidate[index:] + candidate[:index]) for index in range(len(candidate)))
    return min(rotations)


def _pattern_lines_match(actual: list[dict], expected: list[tuple]) -> bool:
    if len(actual) != len(expected):
        return False
    normalized_actual = sorted(
        (round(line["angle"], 6), tuple(round(v, 6) for v in line["base"]), tuple(round(v, 6) for v in line["offset"]), tuple(round(v, 6) for v in line["dash"]))
        for line in actual
    )
    normalized_expected = sorted(
        (round(angle, 6), tuple(round(v, 6) for v in base), tuple(round(v, 6) for v in offset), tuple(round(v, 6) for v in dash))
        for angle, base, offset, dash in expected
    )
    return normalized_actual == normalized_expected


def verify_material_hatches(bundle: DXFBundle) -> dict:
    by_id, _ = _sidecar_indexes(bundle)
    entities = bundle.state["entities"]
    line_by_id = {
        line["cadObjectId"]: line
        for stage in bundle.ir["modelSpace"]["viewStages"]
        for line in stage["structuralLines"]
    }
    regions = {
        region["cadObjectId"]: region
        for stage in bundle.ir["modelSpace"]["viewStages"]
        for region in stage["materialRegions"]
    }
    actual_ids = {row["cadObjectId"] for row in bundle.sidecar if row.get("objectClass") == "material-region"}
    _require(len(regions) == 315 and actual_ids == set(regions), "DXF HATCH set differs from 315 IR material regions")
    pattern_counts: Counter[str] = Counter()
    for cad_id, region in regions.items():
        row = by_id[cad_id]
        entity = entities.get(str(row["handle"]).upper())
        _require(entity is not None and entity["dxftype"] == "HATCH" and entity["space"] == "model", f"{cad_id} is not a native model-space HATCH")
        data = entity["data"]
        _require(data["solidFill"] == 0 and data["associative"] == 0 and _close(data["patternScale"], 1.0, 1e-9), f"{cad_id} HATCH mode differs")
        pattern_key = region["targetHatchPatternKey"]
        _require(data["patternName"] == region["targetHatchPatternId"], f"{cad_id} HATCH pattern id differs")
        _require(pattern_key in EXPECTED_HATCH_DEFINITIONS and _pattern_lines_match(data["patternLines"], EXPECTED_HATCH_DEFINITIONS[pattern_key]), f"{cad_id} HATCH pattern definition differs")
        if region["sourceKind"] == "ViewGeometry.cutRegion":
            expected_rings = [line_by_id[item]["modelSpacePointsMm"] for item in region["boundaryCadObjectIds"]]
        else:
            expected_rings = [region["modelSpaceOuterMm"], *region["modelSpaceHolesMm"]]
        _require(len(data["rings"]) == len(expected_rings), f"{cad_id} HATCH boundary count differs")
        _require(all(item["closed"] for item in data["rings"]), f"{cad_id} HATCH has an open boundary")
        _require([_canonical_ring(item["points"]) for item in data["rings"]] == [_canonical_ring(item) for item in expected_rings], f"{cad_id} HATCH boundary differs from IR")
        _require(entity["xdata"] == {"cadObjectId": cad_id, "provenance": region["xdata"]}, f"{cad_id} HATCH XDATA differs from IR")
        pattern_counts[data["patternName"]] += 1
    _require(pattern_counts == Counter({"GJ_EARTH_V1": 26, "GJ_STONE_V1": 21, "GJ_TIMBER_V1": 144, "GJ-CERAMIC-DEMO": 124}), "material HATCH distribution differs")
    return {"nativeHatches": len(regions), "patternCounts": dict(sorted(pattern_counts.items()))}


def _flatten_values(value: object) -> list[float]:
    if isinstance(value, dict):
        return [float(value[key]) for key in sorted(value)]
    if isinstance(value, list):
        return [float(item) for item in value]
    raise DXFVerificationError("annotation valuesMm is not structured")


def _break_count(annotation: dict, stages: dict[str, dict]) -> int:
    stage = stages[annotation["viewId"]]
    if stage["cropLimitLines"]:
        return len(stage["cropLimitLines"])
    x1, y1, x2, y2 = stage["stagedBoundsMm"]
    points = {
        (round(point[0], 3), round(point[1], 3))
        for line in stage["structuralLines"]
        for point in (line["modelSpacePointsMm"][0], line["modelSpacePointsMm"][-1])
        if min(abs(point[0] - x1), abs(point[0] - x2), abs(point[1] - y1), abs(point[1] - y2)) <= TOLERANCE_MM
    }
    return len(points)


def _expected_primary_count(annotation: dict, stages: dict[str, dict]) -> int:
    category = annotation["category"]
    payload = annotation["semanticPayload"]
    if category in {"dimensions", "levels"}:
        return len(_flatten_values(payload["valuesMm"]))
    if category == "axes":
        return 4
    if category == "breakMarks":
        return _break_count(annotation, stages)
    if category == "componentCallouts" and annotation["requirementId"] != "DR-ED-PURLIN":
        return len(payload.get("labels", []))
    if category in {"viewTitles", "notes", "componentCallouts"}:
        return 1 if "text" in payload or "label" in payload else len(payload.get("labels", []))
    return 1


def _expected_texts(annotation: dict) -> list[str]:
    payload = annotation["semanticPayload"]
    if "text" in payload:
        return [str(payload["text"])]
    if "label" in payload:
        return [str(payload["label"])]
    return [str(item) for item in payload.get("labels", [])]


def _requirement_entities(bundle: DXFBundle) -> tuple[dict[str, list[tuple[dict, dict]]], dict[str, list[tuple[dict, dict]]]]:
    entities = bundle.state["entities"]
    primary: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    attributes: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    for row in bundle.sidecar:
        if row.get("objectClass") != "annotation":
            continue
        requirement_id = row.get("provenance", {}).get("requirementId")
        entity = entities.get(str(row["handle"]).upper())
        _require(entity is not None, f"annotation sidecar handle {row['handle']} is missing")
        (attributes if row["dxftype"] == "ATTRIB" else primary)[requirement_id].append((row, entity))
    return primary, attributes


def verify_annotations_and_details(bundle: DXFBundle) -> dict:
    stages = {stage["viewId"]: stage for stage in bundle.ir["modelSpace"]["viewStages"]}
    annotations = {item["requirementId"]: item for item in bundle.ir["annotations"]}
    _require(len(annotations) == 48, "IR does not contain 48 unique annotation requirements")
    primary, attributes = _requirement_entities(bundle)
    _require(set(primary) == set(annotations), "DXF annotation requirement closure differs from the 48 IR requirements")
    total_primary = 0
    for requirement_id, annotation in annotations.items():
        payload = annotation["semanticPayload"]
        _require(payload.get("overrideAllowed") is False, f"{requirement_id} permits an annotation override")
        group = primary[requirement_id]
        expected_count = _expected_primary_count(annotation, stages)
        _require(len(group) == expected_count, f"{requirement_id} native object count differs")
        _require(all(row["dxftype"] == annotation["cadObjectType"] for row, _ in group), f"{requirement_id} native CAD type differs")
        for row, entity in [*group, *attributes.get(requirement_id, [])]:
            _require(row["provenance"] == {"requirementId": requirement_id, "sourceRefs": annotation["sourceRefs"]}, f"{requirement_id} annotation provenance differs")
            _require(entity["xdata"] == {"cadObjectId": row["cadObjectId"], "provenance": row["provenance"]}, f"{requirement_id} annotation XDATA differs")
        category = annotation["category"]
        if category == "dimensions":
            values = sorted(abs(value) for value in _flatten_values(payload["valuesMm"]))
            measured = sorted(entity["data"]["measurement"] for _, entity in group)
            _require(len(values) == len(measured) and all(_close(a, b) for a, b in zip(values, measured)), f"{requirement_id} DIMENSION measurements differ")
            _require(all(entity["data"]["text"] in {"", "<>"} and entity["data"]["dimstyle"] == "GJ-DIM" for _, entity in group), f"{requirement_id} contains a dimension text override")
        elif annotation["cadObjectType"] == "MTEXT":
            actual = sorted(entity["data"]["plainText"] for _, entity in group)
            _require(actual == sorted(_expected_texts(annotation)), f"{requirement_id} MTEXT differs from the IR semantic payload")
            _require(all(entity["data"]["style"] == "GJ-GUJIAN-SANS-SC" for _, entity in group), f"{requirement_id} uses an unexpected text style")
        elif annotation["cadObjectType"] == "INSERT":
            block_by_category = {
                "axes": "GJ_AXIS_BUBBLE",
                "levels": "GJ_LEVEL_MARK",
                "sectionMarks": "GJ_SECTION_MARK",
                "detailIndices": "GJ_DETAIL_INDEX",
                "breakMarks": "GJ_BREAK_SYMBOL",
                "titleBlocks": "GJ_TITLEBLOCK",
            }
            if category in block_by_category:
                _require(all(entity["data"]["blockName"] == block_by_category[category] for _, entity in group), f"{requirement_id} INSERT block differs")
            child_handles = {handle for _, entity in group for handle in entity["data"]["attributeHandles"]}
            actual_attribute_handles = {entity["handle"] for _, entity in attributes.get(requirement_id, [])}
            _require(child_handles == actual_attribute_handles, f"{requirement_id} ATTRIB sidecar closure differs")
            if category == "axes":
                _require(sorted(entity["data"]["attributes"].get("LABEL") for _, entity in group) == ["1", "2", "3", "4"], f"{requirement_id} axis labels differ")
            elif category == "levels":
                expected_labels = payload.get("labels", [])
                if expected_labels:
                    actual_labels = sorted(entity["data"]["attributes"].get("LEVEL") for _, entity in group)
                    _require(actual_labels == sorted(str(item) for item in expected_labels), f"{requirement_id} level labels differ")
            elif category in {"sectionMarks", "detailIndices"}:
                expected_target = str(payload.get("targetViewId", "VIEW"))
                _require(all(entity["data"]["attributes"].get("TARGET") == expected_target for _, entity in group), f"{requirement_id} reference target differs")
            elif category == "titleBlocks":
                _require(all(entity["space"] == "paper" and len(entity["data"]["attributes"]) == 9 for _, entity in group), f"{requirement_id} title block is incomplete or outside paper space")
                _require(all(entity["data"]["attributes"].get("STATUS") == "generated-not-qualified" for _, entity in group), f"{requirement_id} title block status is invalid")
        total_primary += len(group)

    system_rows = [row for row in bundle.sidecar if row.get("objectClass") == "system-annotation"]
    expected_crop_refs = {
        f"drawing-ir:{line['cadObjectId']}"
        for stage in stages.values()
        if stage["viewId"] != "eaveDetail" and stage["cropLimitLines"]
        for line in stage["cropLimitLines"]
    }
    actual_crop_refs = {row["provenance"]["sourceRefs"][0] for row in system_rows}
    _require(actual_crop_refs == expected_crop_refs and all(row["dxftype"] == "INSERT" for row in system_rows), "system crop-break closure differs")

    hatches_by_view = defaultdict(set)
    region_lookup = {
        region["cadObjectId"]: region
        for stage in bundle.ir["modelSpace"]["viewStages"]
        for region in stage["materialRegions"]
    }
    for row in bundle.sidecar:
        if row.get("objectClass") == "material-region":
            region = region_lookup[row["cadObjectId"]]
            hatches_by_view[region["viewId"]].add(region["targetHatchPatternKey"])
    gates = bundle.ir["detailGates"]
    _require({"timber", "stone", "earth"}.issubset(hatches_by_view["columnBaseDetail"]), "column-base detail material closure is incomplete")
    _require(primary["DR-BD-NOTE"][0][1]["data"]["plainText"] == gates["bracketDetail"]["mandatoryNote"], "bracket detail mandatory note differs")
    _require(len(primary["DR-ED-PURLIN"]) == 1 and gates["eaveDetail"]["isolatedUpperPurlinCalloutRequired"] is True, "eave detail purlin callout is incomplete")
    _require(sorted(abs(v) for v in _flatten_values(annotations["DR-CB-DIM"]["semanticPayload"]["valuesMm"])) == sorted(gates["columnBaseDetail"]["requiredDimensionsMm"]), "column-base dimensions differ from the detail gate")
    _require(sorted(abs(v) for v in _flatten_values(annotations["DR-DW-DIM"]["semanticPayload"]["valuesMm"])) == sorted(gates["doorWindowDetail"]["requiredDimensionsMm"]), "door/window dimensions differ from the detail gate")
    _require(sorted(_expected_texts(annotations["DR-DW-CALLOUT"])) == sorted(gates["doorWindowDetail"]["requiredCallouts"]), "door/window callout closure differs")
    return {"annotationRequirements": len(annotations), "primaryNativeObjects": total_primary, "attributeObjects": sum(len(items) for items in attributes.values()), "systemCropBreaks": len(system_rows), "detailViews": 4}


def verify_layouts_and_viewports(bundle: DXFBundle) -> dict:
    state = bundle.state
    _require(state["layoutNames"] == ["Model", "T0B-01", "T0B-02"], "DXF contains an unexpected layout or layout order")
    _require(set(state["layouts"]) == EXPECTED_LAYOUTS, "DXF user layout set differs")
    stages = {stage["viewId"]: stage for stage in bundle.ir["modelSpace"]["viewStages"]}
    _, by_handle = _sidecar_indexes(bundle)
    user_viewports = 0
    for layout_record in bundle.ir["paperSpace"]["layouts"]:
        name = layout_record["layoutName"]
        layout = state["layouts"][name]
        _require(layout["paperLow"] == [0.0, 0.0] and layout["paperHigh"] == [841.0, 594.0], f"{name} paper limits are not A1")
        _require(_close(layout["dxf"]["paperWidth"], 841.0) and _close(layout["dxf"]["paperHeight"], 594.0) and layout["dxf"]["units"] == 1 and layout["dxf"]["rotation"] == 0, f"{name} page setup is not A1 landscape millimetres")
        records = [state["entities"][handle] for handle in layout["handles"] if state["entities"][handle]["parentHandle"] is None]
        viewports = [entity for entity in records if entity["dxftype"] == "VIEWPORT"]
        default = [entity for entity in viewports if entity["data"]["id"] == 1]
        users = [entity for entity in viewports if entity["data"]["id"] > 1]
        _require(len(default) == 1 and len(users) == 5, f"{name} must contain one default and five user viewports")
        frames = [entity for entity in records if entity["dxftype"] == "LWPOLYLINE" and entity["layer"] == "GJ-FRAME"]
        title_blocks = [entity for entity in records if entity["dxftype"] == "INSERT" and entity["data"]["blockName"] == "GJ_TITLEBLOCK"]
        _require(len(frames) == 1 and len(title_blocks) == 1, f"{name} paper frame or title block differs")
        _require(by_handle[frames[0]["handle"]]["objectClass"] == "system-paper-frame", f"{name} frame provenance differs")
        expected_by_view = {item["viewId"]: item for item in layout_record["viewports"]}
        actual_by_view = {}
        for viewport in users:
            row = by_handle.get(viewport["handle"])
            _require(row is not None and row["objectClass"] == "system-viewport", f"{name} user viewport lacks sidecar provenance")
            provenance = row["provenance"]
            _require(provenance.get("layoutName") == name and provenance.get("locked") is True, f"{name} viewport provenance differs")
            actual_by_view[provenance["viewId"]] = viewport
        _require(set(actual_by_view) == set(expected_by_view), f"{name} viewport view set differs")
        for view_id, expected in expected_by_view.items():
            viewport = actual_by_view[view_id]
            x, y, width, height = expected["paperRectMm"]
            stage = stages[view_id]
            sx1, sy1, sx2, sy2 = stage["stagedBoundsMm"]
            data = viewport["data"]
            _require(data["locked"] and _points_error([data["center"]], [[x + width / 2, y + height / 2]]) <= TOLERANCE_MM, f"{view_id} viewport lock or paper center differs")
            _require(_close(data["width"], width) and _close(data["height"], height), f"{view_id} viewport paper rectangle differs")
            _require(_points_error([data["viewCenter"]], [[(sx1 + sx2) / 2, (sy1 + sy2) / 2]]) <= TOLERANCE_MM, f"{view_id} viewport model center differs")
            _require(_close(data["viewHeight"], height / float(expected["paperScale"]), 0.001), f"{view_id} viewport scale differs")
        user_viewports += len(users)
    model_entities = [state["entities"][handle] for handle in state["modelHandles"] if state["entities"][handle]["parentHandle"] is None]
    _require(not any(entity["layer"] == "GJ-FRAME" or (entity["dxftype"] == "INSERT" and entity["data"].get("blockName") == "GJ_TITLEBLOCK") for entity in model_entities), "paper frame or title block leaked into model space")
    return {"userLayouts": 2, "lockedUserViewports": user_viewports, "pageSize": "A1", "paperSpaceFrames": 2, "paperSpaceTitleBlocks": 2}


def verify_provenance_sidecar(bundle: DXFBundle) -> dict:
    by_id, by_handle = _sidecar_indexes(bundle)
    state = bundle.state
    tracked_handles = set(state["modelHandles"])
    for handles in state["paperHandles"].values():
        for handle in handles:
            entity = state["entities"][handle]
            if entity["dxftype"] == "VIEWPORT" and entity["data"]["id"] == 1:
                continue
            tracked_handles.add(handle)
    _require(set(by_handle) == tracked_handles, "sidecar handles do not close every top-level/ATTRIB drawing object")
    for handle, row in by_handle.items():
        entity = state["entities"][handle]
        _require(entity["dxftype"] == row["dxftype"], f"{handle} sidecar DXF type differs")
        _require(entity["xdata"] == {"cadObjectId": row["cadObjectId"], "provenance": row["provenance"]}, f"{handle} XDATA differs from sidecar")
    _require(len(by_id) == len(by_handle) == len(bundle.sidecar) == 51636, "sidecar unique closure count differs")
    expected_bytes = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for row in sorted(bundle.sidecar, key=lambda item: item["cadObjectId"])).encode("utf-8")
    _require(expected_bytes == bundle.sidecar_bytes, "sidecar bytes are not canonical and deterministically ordered")
    coverage = Counter(row["objectClass"] for row in bundle.sidecar)
    _require(coverage == Counter({"structural": 51114, "material-region": 315, "annotation": 184, "system-annotation": 11, "system-viewport": 10, "system-paper-frame": 2}), "sidecar object-class coverage differs")
    return {"sidecarRows": len(bundle.sidecar), "uniqueCadObjectIds": len(by_id), "uniqueHandles": len(by_handle), "objectClasses": dict(sorted(coverage.items())), "canonicalOrdering": True}


def verify_security_font_qualification(bundle: DXFBundle) -> dict:
    state, font, ir, record = bundle.state, bundle.font, bundle.ir, bundle.record
    _require(not state["externalMarkers"], f"DXF contains an external path/reference marker: {state['externalMarkers']}")
    _require(not (set(state["allEntityTypes"]) & FORBIDDEN_ENTITY_TYPES), "DXF contains image, underlay or proxy entities")
    _require(all(not block["xrefPath"] and not (block["flags"] & (4 | 8 | 16)) for block in state["blocks"]), "DXF contains an xref block")
    _require(font.get("schemaVersion") == "t0b-v2-logical-font-config-2" and font.get("assetStatus") == "bound-licensed-static-instance", "logical font binding state differs")
    _require(font.get("family") == "Gujian Sans SC" and font.get("postScriptName") == "GujianSansSC-Regular" and font.get("styleName") == "GJ-GUJIAN-SANS-SC", "logical font identity differs")
    _require(font.get("fontFileName") == "GujianSansSC-Regular.ttf" and font.get("fontSha256") == "4de4210cdf50d50bd27549cd56a5287c918378015de0773ca18f53022b75cef7", "bound static font file differs")
    _require(font.get("sourceCommit") == "038b637da7b3fd956a4ed93ffc607c3d5e4ce172" and font.get("sourceFontSha256") == "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da", "bound source font provenance differs")
    _require(font.get("instanceWeight") == 400 and font.get("fsType") == 0 and font.get("licenseSpdx") == "OFL-1.1" and font.get("pdfEmbeddingEligible") is True, "font weight, embedding or license differs")
    _require(font.get("releaseAssetIncluded") is True and font.get("qualificationBlocker") is None, "font asset blocker was not closed correctly")
    _require(state["styles"].get("GJ-GUJIAN-SANS-SC") == "GujianSansSC-Regular.ttf", "DXF bound text style differs")
    _require(not any(ABSOLUTE_PATH.search(str(value)) for value in state["styles"].values()), "DXF font style contains an absolute path")
    _require(ir["fontPolicy"]["boundFonts"] == bundle.contract["fontPolicy"]["boundFonts"] and ir["fontPolicy"]["currentBindingStatus"] == "bound-licensed-static-instance", "IR font binding differs from the contract")
    blockers = set(record["qualification"]["requiredBlockers"])
    _require({"BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED", "AUTOCAD_REAUDIT_REQUIRED", "CROSS_FORMAT_INDEPENDENT_VERIFICATION_PENDING", "PROFESSIONAL_REVIEW_PENDING"}.issubset(blockers), "required L1 blockers are missing")
    _require("FONT_ASSET_NOT_BOUND" not in blockers, "closed font blocker remains")
    _require(record["qualification"]["generatorMaySetEligible"] is False and record["L1"] is False, "DXF task claims eligibility")
    return {"externalDependencies": 0, "xrefBlocks": 0, "forbiddenEntityTypes": 0, "logicalFontStatus": "bound-licensed-static-instance", "fontWeight": 400, "L1": False, "requiredBlockers": sorted(blockers)}


def verify_hashes_and_determinism(bundle: DXFBundle) -> dict:
    record = bundle.record
    _require(record["inputs"]["contract"]["sha256"] == bundle.hashes["contract"], "build record contract hash differs")
    _require(record["inputs"]["drawingPackageIr"]["sha256"] == bundle.hashes["ir"] and record["inputs"]["drawingPackageIr"]["drawingPackageIrSha256"] == bundle.ir["drawingPackageIrSha256"], "build record IR hash differs")
    _require(record["inputs"]["manifest"]["sha256"] == bundle.hashes["manifest"], "build record manifest hash differs")
    _require(record["inputs"]["logicalFont"]["sha256"] == bundle.hashes["font"], "build record font hash differs")
    _require(record["outputs"]["dxf"]["sha256"] == bundle.hashes["dxf"], "build record DXF hash differs")
    _require(record["outputs"]["provenanceSidecar"]["sha256"] == bundle.hashes["sidecar"] and record["outputs"]["provenanceSidecar"]["rowCount"] == len(bundle.sidecar), "build record sidecar hash or count differs")
    _require(record["outputs"]["dxf"] == {"name": "T0B.dxf", "sha256": bundle.hashes["dxf"], "dxfVersion": "AC1032", "insunits": 4, "modelSpaceScale": "1:1"}, "DXF output record fields differ")
    _require(record["generatedAt"] == "2000-01-01T00:00:00Z", "build record timestamp is not deterministic")
    _require(bundle.record["readback"]["structuralXdataCoverage"] == 1.0 and bundle.record["readback"]["ezdxfAuditErrors"] == 0, "build record readback differs")
    _require(bundle.double_build.get("status") == "passed" and bundle.double_build.get("allByteIdentical") is True, "independent two-directory build is not byte-identical to the canonical outputs")
    return {"dxfSha256": bundle.hashes["dxf"], "sidecarSha256": bundle.hashes["sidecar"], "recordSha256": bundle.hashes["record"], "canonicalSidecar": True, "fixedRecordTimestamp": "2000-01-01T00:00:00Z", "independentDoubleBuild": bundle.double_build}


CHECKS: list[tuple[str, str, Callable[[DXFBundle], dict]]] = [
    ("DXF-001", "Bound inputs, AC1032/mm header, 1:1 and qualification boundary", verify_inputs_header_status),
    ("DXF-002", "51,114 native structural objects with inverse staging", verify_structural_geometry),
    ("DXF-003", "315 native material HATCH objects and team-owned patterns", verify_material_hatches),
    ("DXF-004", "48 annotation requirements, native objects and four detail gates", verify_annotations_and_details),
    ("DXF-005", "Two A1 layouts and ten locked source-bound viewports", verify_layouts_and_viewports),
    ("DXF-006", "XDATA and 51,636-row provenance sidecar closure", verify_provenance_sidecar),
    ("DXF-007", "External dependency isolation, licensed font binding and L1 boundary", verify_security_font_qualification),
    ("DXF-008", "Input/output hashes and deterministic serialization evidence", verify_hashes_and_determinism),
]


def build_report(bundle: DXFBundle, verifier_path: Path, autocad_audit: dict | None = None, negative_tests: dict | None = None) -> dict:
    checks = []
    for check_id, name, function in CHECKS:
        try:
            checks.append({"id": check_id, "name": name, "passed": True, "evidence": function(bundle)})
        except Exception as error:
            checks.append({"id": check_id, "name": name, "passed": False, "error": str(error)})
    audit = autocad_audit or {"status": "not-run", "passed": False}
    checks.append(
        {
            "id": "DXF-009",
            "name": "AutoCAD Core Console opens and audits a byte-identical temporary copy without repair or deletion",
            "passed": audit.get("passed") is True,
            "evidence": audit,
            **({} if audit.get("passed") is True else {"error": "AutoCAD AUDIT did not complete with zero errors, zero repairs and zero deleted objects"}),
        }
    )
    if negative_tests is not None:
        checks.append(
            {
                "id": "DXF-010",
                "name": "Independent tamper and qualification-boundary negative tests",
                "passed": negative_tests.get("passed") is True,
                "evidence": negative_tests,
                **({} if negative_tests.get("passed") is True else {"error": "independent DXF negative tests did not pass"}),
            }
        )
    failed = [item for item in checks if not item["passed"]]
    p0 = []
    if audit.get("result", {}).get("hatchObjectsDeleted", 0):
        p0.append(
            {
                "id": "P0-AUTOCAD-HATCH-DELETION",
                "message": "AutoCAD AUDIT deletes native HATCH objects; the DXF is not interoperable as generated.",
                "count": audit["result"]["hatchObjectsDeleted"],
            }
        )
    if audit.get("result", {}).get("defaultPaperViewportLayerRepairs", 0):
        p0.append(
            {
                "id": "P0-AUTOCAD-PAPER-VIEWPORT-REPAIR",
                "message": "AutoCAD AUDIT repairs a default paper-space viewport layer to layer 0.",
                "count": audit["result"]["defaultPaperViewportLayerRepairs"],
            }
        )
    for item in failed:
        if item["id"] != "DXF-009":
            p0.append({"id": f"P0-{item['id']}", "message": item.get("error", "independent verification failed")})
    if audit.get("status") == "not-run":
        p0.append({"id": "P0-AUTOCAD-AUDIT-MISSING", "message": "Required AutoCAD Core Console audit evidence is missing."})
    return {
        "schemaVersion": "t0b-v2-native-dxf-verification-1",
        "status": "passed-native-dxf-only" if not failed else "failed-native-dxf-verification",
        "L1": False,
        "qualification": "generated-not-qualified",
        "verifier": {"version": VERIFIER_VERSION, "path": verifier_path.name, "sha256": _file_hash(verifier_path), "independent": True, "forbiddenImports": ["generate_dxf", "drawing_ir", "drawing_contract", "view_geometry", "detail_oracle"]},
        "source": {"dxf": {"path": bundle.dxf_path.name, "sha256": bundle.hashes["dxf"]}, "sidecar": {"path": bundle.sidecar_path.name, "sha256": bundle.hashes["sidecar"], "rows": len(bundle.sidecar)}, "record": {"path": bundle.record_path.name, "sha256": bundle.hashes["record"]}},
        "summary": {"checks": len(checks), "failed": len(failed), "structuralObjects": 51114, "materialHatches": 315, "annotationRequirements": 48, "sidecarRows": len(bundle.sidecar), "layouts": 2, "lockedUserViewports": 10},
        "checks": checks,
        "independentDoubleBuild": bundle.double_build,
        "autocadCoreConsoleAudit": audit,
        "negativeTestSuite": negative_tests or {"status": "not-recorded-in-this-run"},
        "findings": {"P0": p0, "P1": [], "P2": []},
        "submissionDecision": "accept-native-dxf-task-only" if not failed else "reject-until-independent-failures-close",
        "crossFormatOutputs": bundle.record.get("crossFormatOutputs"),
        "qualificationBoundary": {"status": "generated-not-qualified", "L1": False, "fontAssetStatus": "bound-licensed-static-instance", "remainingBlockers": bundle.record.get("qualification", {}).get("requiredBlockers", [])},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify the native DXF without importing its generator.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--report", type=Path)
    parser.add_argument("--double-build-root", type=Path)
    parser.add_argument("--autocad-audit-summary", type=Path)
    parser.add_argument("--negative-test-log", type=Path)
    args = parser.parse_args()
    paths = default_paths(args.root.resolve())
    if args.report is not None:
        paths["report"] = args.report
    bundle = load_bundle(paths, args.double_build_root.resolve() if args.double_build_root is not None else None)
    audit = parse_autocad_audit(
        args.autocad_audit_summary.resolve() if args.autocad_audit_summary is not None else None,
        bundle.hashes["dxf"],
    )
    negative_tests = parse_negative_test_log(args.negative_test_log.resolve()) if args.negative_test_log is not None else None
    report = build_report(bundle, Path(__file__).resolve(), audit, negative_tests)
    paths["report"].write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
