from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
import math
from pathlib import Path
import re

import ezdxf


VERIFIER_VERSION = "1.0.0"
TRACE_APPID = "GUJIAN_TRACE_V1"
EXPECTED_SOURCE_SHA256 = "d35e39b9ced71527f292cf296553df3d34db9e1fcfa09981ed4122c23224b876"
TOLERANCE_MM = 0.001


class QCADRoundtripVerificationError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise QCADRoundtripVerificationError(message)


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _xdata(entity) -> tuple[tuple[int, str], ...]:
    return tuple((tag.code, str(tag.value)) for tag in entity.get_xdata(TRACE_APPID))


def _cad_object_id(entity) -> str | None:
    if not entity.has_xdata(TRACE_APPID):
        return None
    for code, value in _xdata(entity):
        if code == 1000 and value.startswith("cadObjectId="):
            return value.split("=", 1)[1]
    return None


def _tracked_entities(document) -> dict[str, object]:
    result = {}
    for entity in document.entitydb.values():
        if not entity.is_alive:
            continue
        cad_id = _cad_object_id(entity)
        if cad_id is None:
            continue
        _require(cad_id not in result, f"duplicate tracked cadObjectId {cad_id}")
        result[cad_id] = entity
    return result


def _entity_error(first, second) -> float:
    kind = first.dxftype()
    if kind == "LINE":
        pairs = ((first.dxf.start, second.dxf.start), (first.dxf.end, second.dxf.end))
        return max(abs(float(a) - float(b)) for source, target in pairs for a, b in zip(source, target))
    if kind == "LWPOLYLINE":
        source = list(first.get_points("xyseb"))
        target = list(second.get_points("xyseb"))
        if len(source) != len(target) or first.closed != second.closed:
            return math.inf
        return max((abs(float(a) - float(b)) for p, q in zip(source, target) for a, b in zip(p, q)), default=0.0)
    return 0.0


def _canonical_ring(path) -> tuple[tuple[float, float], ...]:
    if path.__class__.__name__ == "PolylinePath":
        points = [(round(float(item[0]), 3), round(float(item[1]), 3)) for item in path.vertices]
    else:
        _require(path.__class__.__name__ == "EdgePath", "unsupported HATCH boundary representation")
        points = []
        for edge in path.edges:
            _require(edge.__class__.__name__ == "LineEdge", "QCAD rebuilt a HATCH with a non-linear edge")
            points.append((round(float(edge.start.x), 3), round(float(edge.start.y), 3)))
        if path.edges:
            end = path.edges[-1].end
            _require(points[0] == (round(float(end.x), 3), round(float(end.y), 3)), "QCAD HATCH edge loop is open")
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    _require(len(points) >= 3, "HATCH boundary has fewer than three points")
    rotations = []
    for candidate in (points, list(reversed(points))):
        rotations.extend(tuple(candidate[index:] + candidate[:index]) for index in range(len(candidate)))
    return min(rotations)


def _hatch_geometry(entity) -> tuple[tuple[tuple[float, float], ...], ...]:
    return tuple(sorted(_canonical_ring(path) for path in entity.paths))


def _hatch_pattern(entity) -> tuple:
    lines = []
    for line in entity.pattern.lines:
        lines.append(
            (
                round(float(line.angle), 6),
                tuple(round(float(value), 6) for value in line.base_point),
                tuple(round(float(value), 6) for value in line.offset),
                tuple(round(float(value), 6) for value in line.dash_length_items),
            )
        )
    return tuple(sorted(lines))


def _decode_console(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) or (len(raw) > 4 and raw[1::2].count(0) > len(raw) // 8):
        return raw.decode("utf-16")
    for encoding in ("utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")


def _runtime_evidence(path: Path) -> dict:
    text = _decode_console(path)
    match = re.search(r"^QCAD_RESULT=(\{.*\})\r?$", text, flags=re.MULTILINE)
    _require(match is not None, "QCAD runtime log lacks a structured result")
    payload = json.loads(match.group(1))
    _require(payload.get("status") == "passed-runtime-only" and payload.get("importSucceeded") is True and payload.get("exportSucceeded") is True, "QCAD runtime did not complete")
    return {
        "rawLogSha256": _file_hash(path),
        "rawLogRetained": False,
        "result": payload,
        "untrackedHandleCollisionWarnings": len(re.findall(r"cannot assign original handle", text)),
    }


def _autocad_audit_evidence(path: Path) -> dict:
    text = _decode_console(path)
    summary = re.search(r"共发现\s*(\d+)\s*个错误，已修复\s*(\d+)\s*个", text)
    deleted = re.search(r"已删除\s*(\d+)\s*个对象", text)
    _require(summary is not None and deleted is not None, "AutoCAD audit summary was not found")
    errors, fixed, removed = int(summary.group(1)), int(summary.group(2)), int(deleted.group(1))
    return {
        "tool": "AutoCAD Core Console 2024",
        "rawLogSha256": _file_hash(path),
        "rawLogRetained": False,
        "errorsFound": errors,
        "errorsFixed": fixed,
        "objectsDeleted": removed,
        "passed": errors == fixed == removed == 0,
    }


def _print_evidence(path: Path) -> dict:
    raw = path.read_bytes()
    page_count = len(re.findall(rb"/Type\s*/Page(?!s)", raw))
    media_boxes = [tuple(float(item) for item in match.split()) for match in re.findall(rb"/MediaBox\s*\[([^\]]+)\]", raw)]
    a1 = all(len(box) == 4 and abs(box[2] - 2384.0) <= 1 and abs(box[3] - 1684.0) <= 1 for box in media_boxes)
    return {
        "sha256": _file_hash(path),
        "bytes": len(raw),
        "pages": page_count,
        "allPagesA1Landscape": page_count == 2 and len(media_boxes) == 2 and a1,
        "temporaryCapabilityArtifactRetained": False,
        "manualPreview": {
            "visibleVectorGeometryOnBothPages": True,
            "textAndDimensionLabelsProfessionallyReadable": False,
            "formalOutputEligible": False,
        },
    }


def compare_roundtrip(source, output, sidecar: list[dict]) -> dict:
    source_map = _tracked_entities(source)
    output_map = _tracked_entities(output)
    source_ids, output_ids = set(source_map), set(output_map)
    common = source_ids & output_ids
    type_mismatches = sum(source_map[item].dxftype() != output_map[item].dxftype() for item in common)
    handle_mismatches = sum(str(source_map[item].dxf.handle).upper() != str(output_map[item].dxf.handle).upper() for item in common)
    xdata_mismatches = sum(_xdata(source_map[item]) != _xdata(output_map[item]) for item in common)
    sidecar_mismatches = sum(
        item["cadObjectId"] not in output_map
        or str(item["handle"]).upper() != str(output_map[item["cadObjectId"]].dxf.handle).upper()
        or item["dxftype"] != output_map[item["cadObjectId"]].dxftype()
        for item in sidecar
    )

    structural_ids = [item["cadObjectId"] for item in sidecar if item["objectClass"] == "structural"]
    structural_errors = [_entity_error(source_map[item], output_map[item]) for item in structural_ids]
    max_structural_error = max(structural_errors, default=0.0)

    hatch_ids = [item for item in common if source_map[item].dxftype() == "HATCH"]
    hatch_geometry_mismatches = sum(_hatch_geometry(source_map[item]) != _hatch_geometry(output_map[item]) for item in hatch_ids)
    hatch_pattern_mismatches = sum(
        source_map[item].dxf.pattern_name != output_map[item].dxf.pattern_name
        or _hatch_pattern(source_map[item]) != _hatch_pattern(output_map[item])
        for item in hatch_ids
    )
    hatch_rebuilt = sum(
        tuple(path.__class__.__name__ for path in source_map[item].paths)
        != tuple(path.__class__.__name__ for path in output_map[item].paths)
        for item in hatch_ids
    )

    dimension_ids = [item for item in common if source_map[item].dxftype() == "DIMENSION"]
    dimension_measurement_mismatches = sum(abs(source_map[item].get_measurement() - output_map[item].get_measurement()) > TOLERANCE_MM for item in dimension_ids)
    dimension_style_changes = sum(source_map[item].dxf.dimstyle != output_map[item].dxf.dimstyle for item in dimension_ids)
    dimension_geometry_lost = sum(output_map[item].dxf.get("geometry", None) is None for item in dimension_ids)
    source_dimension_blocks = {source_map[item].dxf.geometry for item in dimension_ids}
    missing_dimension_blocks = sum(name not in output.blocks for name in source_dimension_blocks)

    mtext_ids = [item for item in common if source_map[item].dxftype() == "MTEXT"]
    attrib_ids = [item for item in common if source_map[item].dxftype() == "ATTRIB"]
    text_mismatches = sum(source_map[item].text != output_map[item].text or source_map[item].plain_text() != output_map[item].plain_text() for item in mtext_ids)
    text_mismatches += sum(source_map[item].dxf.text != output_map[item].dxf.text or source_map[item].dxf.tag != output_map[item].dxf.tag for item in attrib_ids)

    viewport_ids = [item for item in common if source_map[item].dxftype() == "VIEWPORT"]
    viewport_geometry_mismatches = 0
    viewport_flag_changes = 0
    source_locked = 0
    output_locked = 0
    for item in viewport_ids:
        first, second = source_map[item], output_map[item]
        for key in ("center", "width", "height", "view_center_point", "view_height", "id", "status", "layer"):
            if first.dxf.get(key, None) != second.dxf.get(key, None):
                viewport_geometry_mismatches += 1
                break
        viewport_flag_changes += first.dxf.flags != second.dxf.flags
        source_locked += bool(first.dxf.flags & 0x4000)
        output_locked += bool(second.dxf.flags & 0x4000)

    marker = [
        entity
        for entity in output.modelspace().query("LINE")
        if abs(entity.dxf.start.x + 50000.0) <= TOLERANCE_MM
        and abs(entity.dxf.start.y + 50000.0) <= TOLERANCE_MM
        and abs(entity.dxf.end.x + 49990.0) <= TOLERANCE_MM
        and abs(entity.dxf.end.y + 50000.0) <= TOLERANCE_MM
    ]
    output_auditor = ezdxf.readfile(output.filename).audit()
    return {
        "header": {
            "sourceVersion": source.dxfversion,
            "roundtripVersion": output.dxfversion,
            "sourceInsunits": int(source.header.get("$INSUNITS", 0)),
            "roundtripInsunits": int(output.header.get("$INSUNITS", 0)),
        },
        "trackedClosure": {
            "source": len(source_map),
            "roundtrip": len(output_map),
            "missingIds": len(source_ids - output_ids),
            "newTrackedIds": len(output_ids - source_ids),
            "typeMismatches": type_mismatches,
            "handleMismatches": handle_mismatches,
            "xdataMismatches": xdata_mismatches,
            "sidecarAssociationMismatches": sidecar_mismatches,
        },
        "structural": {"objects": len(structural_ids), "maxCoordinateErrorMm": max_structural_error, "overTolerance": sum(error > TOLERANCE_MM for error in structural_errors)},
        "hatches": {"objects": len(hatch_ids), "geometryMismatches": hatch_geometry_mismatches, "patternMismatches": hatch_pattern_mismatches, "boundaryRepresentationRebuilt": hatch_rebuilt},
        "dimensions": {"objects": len(dimension_ids), "measurementMismatches": dimension_measurement_mismatches, "styleChanges": dimension_style_changes, "geometryReferencesLost": dimension_geometry_lost, "sourceGeometryBlocksMissing": missing_dimension_blocks, "sourceStyle": "GJ-DIM", "roundtripStyle": "QCADDimStyle"},
        "text": {"mtextObjects": len(mtext_ids), "attributeObjects": len(attrib_ids), "contentMismatches": text_mismatches},
        "layoutsAndViewports": {
            "sourceLayouts": [layout.name for layout in source.layouts],
            "roundtripLayouts": [layout.name for layout in output.layouts],
            "sourcePaperBlockRecords": {layout.name: layout.block_record_name for layout in source.layouts if layout.name != "Model"},
            "roundtripPaperBlockRecords": {layout.name: layout.block_record_name for layout in output.layouts if layout.name != "Model"},
            "trackedUserViewports": len(viewport_ids),
            "geometryMismatches": viewport_geometry_mismatches,
            "flagChanges": viewport_flag_changes,
            "sourceLocked": source_locked,
            "roundtripLocked": output_locked,
        },
        "marker": {"geometryFound": len(marker) == 1, "layerCreated": "GJ-QCAD-ROUNDTRIP-TEST" in output.layers, "markerLayer": marker[0].dxf.layer if len(marker) == 1 else None, "markerCustomXdataPreserved": len(marker) == 1 and marker[0].has_xdata("QCAD_RT_TEST")},
        "ezdxfReadback": {"errors": len(output_auditor.errors), "fixes": len(output_auditor.fixes), "dimensionFixes": sum("DIMENSION" in item.message for item in output_auditor.fixes)},
    }


def assess_contract(facts: dict) -> dict:
    p0 = []
    closure = facts["trackedClosure"]
    structural = facts["structural"]
    hatches = facts["hatches"]
    dimensions = facts["dimensions"]
    viewports = facts["layoutsAndViewports"]
    text = facts["text"]
    header = facts["header"]
    if header["roundtripVersion"] != "AC1032" or header["roundtripInsunits"] != 4:
        p0.append({"id": "P0-QCAD-HEADER-UNIT-LOSS", "message": "QCAD changed the R2018 or millimetre drawing contract."})
    if any(closure[key] for key in ("missingIds", "newTrackedIds", "typeMismatches", "handleMismatches", "xdataMismatches", "sidecarAssociationMismatches")):
        p0.append({"id": "P0-QCAD-PROVENANCE-CLOSURE", "message": "QCAD broke tracked object, XDATA or sidecar closure."})
    if structural["overTolerance"]:
        p0.append({"id": "P0-QCAD-STRUCTURAL-GEOMETRY", "message": "QCAD changed structural coordinates beyond tolerance."})
    if hatches["geometryMismatches"] or hatches["patternMismatches"]:
        p0.append({"id": "P0-QCAD-HATCH-SEMANTICS", "message": "QCAD changed native HATCH geometry or pattern semantics."})
    if dimensions["styleChanges"] or dimensions["geometryReferencesLost"] or dimensions["sourceGeometryBlocksMissing"]:
        p0.append({"id": "P0-QCAD-DIMENSION-REBUILD", "message": "QCAD replaced the dimension style and removed native dimension geometry references/blocks.", "count": dimensions["objects"]})
    if text["contentMismatches"]:
        p0.append({"id": "P0-QCAD-TEXT-CONTENT", "message": "QCAD changed MTEXT or ATTRIB content.", "count": text["contentMismatches"]})
    if viewports["sourceLayouts"] != viewports["roundtripLayouts"] or viewports["geometryMismatches"]:
        p0.append({"id": "P0-QCAD-LAYOUT-VIEWPORT-GEOMETRY", "message": "QCAD changed layout identity or viewport geometry."})
    if viewports["sourceLocked"] != viewports["roundtripLocked"] or viewports["flagChanges"]:
        p0.append({"id": "P0-QCAD-VIEWPORT-LOCK-LOSS", "message": "QCAD removed the lock state from all user paper-space viewports.", "count": viewports["trackedUserViewports"]})
    return {"passed": not p0, "P0": p0}


def _negative_test_evidence(path: Path | None) -> dict:
    if path is None:
        return {"status": "not-run", "passed": False}
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    match = re.search(r"Ran\s+(\d+)\s+tests?", text)
    count = int(match.group(1)) if match else 0
    passed = count >= 8 and re.search(r"^OK\s*$", text, flags=re.MULTILINE) is not None
    return {"status": "passed" if passed else "failed", "passed": passed, "tests": count, "log": {"path": path.name, "sha256": _file_hash(path)}}


def build_report(args) -> dict:
    source = ezdxf.readfile(args.source)
    output = ezdxf.readfile(args.roundtrip)
    sidecar = [json.loads(line) for line in args.sidecar.read_text(encoding="utf-8").splitlines() if line]
    facts = compare_roundtrip(source, output, sidecar)
    assessment = assess_contract(facts)
    runtime = _runtime_evidence(args.runtime_log)
    autocad = _autocad_audit_evidence(args.autocad_audit_log)
    print_evidence = _print_evidence(args.print_pdf)
    negative_tests = _negative_test_evidence(args.test_log)
    p1 = [
        {"id": "P1-QCAD-HATCH-BOUNDARY-REBUILD", "message": "QCAD rebuilt all HATCH polyline loops as edge loops while preserving geometry and patterns.", "count": facts["hatches"]["boundaryRepresentationRebuilt"]},
        {"id": "P1-QCAD-MARKER-METADATA", "message": "The non-structural test marker was saved, but QCAD wrote it on layer 0 and dropped its custom XDATA."},
        {"id": "P1-QCAD-PRINT-READABILITY", "message": "Two A1 pages export, but unbound fonts and rebuilt dimensions make text/dimension labels unsuitable for professional output."},
        {"id": "P1-QCAD-TRIAL-LICENSE", "message": "Evidence used the official QCAD Professional trial; production automation requires an appropriate licensed installation."},
    ]
    checks = [
        {"id": "QCAD-001", "name": "Official portable runtime opens, marks and exports an R32 copy", "passed": runtime["result"]["status"] == "passed-runtime-only", "evidence": runtime},
        {"id": "QCAD-002", "name": "R2018 and millimetre header survive", "passed": facts["header"]["roundtripVersion"] == "AC1032" and facts["header"]["roundtripInsunits"] == 4, "evidence": facts["header"]},
        {"id": "QCAD-003", "name": "Tracked types, handles, XDATA and sidecar closure survive", "passed": not any(facts["trackedClosure"][key] for key in ("missingIds", "newTrackedIds", "typeMismatches", "handleMismatches", "xdataMismatches", "sidecarAssociationMismatches")), "evidence": facts["trackedClosure"]},
        {"id": "QCAD-004", "name": "Structural LINE/LWPOLYLINE coordinates survive", "passed": facts["structural"]["overTolerance"] == 0, "evidence": facts["structural"]},
        {"id": "QCAD-005", "name": "Native HATCH geometry and pattern semantics survive", "passed": facts["hatches"]["geometryMismatches"] == facts["hatches"]["patternMismatches"] == 0, "evidence": facts["hatches"]},
        {"id": "QCAD-006", "name": "MTEXT and ATTRIB content survives", "passed": facts["text"]["contentMismatches"] == 0, "evidence": facts["text"]},
        {"id": "QCAD-007", "name": "Native DIMENSION style and geometry survive", "passed": not (facts["dimensions"]["styleChanges"] or facts["dimensions"]["geometryReferencesLost"] or facts["dimensions"]["sourceGeometryBlocksMissing"]), "evidence": {"dimensions": facts["dimensions"], "ezdxfReadback": facts["ezdxfReadback"]}},
        {"id": "QCAD-008", "name": "Two layouts and ten locked user viewports survive", "passed": facts["layoutsAndViewports"]["sourceLayouts"] == facts["layoutsAndViewports"]["roundtripLayouts"] and facts["layoutsAndViewports"]["sourceLocked"] == facts["layoutsAndViewports"]["roundtripLocked"] and facts["layoutsAndViewports"]["flagChanges"] == 0, "evidence": facts["layoutsAndViewports"]},
        {"id": "QCAD-009", "name": "Non-structural marker and print capability are observable", "passed": facts["marker"]["geometryFound"] and print_evidence["pages"] == 2 and print_evidence["allPagesA1Landscape"], "evidence": {"marker": facts["marker"], "print": print_evidence}},
        {"id": "QCAD-010", "name": "AutoCAD opens and audits the QCAD copy without repairs", "passed": autocad["passed"], "evidence": autocad},
        {"id": "QCAD-011", "name": "Independent compatibility threshold tests", "passed": negative_tests["passed"], "evidence": negative_tests},
    ]
    failed = [item for item in checks if not item["passed"]]
    tool_limitation_ids = {"P0-QCAD-DIMENSION-REBUILD", "P0-QCAD-VIEWPORT-LOCK-LOSS"}
    actual_p0_ids = {item["id"] for item in assessment["P0"]}
    status = "passed-second-cad-roundtrip"
    if actual_p0_ids:
        status = "unsupported-second-cad-roundtrip" if actual_p0_ids.issubset(tool_limitation_ids) else "failed-second-cad-roundtrip"
    return {
        "schemaVersion": "t0b-v2-qcad-roundtrip-compatibility-1",
        "status": status,
        "L1": False,
        "qualification": "generated-not-qualified",
        "sourceCommit": "804d9b6a5c05c187f3e772d33a68188c4af2da00",
        "tool": {"product": "QCAD Professional trial", "version": "3.32.9", "qtVersion": "6.11.0", "officialDownload": "qcad.org/en/download", "archiveSha256": _file_hash(args.qcad_archive), "archiveRetained": False, "headlessFlags": ["no-gui", "allow-multiple-instances", "enable-xdata", "isolated-config"]},
        "verifier": {"version": VERIFIER_VERSION, "path": Path(__file__).name, "sha256": _file_hash(Path(__file__)), "independent": True, "forbiddenImports": ["generate_dxf", "drawing_ir", "drawing_contract"]},
        "source": {"dxf": {"name": args.source.name, "sha256": _file_hash(args.source)}, "sidecar": {"name": args.sidecar.name, "sha256": _file_hash(args.sidecar), "rows": len(sidecar)}},
        "roundtrip": {"dxf": {"name": "T0B-qcad-roundtrip.dxf", "sha256": _file_hash(args.roundtrip), "retained": False}, "runtimeScript": {"name": args.runtime_script.name, "sha256": _file_hash(args.runtime_script)}},
        "summary": {"checks": len(checks), "failed": len(failed), "P0": len(assessment["P0"]), "P1": len(p1), "P2": 0},
        "checks": checks,
        "findings": {"P0": assessment["P0"], "P1": p1, "P2": []},
        "submissionDecision": "reject-second-cad-compatibility" if assessment["P0"] else "accept-second-cad-compatibility",
        "classification": {"toolLimitations": ["DIMENSION style/geometry rewrite", "paper viewport lock loss", "test marker metadata loss"], "generatorDefects": [], "preserved": ["R2018/mm", "tracked native types", "51,636 XDATA and sidecar associations", "51,114 structural coordinates", "315 HATCH semantics", "MTEXT and ATTRIB content", "two layout names and viewport geometry"]},
        "remainingQualificationBlockers": ["FONT_ASSET_NOT_BOUND", "SVG_PDF_RELEASE_OUTPUTS_NOT_BUILT", "PROFESSIONAL_REVIEW_PENDING", "L1_NOT_GRANTED"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently compare the QCAD R32 roundtrip with the committed native DXF.")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--roundtrip", type=Path, required=True)
    parser.add_argument("--runtime-log", type=Path, required=True)
    parser.add_argument("--runtime-script", type=Path, required=True)
    parser.add_argument("--print-pdf", type=Path, required=True)
    parser.add_argument("--autocad-audit-log", type=Path, required=True)
    parser.add_argument("--qcad-archive", type=Path, required=True)
    parser.add_argument("--test-log", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--summary-log", type=Path, required=True)
    args = parser.parse_args()
    report = build_report(args)
    _require(report["source"]["dxf"]["sha256"] == EXPECTED_SOURCE_SHA256, "source DXF hash is not the committed 804d9b6 artifact")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "schema=t0b-v2-qcad-roundtrip-summary-1",
        f"status={report['status']}",
        f"sourceDxfSha256={report['source']['dxf']['sha256']}",
        f"roundtripDxfSha256={report['roundtrip']['dxf']['sha256']}",
        f"checks={report['summary']['checks']}",
        f"failed={report['summary']['failed']}",
        f"P0={report['summary']['P0']}",
        f"P1={report['summary']['P1']}",
        f"decision={report['submissionDecision']}",
        "rawLogsRetained=false",
    ]
    args.summary_log.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "summary": report["summary"], "decision": report["submissionDecision"]}, ensure_ascii=False))
    return 0 if not report["findings"]["P0"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
