from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
from uuid import UUID, uuid5


DRAWING_PACKAGE_REVISION_NAMESPACE = UUID("e145714a-5f3c-58d8-bcc7-b34965cc5f8b")
GEOMETRY_REVISION_ID = "3788f4e4-339c-568d-aa58-f74b36b23c5a"
VIEW_CONTRACT_REVISION_ID = "04d00093-0bec-5f2a-bc68-def2a292c932"
FONT_SOURCE_COMMIT = "038b637da7b3fd956a4ed93ffc607c3d5e4ce172"
FONT_SOURCE_SHA256 = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
FONT_INSTANCE_SHA256 = "4de4210cdf50d50bd27549cd56a5287c918378015de0773ca18f53022b75cef7"
FONT_MANIFEST_SHA256 = "7bdbbb65a02ba0f8f76bf67d392f9926045f0a375b8e78192d8ad45caee29751"
FONT_LICENSE_SHA256 = "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9"
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
P0_IDS = {f"DP-P0-{index:02d}" for index in range(1, 13)}
NATIVE_CAD_TYPES = {"DIMENSION", "TEXT", "MTEXT", "HATCH", "INSERT", "LAYOUT", "VIEWPORT"}
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
GENERATION_KEYS = {
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
FORBIDDEN_DEPENDENCY_TOKENS = {
    ".dwg",
    "xref",
    "image",
    "underlay",
    "proxy",
    "寺庙古建筑设计方案图",
    "一套完整的古建施工图",
}


class DrawingContractError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise DrawingContractError(message)


def _sha256(value: object, field: str) -> str:
    _require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None, f"{field} must be lowercase sha256")
    return value


def _uuid(value: object, field: str) -> str:
    try:
        parsed = str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise DrawingContractError(f"{field} must be UUID") from error
    _require(parsed == value, f"{field} must be canonical UUID")
    return parsed


def drawing_contract_signature(contract: dict) -> str:
    payload = {key: value for key, value in contract.items() if key not in {"contractSignature", "contractRevisionId"}}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def _relative_input_path(value: object, field: str) -> str:
    _require(isinstance(value, str) and value, f"{field} must be a relative path")
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    _require(not path.is_absolute() and ".." not in path.parts and not re.match(r"^[a-z]:", normalized, re.IGNORECASE), f"{field} must be a confined relative path")
    lowered = normalized.lower()
    _require(not any(token in lowered for token in FORBIDDEN_DEPENDENCY_TOKENS), f"{field} contains a forbidden external dependency")
    _require("/downloads/" not in lowered and not lowered.startswith("downloads/"), f"{field} cannot reference Downloads")
    return normalized


def _matrix(value: object, field: str) -> list[list[float]]:
    _require(
        isinstance(value, list)
        and len(value) == 3
        and all(isinstance(row, list) and len(row) == 3 and all(isinstance(item, (int, float)) for item in row) for row in value),
        f"{field} must be a 3x3 numeric matrix",
    )
    return value


def _apply(matrix: list[list[float]], point: list[float]) -> list[float]:
    return [
        matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2],
        matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2],
    ]


def _rectangles_overlap(first: list[float], second: list[float]) -> bool:
    return not (first[2] <= second[0] or second[2] <= first[0] or first[3] <= second[1] or second[3] <= first[1])


def _requirement_records(value: object, field: str) -> list[dict]:
    _require(isinstance(value, list), f"{field} must be a list")
    for index, record in enumerate(value):
        _require(isinstance(record, dict), f"{field}[{index}] must be an object")
        _require(isinstance(record.get("requirementId"), str) and record["requirementId"], f"{field}[{index}] requirementId is required")
        refs = record.get("sourceRefs")
        _require(isinstance(refs, list) and refs and all(isinstance(item, str) and item for item in refs), f"{field}[{index}] sourceRefs are required")
        _require(
            all(re.fullmatch(r"(?:drawing-contract|manifest|view-contract|view-geometry):[A-Za-z0-9._-]+", item) for item in refs),
            f"{field}[{index}] sourceRefs must use an allowed internal reference scheme",
        )
        _require(record.get("overrideAllowed") is False, f"{field}[{index}] must forbid value overrides")
    return value


def _reject_external_annotation_values(value: object, field: str) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            _reject_external_annotation_values(item, f"{field}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _reject_external_annotation_values(item, f"{field}[{index}]")
        return
    if not isinstance(value, str):
        return
    lowered = value.lower().replace("\\", "/")
    _require(not any(token in lowered for token in FORBIDDEN_DEPENDENCY_TOKENS), f"{field} contains a forbidden external dependency")
    _require("downloads" not in lowered and re.fullmatch(r"[0-9a-f]{64}", lowered) is None, f"{field} contains a forbidden external path or hash")
    _require(not value.startswith(("/", "\\")) and re.match(r"^[a-z]:[/\\]", value, re.IGNORECASE) is None, f"{field} contains an absolute path")


def validate_drawing_package_contract(contract: dict) -> dict:
    _require(isinstance(contract, dict) and set(contract) == GENERATION_KEYS, "drawing package contract root fields are incomplete or unexpected")
    _require(contract["schemaVersion"] == "t0b-v2-drawing-package-contract-1", "unsupported drawing package contract schema")
    _uuid(contract["contractId"], "contractId")
    _require(contract["producerType"] == "demo", "drawing package must retain demo provenance")
    _require(contract["geometryRevisionId"] == GEOMETRY_REVISION_ID, "drawing package binds the wrong geometry revision")
    _require(contract["viewContractRevisionId"] == VIEW_CONTRACT_REVISION_ID, "drawing package binds the wrong view contract revision")
    _sha256(contract["contractSignature"], "contractSignature")
    actual_signature = drawing_contract_signature(contract)
    _require(contract["contractSignature"] == actual_signature, "drawing package contract signature is invalid")
    _require(contract["contractRevisionId"] == str(uuid5(DRAWING_PACKAGE_REVISION_NAMESPACE, actual_signature)), "drawing package revision must derive from its signature")

    manifest = contract["manifestBinding"]
    _require(set(manifest) == {"relativePath", "sha256", "geometryRevisionId", "producerType", "allowedSourceScheme"}, "manifest binding is incomplete")
    _require(_relative_input_path(manifest["relativePath"], "manifestBinding.relativePath") == "t0b-v2-outputs/geometry-manifest.json", "manifest path is not frozen")
    _sha256(manifest["sha256"], "manifestBinding.sha256")
    _require(manifest["geometryRevisionId"] == GEOMETRY_REVISION_ID and manifest["producerType"] == "demo" and manifest["allowedSourceScheme"] == "demo", "manifest identity policy is invalid")

    bindings = contract["viewGeometryBindings"]
    _require(isinstance(bindings, list) and {item.get("viewId") for item in bindings} == VIEW_IDS and len(bindings) == 10, "exactly ten ViewGeometry bindings are required")
    for binding in bindings:
        _require(set(binding) == {"viewId", "relativePath", "fileSha256", "viewGeometrySha256", "geometryRevisionId", "viewContractRevisionId"}, f"{binding.get('viewId')} binding fields are invalid")
        path = _relative_input_path(binding["relativePath"], f"{binding['viewId']}.relativePath")
        _require(path.startswith("t0b-v2-outputs/") and path.endswith(".view-geometry.json.gz"), f"{binding['viewId']} path must bind committed ViewGeometry")
        _sha256(binding["fileSha256"], f"{binding['viewId']}.fileSha256")
        _sha256(binding["viewGeometrySha256"], f"{binding['viewId']}.viewGeometrySha256")
        _require(binding["geometryRevisionId"] == GEOMETRY_REVISION_ID and binding["viewContractRevisionId"] == VIEW_CONTRACT_REVISION_ID, f"{binding['viewId']} revision binding is invalid")

    identity = contract["packageIdentity"]
    _require(identity == {"packageId": "T0B-DEMO-DRAWING-PACKAGE", "title": "T0-B 古建局部专业样板", "unit": "mm", "language": "zh-CN", "sheetCount": 2, "viewCount": 10}, "package identity is not frozen")

    dependencies = contract["dependencies"]
    _require(dependencies.get("allowedInputKinds") == ["DrawingPackageContract", "geometryManifest", "ViewGeometry", "teamFont"], "generation input whitelist is invalid")
    _require(dependencies.get("fixtureReadableByIrBuilder") is False and dependencies.get("geometryRecalculationAllowed") is False and dependencies.get("structuralLineSupplementAllowed") is False, "IR builder boundary is invalid")
    _require(set(dependencies.get("forbiddenKinds", [])) == {"DWG", "xref", "image", "underlay", "proxy", "absolutePath", "externalHash", "externalLayer", "externalBlock", "externalDimension", "externalTitleBlock", "externalText", "externalPattern"}, "external dependency deny-list is incomplete")
    _require(dependencies.get("externalReferenceIsolation") is True and dependencies.get("deliveryMustRemainValidAfterExternalRemoval") is True, "external reference isolation is not mandatory")

    model = contract["modelSpacePolicy"]
    _require(model == {"unit": "mm", "insunits": 4, "scale": "1:1", "paperGeometryAllowed": False, "viewGeometryOperation": "translation-only-staging", "inverseLineMatchToleranceMm": 0.001, "sourceOfStructuralGeometry": "bound-ViewGeometry-only"}, "model-space policy is invalid")

    layouts = contract["layouts"]
    _require(isinstance(layouts, list) and [item.get("layoutName") for item in layouts] == ["T0B-01", "T0B-02"], "exactly two ordered layouts are required")
    expected_layout_views = {
        "T0B-01": ["floorPlan", "roofPlan", "southElevation", "transverseSection", "axonometric"],
        "T0B-02": ["longitudinalSection", "eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"],
    }
    for layout in layouts:
        _require(layout.get("pageSize") == "A1" and layout.get("orientation") == "landscape" and layout.get("pageMm") == [841, 594], f"{layout.get('layoutName')} must be A1 landscape")
        _require(layout.get("viewIds") == expected_layout_views[layout["layoutName"]] and len(layout.get("viewports", [])) == 5, f"{layout['layoutName']} must freeze five viewports")
        _require(layout.get("frameSpace") == "paperSpace" and layout.get("titleBlockSpace") == "paperSpace", f"{layout['layoutName']} frame and title block must be paper-space only")
        viewport_ids = [item.get("viewId") for item in layout["viewports"]]
        _require(viewport_ids == layout["viewIds"], f"{layout['layoutName']} viewport order must match view order")
        for viewport in layout["viewports"]:
            _require(viewport.get("locked") is True and viewport.get("cadType") == "VIEWPORT", f"{viewport.get('viewId')} viewport must be native and locked")
            _require(isinstance(viewport.get("paperRectMm"), list) and len(viewport["paperRectMm"]) == 4, f"{viewport.get('viewId')} paper rectangle is invalid")

    stages = contract["viewStages"]
    _require(isinstance(stages, list) and {item.get("viewId") for item in stages} == VIEW_IDS and len(stages) == 10, "ten staging transforms are required")
    for stage in stages:
        source_rect = stage.get("sourceClipRectMm")
        staged_rect = stage.get("stagedBoundsMm")
        _require(isinstance(source_rect, list) and len(source_rect) == 4 and isinstance(staged_rect, list) and len(staged_rect) == 4, f"{stage.get('viewId')} staging bounds are invalid")
        transform = _matrix(stage.get("viewToModelSpace"), f"{stage.get('viewId')}.viewToModelSpace")
        inverse = _matrix(stage.get("modelSpaceToView"), f"{stage.get('viewId')}.modelSpaceToView")
        _require(transform[0][:2] == [1, 0] and transform[1][:2] == [0, 1] and inverse[0][:2] == [1, 0] and inverse[1][:2] == [0, 1], f"{stage.get('viewId')} staging may translate only")
        for point in ([source_rect[0], source_rect[1]], [source_rect[2], source_rect[3]]):
            staged = _apply(transform, point)
            restored = _apply(inverse, staged)
            _require(max(abs(restored[index] - point[index]) for index in range(2)) <= 1e-9, f"{stage.get('viewId')} inverse staging transform is invalid")
        _require(_apply(transform, source_rect[:2]) == staged_rect[:2] and _apply(transform, source_rect[2:]) == staged_rect[2:], f"{stage.get('viewId')} staged bounds do not match the transform")
    for index, first in enumerate(stages):
        for second in stages[index + 1 :]:
            _require(not _rectangles_overlap(first["stagedBoundsMm"], second["stagedBoundsMm"]), f"{first['viewId']} and {second['viewId']} staging bounds overlap")

    layer_policy = contract["layerPolicy"]
    _require(set(layer_policy.get("layers", {})) == REQUIRED_LAYERS, "professional layer matrix is incomplete")
    _require(layer_policy.get("baseClassLayerMap") == {"cut": "GJ-CUT", "silhouette": "GJ-OUTLINE", "feature": "GJ-PROJECTION", "componentBoundary": "GJ-PROJECTION", "axis": "GJ-AXIS", "dimension": "GJ-DIMENSION", "annotation": "GJ-TEXT", "hatch": "GJ-HATCH", "frame": "GJ-FRAME"}, "base line class mapping is invalid")
    _require(layer_policy.get("visibilityLayerOverride") == {"visible": None, "hidden": "GJ-HIDDEN"}, "visibility override is invalid")
    _require(layer_policy.get("hiddenOverrideOnly") is True and layer_policy.get("featureMustRemainProjection") is True, "hidden and feature layer rules are ambiguous")
    _require(layer_policy.get("minimumPrintDpi") == 300 and layer_policy.get("minimumTextHeightMm") >= 2.5, "300 dpi readability is not frozen")

    native = contract["nativeCadPolicy"]
    _require(set(native.get("requiredTypes", [])) == NATIVE_CAD_TYPES, "native CAD object matrix is incomplete")
    _require(set(native.get("annotationClosure", [])) == {"axisGrid", "dimensionChain", "level", "sectionMark", "detailIndex", "viewTitleScale", "titleBlock"}, "annotation closure is incomplete")
    _require(native.get("dimensionValuePolicy") == {"source": "fixture-or-manifest-derived", "externalValuesAllowed": False, "textOverrideAllowed": False}, "dimension derivation policy is invalid")

    provenance = contract["provenancePolicy"]
    _require(provenance.get("structuralCoverage") == 1.0 and provenance.get("annotationCoverage") == 1.0, "provenance coverage must be 100%")
    _require(provenance.get("xdataApplicationId") == "GUJIAN_TRACE_V1", "XDATA application id is not frozen")
    _require(provenance.get("structuralXdataFields") == ["sourceEntityId", "geometryRevisionId", "viewContractRevisionId", "viewId", "derivation", "derivationTransform"], "structural XDATA is incomplete")
    _require(provenance.get("annotationXdataFields") == ["requirementId", "sourceRefs"], "annotation XDATA is incomplete")
    _require(provenance.get("systemObjectClass") == "system-paper-only" and provenance.get("sidecarFormat") == "ndjson" and provenance.get("sidecarKey") == "handle-or-cadObjectId", "sidecar provenance is incomplete")
    _require(provenance.get("roundtripLossIsFailure") == ["XDATA", "nativeType", "layout", "viewport"], "second-CAD provenance loss policy is incomplete")

    annotations = contract["annotationRequirements"]
    _reject_external_annotation_values(annotations, "annotationRequirements")
    _require(set(annotations.get("views", {})) == VIEW_IDS, "annotation requirements must cover ten views")
    for view_id, categories in annotations["views"].items():
        _require(set(categories) == {"axes", "dimensions", "levels", "sectionMarks", "detailIndices", "viewTitles", "notes", "componentCallouts", "breakMarks"}, f"{view_id} annotation categories are incomplete")
        for category, records in categories.items():
            _requirement_records(records, f"annotationRequirements.views.{view_id}.{category}")
            if category in {"dimensions", "levels"}:
                for record in records:
                    values = record.get("valuesMm")
                    _require(isinstance(values, (list, dict)) and bool(values), f"{view_id}.{category} must freeze source-derived values")
    _requirement_records(annotations.get("titleBlocks"), "annotationRequirements.titleBlocks")

    detail_gates = contract["detailGates"]
    _require(set(detail_gates) == DETAIL_VIEW_IDS, "four detail visual gates are required")
    _require(detail_gates["eaveDetail"].get("isolatedUpperPurlinCalloutRequired") is True and detail_gates["eaveDetail"].get("breakAtEveryCropTermination") is True, "eave detail visual gate is incomplete")
    bracket = detail_gates["bracketDetail"]
    _require(bracket.get("breakAtBeamAndComponentCrop") is True and bracket.get("mandatoryNote") == "团队演示承托构造，非实测/非正式节点" and bracket.get("l1BlockerCode") == "BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", "bracket detail visual gate is incomplete")
    column = detail_gates["columnBaseDetail"]
    _require(column.get("requiredHatches") == ["timber", "stone", "earth"] and column.get("requiredLevelsMm") == [-800, 0, 600] and column.get("requiredDimensionsMm") == [560, 400, 240, 800], "column-base detail gate is incomplete")
    door = detail_gates["doorWindowDetail"]
    _require(door.get("requiredDimensionsMm") == [1800, 2700, 720, 1500] and door.get("requiredCallouts") == ["frame", "leaf", "lattice"], "door/window detail gate is incomplete")

    material = contract["materialPolicy"]
    _reject_external_annotation_values(material, "materialPolicy")
    patterns = material.get("patterns", {})
    _require(set(patterns) == {"stone", "timber", "earth", "ceramic"}, "material hatch pattern set is incomplete")
    _require(patterns.get("stone") == {"patternId": "GJ_STONE_V1", "definition": "team-lines-45-135"}, "stone hatch definition is invalid")
    _require(patterns.get("timber") == {"patternId": "GJ_TIMBER_V1", "definition": "team-lines-0"}, "timber hatch definition is invalid")
    _require(patterns.get("earth") == {"patternId": "GJ_EARTH_V1", "definition": "team-dots-and-lines"}, "earth hatch definition is invalid")
    _require(
        patterns.get("ceramic")
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
    _require(
        material.get("materialCodePatternMap")
        == {
            "stone-demo": "stone",
            "stone": "stone",
            "timber-demo": "timber",
            "timber": "timber",
            "earth-demo": "earth",
            "earth": "earth",
            "ceramic-demo": "ceramic",
            "ceramic": "ceramic",
        },
        "material-code hatch resolution map is invalid",
    )
    _require(material.get("patternOwnership") == "team-owned" and material.get("boundarySourceKinds") == ["ViewGeometry.cutRegion", "ViewGeometry.materialRegion"] and material.get("boundaryRecalculationRequired") is True and material.get("externalPatternAllowed") is False, "material hatch contract is incomplete")

    font = contract["fontPolicy"]
    _require(
        font.get("redistributionLicenseRequired") is True
        and set(font.get("requiredManifestFields", []))
        == {
            "fontId",
            "family",
            "fullName",
            "postScriptName",
            "fileName",
            "sha256",
            "fsType",
            "redistributionAllowed",
            "pdfEmbeddingAllowed",
            "licenseSpdx",
            "licenseFileSha256",
            "namingCompliance",
            "derivedFrom",
            "source",
            "instance",
            "glyphCoverage",
            "build",
            "manifestPayloadSha256",
        },
        "font manifest contract is incomplete",
    )
    _require(set(font.get("forbiddenFamilies", [])) == {"SimHei", "LiSu", "NEW-ROMD"}, "known non-qualifying fonts must be forbidden")
    _require(font.get("currentBindingStatus") == "bound-licensed-static-instance" and font.get("blockerCode") is None, "licensed static font binding is invalid")
    bound_fonts = font.get("boundFonts")
    _require(isinstance(bound_fonts, list) and len(bound_fonts) == 1, "exactly one drawing font must be bound")
    bound = bound_fonts[0]
    _require(
        set(bound)
        == {
            "fontId",
            "family",
            "postScriptName",
            "cadStyleName",
            "relativeFontPath",
            "sha256",
            "relativeManifestPath",
            "manifestSha256",
            "sourceFontSha256",
            "sourceCommit",
            "instanceWeight",
            "licenseSpdx",
            "licenseFileSha256",
            "fsType",
            "redistributionAllowed",
            "pdfEmbeddingAllowed",
            "glyphCoverage",
            "namingCompliance",
        },
        "bound font fields are incomplete",
    )
    _require(bound["fontId"] == "gujian-sans-sc-regular-400-v1" and bound["family"] == "Gujian Sans SC" and bound["postScriptName"] == "GujianSansSC-Regular" and bound["cadStyleName"] == "GJ-GUJIAN-SANS-SC", "bound font identity differs")
    _require(_relative_input_path(bound["relativeFontPath"], "fontPolicy.boundFonts.relativeFontPath") == "workers/cad/t0b_v2/assets/fonts/noto-sans-sc/GujianSansSC-Regular.ttf", "bound font path differs")
    _require(_relative_input_path(bound["relativeManifestPath"], "fontPolicy.boundFonts.relativeManifestPath") == "workers/cad/t0b_v2/assets/fonts/noto-sans-sc/font-manifest.json", "font manifest path differs")
    _require(bound["sha256"] == FONT_INSTANCE_SHA256 and bound["manifestSha256"] == FONT_MANIFEST_SHA256 and bound["sourceFontSha256"] == FONT_SOURCE_SHA256, "font asset hashes differ")
    _require(bound["sourceCommit"] == FONT_SOURCE_COMMIT and bound["instanceWeight"] == 400, "font source commit or instance weight differs")
    _require(bound["licenseSpdx"] == "OFL-1.1" and bound["licenseFileSha256"] == FONT_LICENSE_SHA256 and bound["fsType"] == 0, "font license or embedding permission differs")
    _require(bound["redistributionAllowed"] is True and bound["pdfEmbeddingAllowed"] is True, "font redistribution or PDF embedding is not allowed")
    _require(bound["glyphCoverage"] == {"requiredCodepointCount": 168, "coveredCodepointCount": 168, "missingCodepoints": []}, "font glyph coverage differs")
    _require(bound["namingCompliance"] == {"isModifiedVersion": True, "reservedFontNames": ["Source"], "derivedFamilyRenamed": True, "reservedNamesUsedByDerivedFamily": []}, "font reserved-name compliance differs")
    _require(font.get("pdfEmbeddingRequired") is True and font.get("missingGlyphs") == 0 and font.get("fontSubstitutions") == 0 and font.get("questionMarkPlaceholders") == 0, "font output gate is incomplete")

    outputs = contract["outputMatrix"]
    _require(outputs.get("dxf") == {"files": ["T0B.dxf"], "modelSpaceUnit": "mm", "insunits": 4, "modelSpaceScale": "1:1", "layouts": ["T0B-01", "T0B-02"], "sourceIrRequired": True}, "DXF output contract is invalid")
    _require(outputs.get("svg") == {"files": ["T0B-01.svg", "T0B-02.svg"], "pageMm": [841, 594], "vectorRequired": True, "searchableText": True, "sourceIrRequired": True}, "SVG output contract is invalid")
    _require(outputs.get("pdf") == {"files": ["T0B.pdf"], "pages": 2, "pageMm": [841, 594], "vectorRequired": True, "searchableText": True, "embeddedFonts": True, "sourceIrRequired": True}, "PDF output contract is invalid")
    _require(outputs.get("reviewPng") == {"files": ["T0B-01-300dpi.png", "T0B-02-300dpi.png"], "dpi": 300, "pixelSize": [9933, 7016], "sourceIrRequired": True}, "review PNG output contract is invalid")
    _require(outputs.get("crossFormatIrConsistencyRequired") is True and outputs.get("reverseParseObjectTextPageFrameMatchRequired") is True, "cross-format IR consistency is not mandatory")

    compatibility = contract["compatibilityMatrix"]
    _require(set(compatibility) == {"AutoCAD", "QCAD"}, "only AutoCAD and QCAD belong in the compatibility matrix")
    _require(compatibility["AutoCAD"].get("auditErrors") == 0, "AutoCAD audit must allow zero errors")
    _require(
        compatibility["QCAD"].get("operations") == ["open", "select", "edit", "save", "print", "reverseParse"]
        and compatibility["QCAD"].get("roundtripCopyIsCanonical") is False
        and compatibility["QCAD"].get("supportStatus") == "unsupported-lossless-roundtrip"
        and compatibility["QCAD"].get("qualificationBlocker") == "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED"
        and compatibility["QCAD"].get("knownLosses") == ["DIMENSION_ASSOCIATION", "VIEWPORT_LOCK_FLAG"],
        "QCAD unsupported lossless-roundtrip boundary is invalid",
    )

    qualification = contract["qualificationBoundary"]
    _require(qualification.get("status") == "generated-not-qualified" and qualification.get("L1") is False and qualification.get("useBoundary") == ["demo-only", "not-for-formal-signoff"], "qualification boundary is invalid")
    _require(qualification.get("generatorMaySetEligible") is False and qualification.get("independentVerificationRequired") is True and qualification.get("professionalGroupedReviewRequired") is True, "generator must not grant qualification")
    _require(
        set(qualification.get("requiredBlockers", []))
        >= {
            "BRACKET_DETAIL_SIMPLIFIED_GEOMETRY",
            "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED",
            "AUTOCAD_REAUDIT_REQUIRED",
            "CROSS_FORMAT_INDEPENDENT_VERIFICATION_PENDING",
            "PROFESSIONAL_REVIEW_PENDING",
        }
        and "FONT_ASSET_NOT_BOUND" not in qualification.get("requiredBlockers", [])
        and "DRAWING_OUTPUTS_NOT_BUILT" not in qualification.get("requiredBlockers", []),
        "known qualification blockers are incomplete",
    )

    determinism = contract["determinismPolicy"]
    _require(determinism == {"fixedTimestamp": "2000-01-01T00:00:00Z", "gzipMtime": 0, "stableOrdering": ["layoutName", "viewId", "sourceLineId", "requirementId", "cadObjectId"], "volatileMetadataAllowed": False, "temporaryDirectoryDoubleBuildRequired": True, "fullArtifactHashMustMatch": True, "contractChangeRequiresNewSignatureAndRevision": True}, "determinism policy is invalid")

    p0 = contract["p0Requirements"]
    _require(isinstance(p0, list) and {item.get("id") for item in p0} == P0_IDS and len(p0) == 12, "all twelve P0 requirements must be mapped")
    _require(all(isinstance(item.get("contractFields"), list) and item["contractFields"] for item in p0), "every P0 must map to contract fields")
    return contract


def prepare_drawing_generation_input(contract: dict) -> dict:
    validate_drawing_package_contract(contract)
    result = deepcopy(contract)
    _require(set(result) == GENERATION_KEYS, "sanitized drawing input root changed unexpectedly")
    return result


def load_drawing_package_contract(path: Path) -> dict:
    return validate_drawing_package_contract(json.loads(path.read_text(encoding="utf-8")))
