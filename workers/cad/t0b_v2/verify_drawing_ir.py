from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import dataclass
import gzip
from hashlib import sha256
import json
import math
from pathlib import Path, PurePosixPath
import re
from typing import Callable
from uuid import UUID, uuid5


VERIFIER_VERSION = "1.1.0"
DRAWING_PACKAGE_REVISION_NAMESPACE = UUID("e145714a-5f3c-58d8-bcc7-b34965cc5f8b")
CAD_OBJECT_NAMESPACE = UUID("f19472cf-8a79-596c-b52f-d05c4dd2bc70")
GEOMETRY_REVISION_ID = "3788f4e4-339c-568d-aa58-f74b36b23c5a"
VIEW_CONTRACT_REVISION_ID = "04d00093-0bec-5f2a-bc68-def2a292c932"
VIEW_IDS = {
    "floorPlan",
    "roofPlan",
    "southElevation",
    "transverseSection",
    "longitudinalSection",
    "axonometric",
    "eaveDetail",
    "bracketDetail",
    "columnBaseDetail",
    "doorWindowDetail",
}
DETAIL_VIEW_IDS = {"eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"}
STRUCTURAL_LINE_CLASSES = {"cut", "silhouette", "feature", "componentBoundary"}
VISIBILITY_CLASSES = {"visible", "hidden"}
NATIVE_CAD_TYPES = {"DIMENSION", "TEXT", "MTEXT", "HATCH", "INSERT", "LAYOUT", "VIEWPORT"}
EXPECTED_LAYOUT_VIEWS = {
    "T0B-01": ["floorPlan", "roofPlan", "southElevation", "transverseSection", "axonometric"],
    "T0B-02": ["longitudinalSection", "eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"],
}
EXPECTED_CONTRACT_KEYS = {
    "schemaVersion",
    "contractId",
    "contractSignature",
    "contractRevisionId",
    "producerType",
    "geometryRevisionId",
    "viewContractRevisionId",
    "manifestBinding",
    "viewGeometryBindings",
    "packageIdentity",
    "dependencies",
    "modelSpacePolicy",
    "layouts",
    "viewStages",
    "layerPolicy",
    "nativeCadPolicy",
    "provenancePolicy",
    "annotationRequirements",
    "detailGates",
    "materialPolicy",
    "fontPolicy",
    "outputMatrix",
    "compatibilityMatrix",
    "qualificationBoundary",
    "determinismPolicy",
    "p0Requirements",
}
EXPECTED_IR_KEYS = {
    "schemaVersion",
    "status",
    "L1",
    "useBoundary",
    "generatedAt",
    "drawingPackageContractSignature",
    "drawingPackageContractRevisionId",
    "geometryRevisionId",
    "viewContractRevisionId",
    "manifestSha256",
    "producerType",
    "modelSpace",
    "paperSpace",
    "annotations",
    "detailGates",
    "layerPolicy",
    "nativeCadPolicy",
    "materialPolicy",
    "fontPolicy",
    "provenancePolicy",
    "provenanceSidecarRows",
    "futureOutputMatrix",
    "compatibilityMatrix",
    "qualificationBoundary",
    "determinismPolicy",
    "statistics",
    "drawingPackageIrSha256",
}
REQUIRED_LAYERS = {
    "GJ-AXIS",
    "GJ-CUT",
    "GJ-OUTLINE",
    "GJ-PROJECTION",
    "GJ-HIDDEN",
    "GJ-DIMENSION",
    "GJ-TEXT",
    "GJ-HATCH",
    "GJ-FRAME",
    "GJ-ROOF",
    "GJ-RIDGE",
    "GJ-TIMBER",
    "GJ-BRACKET",
    "GJ-WALL",
    "GJ-DOOR-WINDOW",
    "GJ-TERRACE",
    "GJ-FOUNDATION",
    "GJ-CONDITION",
}
ALLOWED_SOURCE_PREFIXES = {"demo", "manifest", "view-contract", "drawing-contract", "view-geometry"}
FORBIDDEN_MARKERS = (
    ".dwg",
    "file:",
    "http://",
    "https://",
    "\\downloads\\",
    "/downloads/",
    "寺庙古建筑设计方案图",
    "一套完整的古建施工图",
)
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
DRIVE_PATH = re.compile(r"^[a-zA-Z]:[\\/]")


class DrawingIRVerificationError(ValueError):
    pass


@dataclass
class VerificationBundle:
    contract_path: Path
    ir_path: Path
    record_path: Path
    contract: dict
    ir: dict
    record: dict
    manifest: dict
    views: dict[str, dict]
    contract_file_sha256: str
    manifest_file_sha256: str
    view_file_sha256: dict[str, str]
    ir_file_sha256: str
    ir_file_bytes: bytes


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise DrawingIRVerificationError(message)


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


def _canonical_ir_bytes(ir: dict) -> bytes:
    return (json.dumps(ir, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _load_gzip_json(path: Path) -> dict:
    return json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))


def _safe_relative(base: Path, value: object, field: str) -> Path:
    _require(isinstance(value, str) and value, f"{field} must be a nonempty relative path")
    normalized = value.replace("\\", "/")
    pure = PurePosixPath(normalized)
    _require(not pure.is_absolute() and ".." not in pure.parts and not DRIVE_PATH.match(normalized), f"{field} escaped the package directory")
    lowered = normalized.lower()
    _require(not any(marker in lowered for marker in FORBIDDEN_MARKERS), f"{field} contains an external CAD dependency")
    result = (base / Path(*pure.parts)).resolve()
    try:
        result.relative_to(base.resolve())
    except ValueError as error:
        raise DrawingIRVerificationError(f"{field} escaped the package directory") from error
    return result


def _walk_strings(value: object, path: tuple[str, ...] = ()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _walk_strings(item, (*path, str(key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _walk_strings(item, (*path, str(index)))
    elif isinstance(value, str):
        yield path, value


def _assert_external_isolation(value: object, label: str) -> None:
    for path, text in _walk_strings(value):
        if path[:2] == ("dependencies", "forbiddenKinds"):
            continue
        lowered = text.lower()
        _require(not DRIVE_PATH.match(text) and not text.startswith("/"), f"{label} contains an absolute path at {'.'.join(path)}")
        _require(not any(marker in lowered for marker in FORBIDDEN_MARKERS), f"{label} contains an external CAD marker at {'.'.join(path)}")
        key = path[-1].lower() if path else ""
        if HEX_SHA256.fullmatch(text) and any(token in key for token in ("external", "dependency", "reference")):
            raise DrawingIRVerificationError(f"{label} contains an external dependency hash at {'.'.join(path)}")


def _uuid(value: object, field: str) -> str:
    try:
        parsed = str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise DrawingIRVerificationError(f"{field} must be a canonical UUID") from error
    _require(parsed == value, f"{field} must be a canonical UUID")
    return parsed


def _sha(value: object, field: str) -> str:
    _require(isinstance(value, str) and HEX_SHA256.fullmatch(value) is not None, f"{field} must be lowercase SHA-256")
    return value


def _apply(matrix: list[list[float]], point: list[float]) -> list[float]:
    return [
        round(float(matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2]), 9),
        round(float(matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2]), 9),
    ]


def _cad_id(revision_id: str, object_kind: str, view_id: str, source_id: str) -> str:
    name = json.dumps([revision_id, object_kind, view_id, source_id], separators=(",", ":"))
    return str(uuid5(CAD_OBJECT_NAMESPACE, name))


def _rect_xywh_overlap(first: list[float], second: list[float]) -> bool:
    first_right, first_top = first[0] + first[2], first[1] + first[3]
    second_right, second_top = second[0] + second[2], second[1] + second[3]
    return not (first_right <= second[0] or second_right <= first[0] or first_top <= second[1] or second_top <= first[1])


def _rect_bounds_overlap(first: list[float], second: list[float]) -> bool:
    return not (first[2] <= second[0] or second[2] <= first[0] or first[3] <= second[1] or second[3] <= first[1])


def _path_exists(root: dict, path: str) -> bool:
    current: object = root
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return True


def load_bundle(contract_path: Path, ir_path: Path, record_path: Path) -> VerificationBundle:
    contract_path = contract_path.resolve()
    ir_path = ir_path.resolve()
    record_path = record_path.resolve()
    contract_bytes = contract_path.read_bytes()
    contract = json.loads(contract_bytes.decode("utf-8"))
    ir_file_bytes = ir_path.read_bytes()
    ir = json.loads(gzip.decompress(ir_file_bytes).decode("utf-8"))
    record = json.loads(record_path.read_text(encoding="utf-8"))
    manifest_path = _safe_relative(contract_path.parent, contract["manifestBinding"]["relativePath"], "manifestBinding.relativePath")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    views: dict[str, dict] = {}
    view_hashes: dict[str, str] = {}
    for binding in contract["viewGeometryBindings"]:
        path = _safe_relative(contract_path.parent, binding["relativePath"], f"{binding.get('viewId')}.relativePath")
        view_hashes[binding["viewId"]] = _file_hash(path)
        views[binding["viewId"]] = _load_gzip_json(path)
    return VerificationBundle(
        contract_path=contract_path,
        ir_path=ir_path,
        record_path=record_path,
        contract=contract,
        ir=ir,
        record=record,
        manifest=manifest,
        views=views,
        contract_file_sha256=_hash_bytes(contract_bytes),
        manifest_file_sha256=_file_hash(manifest_path),
        view_file_sha256=view_hashes,
        ir_file_sha256=_hash_bytes(ir_file_bytes),
        ir_file_bytes=ir_file_bytes,
    )


def verify_contract(bundle: VerificationBundle) -> dict:
    contract = bundle.contract
    _require(set(contract) == EXPECTED_CONTRACT_KEYS, "contract root schema is incomplete or contains injected fields")
    _require(contract["schemaVersion"] == "t0b-v2-drawing-package-contract-1", "contract schemaVersion is invalid")
    _uuid(contract["contractId"], "contractId")
    _sha(contract["contractSignature"], "contractSignature")
    signature_payload = {key: value for key, value in contract.items() if key not in {"contractSignature", "contractRevisionId"}}
    actual_signature = _canonical_hash(signature_payload)
    _require(actual_signature == contract["contractSignature"], "contract signature does not match canonical content")
    expected_revision = str(uuid5(DRAWING_PACKAGE_REVISION_NAMESPACE, actual_signature))
    _require(contract["contractRevisionId"] == expected_revision, "contract revision does not derive from the canonical signature")
    _require(contract["producerType"] == "demo", "contract producerType must remain demo")
    _require(contract["geometryRevisionId"] == GEOMETRY_REVISION_ID, "contract geometry revision changed")
    _require(contract["viewContractRevisionId"] == VIEW_CONTRACT_REVISION_ID, "contract view revision changed")

    manifest = contract["manifestBinding"]
    _require(set(manifest) == {"relativePath", "sha256", "geometryRevisionId", "producerType", "allowedSourceScheme"}, "manifest binding fields are invalid")
    _safe_relative(bundle.contract_path.parent, manifest["relativePath"], "manifestBinding.relativePath")
    _sha(manifest["sha256"], "manifestBinding.sha256")
    _require(manifest["geometryRevisionId"] == GEOMETRY_REVISION_ID and manifest["producerType"] == "demo" and manifest["allowedSourceScheme"] == "demo", "manifest binding identity is invalid")

    bindings = contract["viewGeometryBindings"]
    _require(isinstance(bindings, list) and len(bindings) == 10 and {item.get("viewId") for item in bindings} == VIEW_IDS, "contract must bind exactly ten views")
    for binding in bindings:
        _require(set(binding) == {"viewId", "relativePath", "fileSha256", "viewGeometrySha256", "geometryRevisionId", "viewContractRevisionId"}, f"{binding.get('viewId')} binding fields are invalid")
        _safe_relative(bundle.contract_path.parent, binding["relativePath"], f"{binding['viewId']}.relativePath")
        _sha(binding["fileSha256"], f"{binding['viewId']}.fileSha256")
        _sha(binding["viewGeometrySha256"], f"{binding['viewId']}.viewGeometrySha256")
        _require(binding["geometryRevisionId"] == GEOMETRY_REVISION_ID and binding["viewContractRevisionId"] == VIEW_CONTRACT_REVISION_ID, f"{binding['viewId']} revision binding is invalid")

    dependencies = contract["dependencies"]
    _require(dependencies.get("allowedInputKinds") == ["DrawingPackageContract", "geometryManifest", "ViewGeometry", "teamFont"], "generation input whitelist changed")
    _require(dependencies.get("fixtureReadableByIrBuilder") is False and dependencies.get("geometryRecalculationAllowed") is False and dependencies.get("structuralLineSupplementAllowed") is False, "IR generation boundary was relaxed")
    _require(dependencies.get("externalReferenceIsolation") is True and dependencies.get("deliveryMustRemainValidAfterExternalRemoval") is True, "external removal isolation is not mandatory")
    expected_forbidden = {"DWG", "xref", "image", "underlay", "proxy", "absolutePath", "externalHash", "externalLayer", "externalBlock", "externalDimension", "externalTitleBlock", "externalText", "externalPattern"}
    _require(set(dependencies.get("forbiddenKinds", [])) == expected_forbidden, "external dependency deny-list is incomplete")

    model = contract["modelSpacePolicy"]
    _require(model == {"unit": "mm", "insunits": 4, "scale": "1:1", "paperGeometryAllowed": False, "viewGeometryOperation": "translation-only-staging", "inverseLineMatchToleranceMm": 0.001, "sourceOfStructuralGeometry": "bound-ViewGeometry-only"}, "model-space policy is invalid")

    layouts = contract["layouts"]
    _require([item.get("layoutName") for item in layouts] == ["T0B-01", "T0B-02"], "two ordered layouts are required")
    seen_viewports: set[str] = set()
    for layout in layouts:
        name = layout["layoutName"]
        _require(layout.get("pageSize") == "A1" and layout.get("orientation") == "landscape" and layout.get("pageMm") == [841, 594], f"{name} is not A1 landscape")
        _require(layout.get("frameSpace") == "paperSpace" and layout.get("titleBlockSpace") == "paperSpace", f"{name} frame or title block is not paper-space only")
        _require(layout.get("viewIds") == EXPECTED_LAYOUT_VIEWS[name], f"{name} view group changed")
        viewports = layout.get("viewports")
        _require(isinstance(viewports, list) and len(viewports) == 5 and [item.get("viewId") for item in viewports] == layout["viewIds"], f"{name} viewport closure is invalid")
        for index, viewport in enumerate(viewports):
            view_id = viewport.get("viewId")
            _require(view_id not in seen_viewports, f"{view_id} appears in more than one viewport")
            seen_viewports.add(view_id)
            _require(viewport.get("cadType") == "VIEWPORT" and viewport.get("locked") is True, f"{view_id} viewport is not native and locked")
            rect = viewport.get("paperRectMm")
            _require(isinstance(rect, list) and len(rect) == 4 and all(isinstance(value, (int, float)) for value in rect), f"{view_id} paper rectangle is invalid")
            _require(rect[0] >= 0 and rect[1] >= 0 and rect[2] > 0 and rect[3] > 0 and rect[0] + rect[2] <= 841 and rect[1] + rect[3] <= 594, f"{view_id} viewport leaves the A1 page")
            denominator = int(str(viewport["scale"]).split(":", 1)[1])
            _require(math.isclose(float(viewport["paperScale"]), 1.0 / denominator, abs_tol=1e-9), f"{view_id} numeric scale differs from its label")
            for other in viewports[:index]:
                _require(not _rect_xywh_overlap(rect, other["paperRectMm"]), f"{view_id} viewport overlaps {other['viewId']}")
    _require(seen_viewports == VIEW_IDS, "layout viewports do not cover all ten views")

    stages = contract["viewStages"]
    _require(isinstance(stages, list) and len(stages) == 10 and {item.get("viewId") for item in stages} == VIEW_IDS, "ten view staging records are required")
    for stage in stages:
        view_id = stage["viewId"]
        source_rect, staged_rect = stage.get("sourceClipRectMm"), stage.get("stagedBoundsMm")
        _require(isinstance(source_rect, list) and len(source_rect) == 4 and isinstance(staged_rect, list) and len(staged_rect) == 4, f"{view_id} staging bounds are invalid")
        forward, inverse = stage.get("viewToModelSpace"), stage.get("modelSpaceToView")
        _require(isinstance(forward, list) and len(forward) == 3 and all(isinstance(row, list) and len(row) == 3 for row in forward), f"{view_id} forward staging matrix is invalid")
        _require(isinstance(inverse, list) and len(inverse) == 3 and all(isinstance(row, list) and len(row) == 3 for row in inverse), f"{view_id} inverse staging matrix is invalid")
        _require(forward[0][:2] == [1, 0] and forward[1][:2] == [0, 1] and forward[2] == [0, 0, 1], f"{view_id} forward staging is not translation-only")
        _require(inverse[0][:2] == [1, 0] and inverse[1][:2] == [0, 1] and inverse[2] == [0, 0, 1], f"{view_id} inverse staging is not translation-only")
        for point in ([source_rect[0], source_rect[1]], [source_rect[2], source_rect[3]]):
            staged = _apply(forward, point)
            restored = _apply(inverse, staged)
            _require(max(abs(restored[axis] - point[axis]) for axis in range(2)) <= 1e-9, f"{view_id} staging inverse is invalid")
        _require(_apply(forward, source_rect[:2]) == staged_rect[:2] and _apply(forward, source_rect[2:]) == staged_rect[2:], f"{view_id} staged bounds do not match the transform")
    for index, first in enumerate(stages):
        for second in stages[index + 1 :]:
            _require(not _rect_bounds_overlap(first["stagedBoundsMm"], second["stagedBoundsMm"]), f"{first['viewId']} and {second['viewId']} staging bounds overlap")

    layer = contract["layerPolicy"]
    _require(set(layer.get("layers", {})) == REQUIRED_LAYERS, "layer matrix is incomplete")
    expected_base = {"cut": "GJ-CUT", "silhouette": "GJ-OUTLINE", "feature": "GJ-PROJECTION", "componentBoundary": "GJ-PROJECTION", "axis": "GJ-AXIS", "dimension": "GJ-DIMENSION", "annotation": "GJ-TEXT", "hatch": "GJ-HATCH", "frame": "GJ-FRAME"}
    _require(layer.get("baseClassLayerMap") == expected_base, "base line-class mapping changed")
    _require(layer.get("visibilityLayerOverride") == {"visible": None, "hidden": "GJ-HIDDEN"} and layer.get("hiddenOverrideOnly") is True and layer.get("featureMustRemainProjection") is True, "visibility layer policy changed")
    _require(layer.get("minimumPrintDpi") == 300 and layer.get("minimumTextHeightMm", 0) >= 2.5, "print readability floor is incomplete")

    native = contract["nativeCadPolicy"]
    _require(set(native.get("requiredTypes", [])) == NATIVE_CAD_TYPES, "native CAD type matrix is incomplete")
    _require(set(native.get("annotationClosure", [])) == {"axisGrid", "dimensionChain", "level", "sectionMark", "detailIndex", "viewTitleScale", "titleBlock"}, "native annotation closure is incomplete")
    _require(native.get("dimensionValuePolicy") == {"source": "fixture-or-manifest-derived", "externalValuesAllowed": False, "textOverrideAllowed": False}, "dimension value policy was relaxed")
    _require(native.get("proxyObjectsAllowed") is False and native.get("repeatedSymbolsUseInsert") is True, "proxy or symbol policy is invalid")

    provenance = contract["provenancePolicy"]
    _require(provenance.get("structuralCoverage") == 1.0 and provenance.get("annotationCoverage") == 1.0, "provenance coverage is below 100%")
    _require(provenance.get("xdataApplicationId") == "GUJIAN_TRACE_V1", "XDATA application id changed")
    _require(provenance.get("structuralXdataFields") == ["sourceEntityId", "geometryRevisionId", "viewContractRevisionId", "viewId", "derivation", "derivationTransform"], "structural XDATA fields are incomplete")
    _require(provenance.get("annotationXdataFields") == ["requirementId", "sourceRefs"], "annotation XDATA fields are incomplete")
    _require(provenance.get("sidecarFormat") == "ndjson" and provenance.get("sidecarKey") == "handle-or-cadObjectId" and provenance.get("systemObjectClass") == "system-paper-only", "sidecar policy is invalid")

    annotations = contract["annotationRequirements"]
    _require(set(annotations.get("views", {})) == VIEW_IDS, "annotation requirements do not cover ten views")
    requirement_ids: set[str] = set()
    requirement_count = 0
    expected_categories = {"axes", "dimensions", "levels", "sectionMarks", "detailIndices", "viewTitles", "notes", "componentCallouts", "breakMarks"}
    for view_id, categories in annotations["views"].items():
        _require(set(categories) == expected_categories, f"{view_id} annotation categories are incomplete")
        for category, records in categories.items():
            _require(isinstance(records, list), f"{view_id}.{category} must be a list")
            for record in records:
                requirement_id = record.get("requirementId")
                _require(isinstance(requirement_id, str) and requirement_id and requirement_id not in requirement_ids, f"duplicate or missing requirementId in {view_id}.{category}")
                requirement_ids.add(requirement_id)
                requirement_count += 1
                _require(record.get("overrideAllowed") is False, f"{requirement_id} permits an override")
                _require(record.get("cadType") in NATIVE_CAD_TYPES, f"{requirement_id} uses a non-native CAD type")
                refs = record.get("sourceRefs")
                _require(isinstance(refs, list) and refs and all(isinstance(ref, str) and ref.split(":", 1)[0] in ALLOWED_SOURCE_PREFIXES for ref in refs), f"{requirement_id} sourceRefs are not closed")
                if category in {"dimensions", "levels"}:
                    _require(isinstance(record.get("valuesMm"), (list, dict)) and bool(record["valuesMm"]), f"{requirement_id} does not freeze source values")
    title_blocks = annotations.get("titleBlocks")
    _require(isinstance(title_blocks, list) and len(title_blocks) == 2 and [item.get("layoutName") for item in title_blocks] == ["T0B-01", "T0B-02"], "two title-block requirements are required")
    for record in title_blocks:
        requirement_id = record.get("requirementId")
        _require(isinstance(requirement_id, str) and requirement_id not in requirement_ids and record.get("cadType") == "INSERT" and record.get("overrideAllowed") is False, "title-block requirement is invalid")
        requirement_ids.add(requirement_id)
        requirement_count += 1
        _require(bool(record.get("sourceRefs")), f"{requirement_id} sourceRefs are missing")
    _require(requirement_count == 48, f"expected 48 annotation requirements, found {requirement_count}")

    detail = contract["detailGates"]
    _require(set(detail) == DETAIL_VIEW_IDS, "four detail gates are required")
    _require(detail["eaveDetail"].get("isolatedUpperPurlinCalloutRequired") is True and detail["eaveDetail"].get("breakAtEveryCropTermination") is True, "eave detail gate is incomplete")
    _require(detail["bracketDetail"].get("mandatoryNote") == "团队演示承托构造，非实测/非正式节点" and detail["bracketDetail"].get("l1BlockerCode") == "BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", "bracket detail blocker is incomplete")
    _require(detail["columnBaseDetail"].get("requiredHatches") == ["timber", "stone", "earth"] and detail["columnBaseDetail"].get("requiredLevelsMm") == [-800, 0, 600] and detail["columnBaseDetail"].get("requiredDimensionsMm") == [560, 400, 240, 800], "column-base detail gate is incomplete")
    _require(detail["doorWindowDetail"].get("requiredDimensionsMm") == [1800, 2700, 720, 1500] and detail["doorWindowDetail"].get("requiredCallouts") == ["frame", "leaf", "lattice"], "door/window detail gate is incomplete")

    material = contract["materialPolicy"]
    patterns = material.get("patterns", {})
    _require(set(patterns) == {"stone", "timber", "earth", "ceramic"}, "material pattern set is incomplete")
    _require(patterns["stone"] == {"patternId": "GJ_STONE_V1", "definition": "team-lines-45-135"}, "stone hatch definition changed")
    _require(patterns["timber"] == {"patternId": "GJ_TIMBER_V1", "definition": "team-lines-0"}, "timber hatch definition changed")
    _require(patterns["earth"] == {"patternId": "GJ_EARTH_V1", "definition": "team-dots-and-lines"}, "earth hatch definition changed")
    _require(
        patterns["ceramic"]
        == {
            "patternId": "GJ-CERAMIC-DEMO",
            "definition": "team-parallel-lines-45-demo",
            "appliesToMaterialCodes": ["ceramic-demo", "ceramic"],
            "angleDeg": 45,
            "spacingMm": 18,
            "scale": 1.0,
            "unit": "mm",
            "source": "team-owned-demo",
            "externalSourceDerived": False,
        },
        "team-owned ceramic hatch definition is invalid",
    )
    expected_material_map = {"stone-demo": "stone", "stone": "stone", "timber-demo": "timber", "timber": "timber", "earth-demo": "earth", "earth": "earth", "ceramic-demo": "ceramic", "ceramic": "ceramic"}
    _require(material.get("materialCodePatternMap") == expected_material_map, "material-code hatch mapping is incomplete")
    _require(material.get("patternOwnership") == "team-owned" and material.get("boundarySourceKinds") == ["ViewGeometry.cutRegion", "ViewGeometry.materialRegion"] and material.get("boundaryRecalculationRequired") is True and material.get("externalPatternAllowed") is False, "material policy is incomplete")
    font = contract["fontPolicy"]
    _require(font.get("currentBindingStatus") == "bound-licensed-static-instance" and font.get("blockerCode") is None, "font binding state is invalid")
    _require(set(font.get("forbiddenFamilies", [])) == {"SimHei", "LiSu", "NEW-ROMD"} and font.get("redistributionLicenseRequired") is True and font.get("pdfEmbeddingRequired") is True, "font licensing policy is incomplete")
    bound_fonts = font.get("boundFonts")
    _require(isinstance(bound_fonts, list) and len(bound_fonts) == 1, "exactly one drawing font must be bound")
    bound_font = bound_fonts[0]
    _require(
        bound_font.get("fontId") == "gujian-sans-sc-regular-400-v1"
        and bound_font.get("family") == "Gujian Sans SC"
        and bound_font.get("postScriptName") == "GujianSansSC-Regular"
        and bound_font.get("cadStyleName") == "GJ-GUJIAN-SANS-SC"
        and bound_font.get("instanceWeight") == 400
        and bound_font.get("fsType") == 0,
        "bound drawing font identity or weight differs",
    )
    _require(bound_font.get("licenseSpdx") == "OFL-1.1" and bound_font.get("redistributionAllowed") is True and bound_font.get("pdfEmbeddingAllowed") is True, "bound font redistribution policy differs")
    _require(bound_font.get("sourceCommit") == "038b637da7b3fd956a4ed93ffc607c3d5e4ce172", "bound font source commit differs")
    _require(bound_font.get("sourceFontSha256") == "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da", "bound source font hash differs")
    _require(bound_font.get("sha256") == "4de4210cdf50d50bd27549cd56a5287c918378015de0773ca18f53022b75cef7", "bound static font hash differs")
    coverage = bound_font.get("glyphCoverage", {})
    _require(coverage.get("requiredCodepointCount") == coverage.get("coveredCodepointCount") == 168 and coverage.get("missingCodepoints") == [], "bound font glyph coverage differs")

    outputs = contract["outputMatrix"]
    _require(outputs.get("dxf") == {"files": ["T0B.dxf"], "modelSpaceUnit": "mm", "insunits": 4, "modelSpaceScale": "1:1", "layouts": ["T0B-01", "T0B-02"], "sourceIrRequired": True}, "future DXF matrix is invalid")
    _require(outputs.get("svg") == {"files": ["T0B-01.svg", "T0B-02.svg"], "pageMm": [841, 594], "vectorRequired": True, "searchableText": True, "sourceIrRequired": True}, "future SVG matrix is invalid")
    _require(outputs.get("pdf") == {"files": ["T0B.pdf"], "pages": 2, "pageMm": [841, 594], "vectorRequired": True, "searchableText": True, "embeddedFonts": True, "sourceIrRequired": True}, "future PDF matrix is invalid")
    _require(outputs.get("reviewPng") == {"files": ["T0B-01-300dpi.png", "T0B-02-300dpi.png"], "dpi": 300, "pixelSize": [9933, 7016], "sourceIrRequired": True}, "future PNG matrix is invalid")
    _require(outputs.get("crossFormatIrConsistencyRequired") is True and outputs.get("reverseParseObjectTextPageFrameMatchRequired") is True, "cross-format reverse parsing is not mandatory")

    compatibility = contract["compatibilityMatrix"]
    _require(set(compatibility) == {"AutoCAD", "QCAD"} and compatibility["AutoCAD"].get("auditErrors") == 0, "CAD compatibility matrix is incomplete")
    _require(compatibility["QCAD"].get("operations") == ["open", "select", "edit", "save", "print", "reverseParse"] and compatibility["QCAD"].get("roundtripCopyIsCanonical") is False, "QCAD roundtrip boundary is invalid")

    qualification = contract["qualificationBoundary"]
    _require(qualification.get("status") == "generated-not-qualified" and qualification.get("L1") is False and qualification.get("useBoundary") == ["demo-only", "not-for-formal-signoff"], "qualification boundary was elevated")
    _require(qualification.get("generatorMaySetEligible") is False and qualification.get("independentVerificationRequired") is True and qualification.get("professionalGroupedReviewRequired") is True, "qualification responsibility boundary is incomplete")
    required_blockers = {"BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED", "AUTOCAD_REAUDIT_REQUIRED", "CROSS_FORMAT_INDEPENDENT_VERIFICATION_PENDING", "PROFESSIONAL_REVIEW_PENDING"}
    _require(set(qualification.get("requiredBlockers", [])) >= required_blockers, "known L1 blockers are missing")
    _require("FONT_ASSET_NOT_BOUND" not in qualification.get("requiredBlockers", []) and "DRAWING_OUTPUTS_NOT_BUILT" not in qualification.get("requiredBlockers", []), "closed font or output blocker remains")
    determinism = contract["determinismPolicy"]
    _require(determinism == {"fixedTimestamp": "2000-01-01T00:00:00Z", "gzipMtime": 0, "stableOrdering": ["layoutName", "viewId", "sourceLineId", "requirementId", "cadObjectId"], "volatileMetadataAllowed": False, "temporaryDirectoryDoubleBuildRequired": True, "fullArtifactHashMustMatch": True, "contractChangeRequiresNewSignatureAndRevision": True}, "determinism policy is invalid")

    p0 = contract["p0Requirements"]
    _require(isinstance(p0, list) and [item.get("id") for item in p0] == [f"DP-P0-{index:02d}" for index in range(1, 13)], "twelve ordered P0 mappings are required")
    for item in p0:
        fields = item.get("contractFields")
        _require(isinstance(fields, list) and fields and all(_path_exists(contract, path) for path in fields), f"{item.get('id')} maps a missing contract field")
    _assert_external_isolation(contract, "DrawingPackageContract")
    return {"contractSignature": actual_signature, "contractRevisionId": expected_revision, "annotationRequirements": requirement_count, "p0Mappings": len(p0)}


def verify_bound_inputs(bundle: VerificationBundle) -> dict:
    contract = bundle.contract
    manifest_binding = contract["manifestBinding"]
    _require(bundle.manifest_file_sha256 == manifest_binding["sha256"], "geometry manifest file hash differs from the contract")
    manifest = bundle.manifest
    _require(manifest.get("geometryRevisionId") == GEOMETRY_REVISION_ID and manifest.get("producerType") == "demo", "geometry manifest identity is invalid")
    entity_list = manifest.get("entities")
    _require(isinstance(entity_list, list) and entity_list, "geometry manifest has no entities")
    entity_ids = [item.get("entityId") for item in entity_list]
    _require(all(isinstance(value, str) for value in entity_ids) and len(entity_ids) == len(set(entity_ids)), "geometry manifest entity IDs are invalid")
    source_refs = [*manifest.get("sourceRefs", []), *(ref for entity in entity_list for ref in entity.get("sourceRefs", []))]
    _require(source_refs and all(isinstance(ref, str) and ref.startswith("demo:") for ref in source_refs), "geometry manifest contains a non-demo source")

    record_views = {item["viewId"]: item for item in bundle.record.get("inputs", {}).get("viewGeometry", [])}
    _require(set(record_views) == VIEW_IDS, "build record does not bind ten views")
    total_lines = total_crop = total_cut_regions = total_material_regions = 0
    for binding in contract["viewGeometryBindings"]:
        view_id = binding["viewId"]
        view = bundle.views[view_id]
        _require(bundle.view_file_sha256[view_id] == binding["fileSha256"], f"{view_id} compressed file hash differs from the contract")
        _require(record_views[view_id] == {"viewId": view_id, "fileSha256": binding["fileSha256"], "viewGeometrySha256": binding["viewGeometrySha256"]}, f"{view_id} build-record binding differs from the contract")
        hash_payload = deepcopy(view)
        stored_hash = hash_payload.pop("viewGeometrySha256", None)
        actual_hash = _canonical_hash(hash_payload)
        _require(stored_hash == actual_hash == binding["viewGeometrySha256"], f"{view_id} internal ViewGeometry hash is invalid")
        _require(view.get("viewId") == view_id and view.get("geometryRevisionId") == GEOMETRY_REVISION_ID and view.get("viewContractRevisionId") == VIEW_CONTRACT_REVISION_ID, f"{view_id} top-level identity is invalid")
        _require(view.get("status") == "generated-not-qualified" and view.get("qualification") == "not-drawing-output", f"{view_id} qualification state is invalid")
        stage = next(item for item in contract["viewStages"] if item["viewId"] == view_id)
        _require(view.get("viewFrame", {}).get("clipRectMm") == stage["sourceClipRectMm"], f"{view_id} clip rectangle differs from the staging contract")
        line_ids: list[str] = []
        for category in ("cutLines", "projectionLines", "cropLimitLines"):
            for line in view.get(category, []):
                line_ids.append(line.get("lineId"))
                expected_class = "cropLimit" if category == "cropLimitLines" else None
                _require(line.get("viewId") == view_id and line.get("geometryRevisionId") == GEOMETRY_REVISION_ID and line.get("viewContractRevisionId") == VIEW_CONTRACT_REVISION_ID, f"{view_id}:{line.get('lineId')} line identity is invalid")
                _require(isinstance(line.get("pointsMm"), list) and len(line["pointsMm"]) >= 2, f"{view_id}:{line.get('lineId')} has invalid points")
                _require(line.get("visibility", "visible") in VISIBILITY_CLASSES, f"{view_id}:{line.get('lineId')} has invalid visibility")
                if expected_class:
                    _require(line.get("lineClass") == expected_class and line.get("structural") is False, f"{view_id}:{line.get('lineId')} crop classification is invalid")
                else:
                    _require(line.get("lineClass") in STRUCTURAL_LINE_CLASSES, f"{view_id}:{line.get('lineId')} structural class is invalid")
                _require(line.get("sourceEntityId") in set(entity_ids), f"{view_id}:{line.get('lineId')} source entity is absent from the manifest")
        _require(len(line_ids) == len(set(line_ids)), f"{view_id} contains duplicate line IDs")
        region_ids: list[str] = []
        for category in ("cutRegions", "materialRegions"):
            for region in view.get(category, []):
                region_ids.append(region.get("regionId"))
                _require(region.get("viewId") == view_id and region.get("geometryRevisionId") == GEOMETRY_REVISION_ID and region.get("viewContractRevisionId") == VIEW_CONTRACT_REVISION_ID, f"{view_id}:{region.get('regionId')} material identity is invalid")
                _require(region.get("sourceEntityId") in set(entity_ids), f"{view_id}:{region.get('regionId')} material source is absent from the manifest")
        _require(len(region_ids) == len(set(region_ids)), f"{view_id} contains duplicate material-region IDs")
        total_lines += len(view.get("cutLines", [])) + len(view.get("projectionLines", []))
        total_crop += len(view.get("cropLimitLines", []))
        total_cut_regions += len(view.get("cutRegions", []))
        total_material_regions += len(view.get("materialRegions", []))
        _assert_external_isolation(view, f"ViewGeometry {view_id}")
    return {"views": 10, "structuralLines": total_lines, "cropLimitLines": total_crop, "cutRegions": total_cut_regions, "materialRegions": total_material_regions, "manifestEntities": len(entity_ids)}


def _expected_line(contract: dict, stage: dict, view_id: str, source: dict, manifest_entity: dict, structural: bool) -> dict:
    points = source["pointsMm"]
    model_points = [_apply(stage["viewToModelSpace"], point) for point in points]
    restored = [_apply(stage["modelSpaceToView"], point) for point in model_points]
    tolerance = float(contract["modelSpacePolicy"]["inverseLineMatchToleranceMm"])
    _require(all(max(abs(restored[index][axis] - points[index][axis]) for axis in range(2)) <= tolerance for index in range(len(points))), f"{view_id}:{source['lineId']} fails independent inverse staging")
    line_class = source["lineClass"]
    if structural:
        layer = contract["layerPolicy"]["baseClassLayerMap"].get(line_class)
    else:
        layer = "GJ-HATCH" if line_class == "cropLimit" else None
    if source.get("visibility") == "hidden":
        layer = contract["layerPolicy"]["visibilityLayerOverride"]["hidden"]
    _require(layer is not None, f"{view_id}:{source['lineId']} has no line-layer mapping")
    object_kind = "structural-line" if structural else "crop-limit"
    object_class = "structural" if structural else "nonstructural-crop-limit"
    return {
        "cadObjectId": _cad_id(contract["contractRevisionId"], object_kind, view_id, source["lineId"]),
        "cadObjectType": "LWPOLYLINE" if len(points) > 2 or source.get("closed") else "LINE",
        "objectClass": object_class,
        "viewId": view_id,
        "sourceLineId": source["lineId"],
        "sourceEntityId": source["sourceEntityId"],
        "sourceComponentType": source["sourceComponentType"],
        "sourceRefs": manifest_entity["sourceRefs"],
        "geometryRevisionId": contract["geometryRevisionId"],
        "viewContractRevisionId": contract["viewContractRevisionId"],
        "derivation": source["derivation"],
        "derivationTransform": source["derivationTransform"],
        "lineClass": line_class,
        "visibility": source.get("visibility", "visible"),
        "layer": layer,
        "viewPointsMm": points,
        "modelSpacePointsMm": model_points,
        "xdata": {
            "applicationId": contract["provenancePolicy"]["xdataApplicationId"],
            "sourceEntityId": source["sourceEntityId"],
            "geometryRevisionId": contract["geometryRevisionId"],
            "viewContractRevisionId": contract["viewContractRevisionId"],
            "viewId": view_id,
            "derivation": source["derivation"],
            "derivationTransform": source["derivationTransform"],
        },
    }


def _expected_materials(contract: dict, stage: dict, view: dict, structural_by_line: dict[str, str], entities: dict[str, dict]) -> list[dict]:
    view_id = view["viewId"]
    result: list[dict] = []
    for source in view.get("cutRegions", []):
        boundary_ids = [source["outerBoundaryLineId"], *source.get("holeBoundaryLineIds", [])]
        _require(all(line_id in structural_by_line for line_id in boundary_ids), f"{view_id}:{source['regionId']} cut boundary is missing")
        material_code = source["materialCode"]
        pattern_key = contract["materialPolicy"]["materialCodePatternMap"].get(material_code)
        _require(pattern_key in contract["materialPolicy"]["patterns"], f"{view_id}:{source['regionId']} has no target hatch mapping")
        pattern = contract["materialPolicy"]["patterns"][pattern_key]
        result.append(
            {
                "cadObjectId": _cad_id(contract["contractRevisionId"], "material-region", view_id, source["regionId"]),
                "cadObjectType": "HATCH",
                "objectClass": "material-region",
                "viewId": view_id,
                "sourceRegionId": source["regionId"],
                "sourceKind": "ViewGeometry.cutRegion",
                "sourceEntityId": source["sourceEntityId"],
                "sourceRefs": entities[source["sourceEntityId"]]["sourceRefs"],
                "materialCode": material_code,
                "sourceMaterialHatch": source.get("materialHatch"),
                "targetHatchPatternKey": pattern_key,
                "targetHatchPatternId": pattern["patternId"],
                "layer": "GJ-HATCH",
                "boundaryCadObjectIds": [structural_by_line[line_id] for line_id in boundary_ids],
                "xdata": {"applicationId": contract["provenancePolicy"]["xdataApplicationId"], "sourceEntityId": source["sourceEntityId"], "geometryRevisionId": contract["geometryRevisionId"], "viewContractRevisionId": contract["viewContractRevisionId"], "viewId": view_id, "derivation": "ViewGeometry.cutRegion", "derivationTransform": view["viewFrame"]["modelToView"]},
            }
        )
    for source in view.get("materialRegions", []):
        material_code = source["materialCode"]
        pattern_key = contract["materialPolicy"]["materialCodePatternMap"].get(material_code)
        _require(pattern_key in contract["materialPolicy"]["patterns"], f"{view_id}:{source['regionId']} has no target hatch mapping")
        pattern = contract["materialPolicy"]["patterns"][pattern_key]
        result.append(
            {
                "cadObjectId": _cad_id(contract["contractRevisionId"], "material-region", view_id, source["regionId"]),
                "cadObjectType": "HATCH",
                "objectClass": "material-region",
                "viewId": view_id,
                "sourceRegionId": source["regionId"],
                "sourceKind": "ViewGeometry.materialRegion",
                "sourceEntityId": source["sourceEntityId"],
                "sourceRefs": entities[source["sourceEntityId"]]["sourceRefs"],
                "materialCode": material_code,
                "sourceMaterialHatch": source.get("materialHatch"),
                "targetHatchPatternKey": pattern_key,
                "targetHatchPatternId": pattern["patternId"],
                "layer": "GJ-HATCH",
                "viewOuterMm": source["outerMm"],
                "viewHolesMm": source["holesMm"],
                "modelSpaceOuterMm": [_apply(stage["viewToModelSpace"], point) for point in source["outerMm"]],
                "modelSpaceHolesMm": [[_apply(stage["viewToModelSpace"], point) for point in ring] for ring in source["holesMm"]],
                "xdata": {"applicationId": contract["provenancePolicy"]["xdataApplicationId"], "sourceEntityId": source["sourceEntityId"], "geometryRevisionId": contract["geometryRevisionId"], "viewContractRevisionId": contract["viewContractRevisionId"], "viewId": view_id, "derivation": "ViewGeometry.materialRegion", "derivationTransform": view["viewFrame"]["modelToView"]},
            }
        )
    return sorted(result, key=lambda item: item["cadObjectId"])


def _expected_annotations(contract: dict) -> list[dict]:
    result: list[dict] = []
    for view_id, categories in contract["annotationRequirements"]["views"].items():
        for category, requirements in categories.items():
            for requirement in requirements:
                requirement_id = requirement["requirementId"]
                result.append(
                    {
                        "cadObjectId": _cad_id(contract["contractRevisionId"], "annotation", view_id, requirement_id),
                        "cadObjectType": requirement["cadType"],
                        "objectClass": "annotation-requirement",
                        "viewId": view_id,
                        "category": category,
                        "requirementId": requirement_id,
                        "sourceRefs": requirement["sourceRefs"],
                        "semanticPayload": requirement,
                        "xdata": {"applicationId": contract["provenancePolicy"]["xdataApplicationId"], "requirementId": requirement_id, "sourceRefs": requirement["sourceRefs"]},
                    }
                )
    for requirement in contract["annotationRequirements"]["titleBlocks"]:
        requirement_id = requirement["requirementId"]
        result.append(
            {
                "cadObjectId": _cad_id(contract["contractRevisionId"], "system-title-block", requirement["layoutName"], requirement_id),
                "cadObjectType": requirement["cadType"],
                "objectClass": contract["provenancePolicy"]["systemObjectClass"],
                "layoutName": requirement["layoutName"],
                "category": "titleBlocks",
                "requirementId": requirement_id,
                "sourceRefs": requirement["sourceRefs"],
                "semanticPayload": requirement,
                "xdata": {"applicationId": contract["provenancePolicy"]["xdataApplicationId"], "requirementId": requirement_id, "sourceRefs": requirement["sourceRefs"]},
            }
        )
    return sorted(result, key=lambda item: (item.get("viewId", item.get("layoutName")), item["requirementId"]))


def derive_expected_ir_content(bundle: VerificationBundle) -> dict:
    contract, manifest, views = bundle.contract, bundle.manifest, bundle.views
    entities = {item["entityId"]: item for item in manifest["entities"]}
    stages = {item["viewId"]: item for item in contract["viewStages"]}
    bindings = {item["viewId"]: item for item in contract["viewGeometryBindings"]}
    expected_stages: list[dict] = []
    sidecar_rows: list[dict] = []
    structural_count = crop_count = material_count = 0
    for view_id in sorted(views):
        view = views[view_id]
        source_structural = [*view.get("cutLines", []), *view.get("projectionLines", [])]
        structural = [_expected_line(contract, stages[view_id], view_id, source, entities[source["sourceEntityId"]], True) for source in source_structural]
        crops = [_expected_line(contract, stages[view_id], view_id, source, entities[source["sourceEntityId"]], False) for source in view.get("cropLimitLines", [])]
        structural_by_line = {item["sourceLineId"]: item["cadObjectId"] for item in structural}
        _require(len(structural_by_line) == len(structural), f"{view_id} contains duplicate structural line IDs")
        materials = _expected_materials(contract, stages[view_id], view, structural_by_line, entities)
        structural = sorted(structural, key=lambda item: (item["sourceLineId"], item["cadObjectId"]))
        crops = sorted(crops, key=lambda item: (item["sourceLineId"], item["cadObjectId"]))
        expected_stages.append({**stages[view_id], "sourceViewGeometrySha256": bindings[view_id]["viewGeometrySha256"], "structuralLines": structural, "cropLimitLines": crops, "materialRegions": materials})
        for item in [*structural, *crops, *materials]:
            sidecar_rows.append({"cadObjectId": item["cadObjectId"], "objectClass": item["objectClass"], "provenance": item["xdata"]})
        structural_count += len(structural)
        crop_count += len(crops)
        material_count += len(materials)
    annotations = _expected_annotations(contract)
    sidecar_rows.extend({"cadObjectId": item["cadObjectId"], "objectClass": item["objectClass"], "provenance": item["xdata"]} for item in annotations)
    return {
        "stages": expected_stages,
        "annotations": annotations,
        "sidecar": sorted(sidecar_rows, key=lambda item: item["cadObjectId"]),
        "statistics": {"viewCount": 10, "layoutCount": 2, "structuralLineCount": structural_count, "cropLimitLineCount": crop_count, "materialRegionCount": material_count, "annotationRequirementCount": len(annotations), "provenanceSidecarRowCount": len(sidecar_rows)},
    }


def verify_ir_semantics(bundle: VerificationBundle) -> dict:
    contract, ir = bundle.contract, bundle.ir
    _require(set(ir) == EXPECTED_IR_KEYS, "IR root schema is incomplete or contains injected fields")
    _require(ir["schemaVersion"] == "t0b-v2-drawing-package-ir-1", "IR schemaVersion is invalid")
    _require(ir["status"] == "generated-not-qualified" and ir["L1"] is False and ir["useBoundary"] == ["demo-only", "not-for-formal-signoff"], "IR qualification was elevated")
    _require(ir["generatedAt"] == "2000-01-01T00:00:00Z" and ir["producerType"] == "demo", "IR provenance time or producer changed")
    _require(ir["drawingPackageContractSignature"] == contract["contractSignature"] and ir["drawingPackageContractRevisionId"] == contract["contractRevisionId"], "IR contract binding is invalid")
    _require(ir["geometryRevisionId"] == GEOMETRY_REVISION_ID and ir["viewContractRevisionId"] == VIEW_CONTRACT_REVISION_ID and ir["manifestSha256"] == contract["manifestBinding"]["sha256"], "IR source revision binding is invalid")
    _require(ir["modelSpace"].get("unit") == "mm" and ir["modelSpace"].get("insunits") == 4 and ir["modelSpace"].get("scale") == "1:1", "IR model space is not 1:1 mm")
    _require(ir["paperSpace"] == {"layouts": contract["layouts"]}, "IR layouts differ from the contract")
    for key, contract_key in (("detailGates", "detailGates"), ("layerPolicy", "layerPolicy"), ("nativeCadPolicy", "nativeCadPolicy"), ("materialPolicy", "materialPolicy"), ("fontPolicy", "fontPolicy"), ("provenancePolicy", "provenancePolicy"), ("futureOutputMatrix", "outputMatrix"), ("compatibilityMatrix", "compatibilityMatrix"), ("qualificationBoundary", "qualificationBoundary"), ("determinismPolicy", "determinismPolicy")):
        _require(ir[key] == contract[contract_key], f"IR {key} differs from the contract")
    expected = derive_expected_ir_content(bundle)
    _require(ir["modelSpace"].get("viewStages") == expected["stages"], "IR staged line, crop, or material records differ from independent derivation")
    _require(ir["annotations"] == expected["annotations"], "IR annotations differ from the 48 contract requirements")
    _require(ir["provenanceSidecarRows"] == expected["sidecar"], "IR provenance sidecar is not a 100% object closure")
    _require(ir["statistics"] == expected["statistics"], "IR statistics differ from independent counts")
    ids = [item["cadObjectId"] for item in expected["sidecar"]]
    _require(len(ids) == len(set(ids)), "IR cadObjectId values are not unique")
    _assert_external_isolation(ir, "DrawingPackageIR")
    return expected["statistics"]


def verify_material_and_crop_execution(bundle: VerificationBundle) -> dict:
    patterns = bundle.contract["materialPolicy"]["patterns"]
    material_map = bundle.contract["materialPolicy"]["materialCodePatternMap"]
    unresolved: list[str] = []
    source_null_count = 0
    ceramic_count = 0
    for stage in bundle.ir["modelSpace"]["viewStages"]:
        for region in stage["materialRegions"]:
            material_code = region.get("materialCode")
            target_key = material_map.get(material_code)
            if target_key is None or target_key not in patterns:
                unresolved.append(f"{stage['viewId']}:{region['sourceRegionId']}:{material_code}:unmapped")
                continue
            if region.get("targetHatchPatternKey") != target_key or region.get("targetHatchPatternId") != patterns[target_key].get("patternId"):
                unresolved.append(f"{stage['viewId']}:{region['sourceRegionId']}:{material_code}:target-mismatch")
            if region.get("sourceMaterialHatch") is None:
                source_null_count += 1
            if material_code in {"ceramic-demo", "ceramic"}:
                ceramic_count += 1
                _require(target_key == "ceramic" and patterns[target_key].get("source") == "team-owned-demo" and patterns[target_key].get("externalSourceDerived") is False, "ceramic material does not resolve to the team-owned demo pattern")
        for line in stage["cropLimitLines"]:
            _require(line.get("objectClass") == "nonstructural-crop-limit" and line.get("lineClass") == "cropLimit", f"{stage['viewId']} crop line is misclassified")
            _require(line.get("layer") in bundle.contract["layerPolicy"]["layers"], f"{stage['viewId']} crop line uses an undeclared layer")
    _require(not unresolved, f"{len(unresolved)} material regions do not resolve to a team-owned hatch pattern")
    return {"materialRegions": bundle.ir["statistics"]["materialRegionCount"], "resolvedTargetHatches": bundle.ir["statistics"]["materialRegionCount"], "unresolvedMaterialHatches": 0, "ceramicRegions": ceramic_count, "sourceMaterialHatchNullPreserved": source_null_count, "cropLimitLines": bundle.ir["statistics"]["cropLimitLineCount"]}


def verify_hashes_record_and_determinism(bundle: VerificationBundle) -> dict:
    contract, ir, record = bundle.contract, bundle.ir, bundle.record
    hash_payload = deepcopy(ir)
    stored_ir_hash = hash_payload.pop("drawingPackageIrSha256", None)
    actual_ir_hash = _canonical_hash(hash_payload)
    _require(stored_ir_hash == actual_ir_hash, "IR canonical content hash is invalid")
    _require(record.get("schemaVersion") == "t0b-v2-drawing-package-ir-build-1" and record.get("status") == "generated-not-qualified" and record.get("L1") is False, "build record state is invalid")
    _require(record.get("generatedAt") == "2000-01-01T00:00:00Z" and record.get("drawingPackageContractRevisionId") == contract["contractRevisionId"], "build record revision or time is invalid")
    record_contract = record.get("inputs", {}).get("contract", {})
    _require(record_contract == {"path": bundle.contract_path.name, "sha256": bundle.contract_file_sha256, "contractSignature": contract["contractSignature"]}, "build record contract hash is invalid")
    _require(record.get("inputs", {}).get("manifest") == contract["manifestBinding"], "build record manifest binding is invalid")
    output = record.get("output", {})
    _require(output.get("path") == bundle.ir_path.name and output.get("sha256") == bundle.ir_file_sha256 and output.get("drawingPackageIrSha256") == stored_ir_hash and output.get("statistics") == ir["statistics"], "build record output hash or statistics are invalid")
    _require(record.get("outputsNotGenerated") == ["DXF", "SVG", "PDF", "PNG"], "build record incorrectly claims drawing outputs")
    raw = _canonical_ir_bytes(ir)
    first = gzip.compress(raw, compresslevel=9, mtime=0)
    second = gzip.compress(raw, compresslevel=9, mtime=0)
    _require(first == second == bundle.ir_file_bytes, "independent double serialization does not reproduce the committed IR bytes")
    package_dir = bundle.ir_path.parent
    forbidden_outputs = [path.name for path in package_dir.iterdir() if path.suffix.lower() in {".dxf", ".svg", ".pdf", ".png"}]
    _require(not forbidden_outputs, "drawing artifacts exist in a contract-and-IR-only task")
    return {"drawingPackageIrSha256": stored_ir_hash, "gzipSha256": bundle.ir_file_sha256, "doubleBuildByteIdentical": True, "outputsNotGenerated": record["outputsNotGenerated"]}


CHECKS: list[tuple[str, str, Callable[[VerificationBundle], dict]]] = [
    ("DIR-001", "DrawingPackageContract schema, signature, revision and twelve P0 mappings", verify_contract),
    ("DIR-002", "Manifest and ten compressed/internal ViewGeometry bindings", verify_bound_inputs),
    ("DIR-003", "Independent line, material, crop, annotation and 51k provenance derivation", verify_ir_semantics),
    ("DIR-004", "Material hatch and crop execution closure", verify_material_and_crop_execution),
    ("DIR-005", "IR hash, build record, no-output boundary and double-build determinism", verify_hashes_record_and_determinism),
]


def verify_bundle(bundle: VerificationBundle) -> dict:
    evidence: dict[str, dict] = {}
    for check_id, _name, function in CHECKS:
        evidence[check_id] = function(bundle)
    return evidence


def build_report(bundle: VerificationBundle, verifier_path: Path) -> dict:
    checks: list[dict] = []
    for check_id, name, function in CHECKS:
        try:
            evidence = function(bundle)
            checks.append({"id": check_id, "name": name, "passed": True, "evidence": evidence})
        except Exception as error:  # report all independent gates
            checks.append({"id": check_id, "name": name, "passed": False, "error": str(error)})
    failed = [item for item in checks if not item["passed"]]
    unresolved = []
    policy = bundle.contract.get("materialPolicy", {})
    patterns = policy.get("patterns", {})
    material_map = policy.get("materialCodePatternMap", {})
    for stage in bundle.ir.get("modelSpace", {}).get("viewStages", []):
        for region in stage.get("materialRegions", []):
            material_code = region.get("materialCode")
            target_key = material_map.get(material_code)
            expected_pattern_id = patterns.get(target_key, {}).get("patternId") if target_key else None
            if target_key not in patterns or region.get("targetHatchPatternKey") != target_key or region.get("targetHatchPatternId") != expected_pattern_id:
                unresolved.append({"viewId": stage.get("viewId"), "sourceRegionId": region.get("sourceRegionId"), "materialCode": material_code, "sourceMaterialHatch": region.get("sourceMaterialHatch"), "targetHatchPatternKey": region.get("targetHatchPatternKey"), "targetHatchPatternId": region.get("targetHatchPatternId")})
    p0_findings = []
    if unresolved:
        counts: dict[str, int] = {}
        for item in unresolved:
            key = "unmapped" if item["targetHatchPatternKey"] is None else str(item["targetHatchPatternKey"])
            counts[key] = counts.get(key, 0) + 1
        p0_findings.append(
            {
                "id": "P0-MATERIAL-HATCH-CLOSURE",
                "summary": "Material regions cannot all be emitted as contract-owned native HATCH objects.",
                "evidence": {"unresolvedRegionCount": len(unresolved), "byTargetHatch": counts, "contractPatterns": sorted(patterns)},
                "requiredAction": "Freeze a team-owned ceramic hatch or explicitly classify ceramic regions as no-hatch boundaries; regenerate the contract revision and IR before DXF generation.",
            }
        )
    return {
        "schemaVersion": "t0b-v2-drawing-package-ir-verification-1",
        "status": "passed-contract-and-ir-only" if not failed else "failed-contract-and-ir-verification",
        "L1": False,
        "qualification": "not-drawing-output",
        "verifier": {"version": VERIFIER_VERSION, "path": verifier_path.name, "sha256": _file_hash(verifier_path), "independent": True, "forbiddenImports": ["drawing_contract", "drawing_ir", "view_geometry", "generator", "detail_oracle"]},
        "source": {"contract": {"path": bundle.contract_path.name, "sha256": bundle.contract_file_sha256, "contractRevisionId": bundle.contract.get("contractRevisionId")}, "ir": {"path": bundle.ir_path.name, "sha256": bundle.ir_file_sha256, "drawingPackageIrSha256": bundle.ir.get("drawingPackageIrSha256")}},
        "summary": {"checks": len(checks), "failed": len(failed), **bundle.ir.get("statistics", {})},
        "checks": checks,
        "findings": {"P0": p0_findings, "P1": [], "P2": []},
        "outputsNotGenerated": ["DXF", "SVG", "PDF", "PNG"],
        "submissionDecision": "reject-until-p0-closed" if p0_findings or failed else "accept-contract-and-ir-task-only",
        "qualificationBoundary": {"status": "generated-not-qualified", "L1": False, "useBoundary": ["demo-only", "not-for-formal-signoff"]},
    }


def default_paths(root: Path) -> tuple[Path, Path, Path, Path]:
    contract_path = next(root.rglob("t0b-v2-drawing-package-contract.json"))
    output_dir = contract_path.parent / "t0b-v2-outputs" / "drawing-package-ir"
    return contract_path, output_dir / "drawing-package.ir.json.gz", output_dir / "drawing-package-ir-build-record.json", output_dir / "drawing-package-ir-verification.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify DrawingPackageContract and DrawingPackageIR without importing generators.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--ir", type=Path)
    parser.add_argument("--record", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    defaults = default_paths(args.root.resolve())
    contract_path, ir_path, record_path, report_path = tuple(value if value is not None else defaults[index] for index, value in enumerate((args.contract, args.ir, args.record, args.report)))
    bundle = load_bundle(contract_path, ir_path, record_path)
    report = build_report(bundle, Path(__file__).resolve())
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
