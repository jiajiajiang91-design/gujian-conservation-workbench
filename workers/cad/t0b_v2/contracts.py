from __future__ import annotations

from collections import deque
from copy import deepcopy
from hashlib import sha256
import json
import math
from pathlib import Path
from uuid import UUID, uuid5


class ContractError(ValueError):
    pass


GEOMETRY_REVISION_NAMESPACE = UUID("1f321b7d-38a4-5b48-8a82-353bc6298225")
VIEW_CONTRACT_REVISION_NAMESPACE = UUID("7f53de29-8c75-5f46-a7bf-75c69cc967a0")


REQUIRED_COMPONENT_TYPES = {
    "foundation",
    "groundLayer",
    "terrace",
    "step",
    "columnBase",
    "column",
    "eaveBeam",
    "tieBeam",
    "interiorPost",
    "bracketSeat",
    "bracketArm",
    "bearingBlock",
    "purlin",
    "rafter",
    "flyRafter",
    "roofBoard",
    "panTile",
    "coverTile",
    "ridgeTile",
    "wall",
    "doorFrame",
    "doorLeaf",
    "latticeWindow",
}

REQUIRED_VIEWS = {
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

REQUIRED_DIMENSION_CATEGORIES = {
    "overall",
    "axis",
    "bayOrDepth",
    "componentLocation",
    "componentSize",
}

REQUIRED_LEVEL_CATEGORIES = {
    "exteriorGround",
    "terraceTop",
    "columnTop",
    "eave",
    "ridge",
    "foundationBottom",
}

FORBIDDEN_PASS_METRICS = {"objectCount", "primitiveCount", "fileSize"}
REQUIRED_GEOMETRY_FEATURES = {
    "oppositeTileCurvature",
    "nonRectangularRidgeSection",
    "profiledBracketSupport",
    "countableDoorWindowDivision",
    "pairedRoofCurveWithRidgeBreak",
    "watertightResolvedInstances",
}
REQUIRED_NATIVE_CAD_ENTITIES = {"DIMENSION", "TEXT", "MTEXT", "HATCH", "INSERT", "LAYOUT", "VIEWPORT"}
REQUIRED_CAD_LAYERS = {
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


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def _require_uuid(value: object, field: str) -> None:
    try:
        UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ContractError(f"{field} must be a UUID") from exc


def _vector(value: object, field: str) -> list[float]:
    _require(isinstance(value, list) and len(value) == 3, f"{field} must be a 3D vector")
    _require(all(isinstance(item, (int, float)) and math.isfinite(float(item)) for item in value), f"{field} must be finite")
    return [float(item) for item in value]


def _dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _cross(left: list[float], right: list[float]) -> list[float]:
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]


def _close(left: float, right: float, tolerance: float = 1e-8) -> bool:
    return abs(left - right) <= tolerance


def _require_sha256(value: object, field: str) -> None:
    _require(isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value), f"{field} must be a lowercase sha256 value")


def _require_unit_parallel(normal: list[float], retained: list[float], field: str) -> None:
    _require(_close(_dot(normal, normal), 1.0, 2e-8), f"{field} normal must be a unit vector")
    _require(_close(_dot(retained, retained), 1.0, 2e-8), f"{field} retained direction must be a unit vector")
    _require(all(_close(value, 0.0, 2e-8) for value in _cross(normal, retained)), f"{field} normal and retained direction must be parallel")


def _view_contract_signature(fixture: dict) -> str:
    payload = {
        "geometryRevisionId": fixture.get("geometryRevisionId"),
        "views": fixture.get("views"),
        "drawingSheets": fixture.get("drawingSheets"),
        "drawingRequirements": fixture.get("drawingRequirements"),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def prepare_view_generation_input(fixture: dict) -> dict:
    """Return the only data surface allowed to a future view generator."""
    validate_fixture(fixture)
    return deepcopy(
        {
            "geometryRevisionId": fixture["geometryRevisionId"],
            "viewContractRevisionId": fixture["viewContractRevisionId"],
            "views": fixture["views"],
            "drawingSheets": fixture["drawingSheets"],
            "drawingRequirements": fixture["drawingRequirements"],
        }
    )


def _has_support_path(connections: list[dict], start: str, target: str) -> bool:
    graph: dict[str, set[str]] = {}
    for item in connections:
        if item["relation"] == "supportedBy":
            graph.setdefault(item["fromType"], set()).add(item["toType"])
    queue = deque([start])
    visited: set[str] = set()
    while queue:
        current = queue.popleft()
        if current == target:
            return True
        if current in visited:
            continue
        visited.add(current)
        queue.extend(graph.get(current, set()))
    return False


def validate_fixture(fixture: dict) -> dict:
    required_root = {
        "schemaVersion",
        "projectId",
        "fixtureId",
        "geometryRevisionId",
        "producerType",
        "unit",
        "sourceRefs",
        "referenceIsolation",
        "scope",
        "coordinateSystem",
        "materials",
        "geometryValidation",
        "supportValidation",
        "assembly",
        "componentTemplates",
        "requiredResolvedTypes",
        "connections",
        "views",
        "drawingRequirements",
        "drawingSheets",
        "conditionRecord",
        "knownAnswers",
        "acceptance",
    }
    missing = sorted(required_root - fixture.keys())
    _require(not missing, f"missing root fields: {', '.join(missing)}")
    _require(fixture["schemaVersion"] == "t0b-v2-fixture-1", "unsupported schemaVersion")
    for field in ("projectId", "fixtureId", "geometryRevisionId"):
        _require_uuid(fixture[field], field)
    _require(fixture["producerType"] == "demo", "fixture must retain demo provenance")
    _require(fixture["unit"] == "mm", "fixture unit must be mm")
    _require(fixture["scope"] == "resolved-local-assembly", "fixture scope must be local and resolved")
    _require(bool(fixture["sourceRefs"]), "sourceRefs must not be empty")
    _require(all(str(item).startswith("demo:") for item in fixture["sourceRefs"]), "fixture sources must use the demo scheme")
    isolation = fixture["referenceIsolation"]
    _require(isolation == {"fixtureOnly": True, "allowedSourceSchemes": ["demo"], "externalAssetsAllowed": False}, "external references must be isolated from generation")
    _require(fixture["coordinateSystem"] == {"x": "east", "y": "north", "z": "up"}, "coordinate system must be fixed")

    geometry_validation = fixture["geometryValidation"]
    for field in ("curveToleranceMm", "maxChordErrorMm", "boundsToleranceMm", "dimensionToleranceMm"):
        _require(isinstance(geometry_validation.get(field), (int, float)) and geometry_validation[field] > 0, f"{field} must be positive")
    _require(set(geometry_validation.get("requiredFeatureAssertions", [])) == REQUIRED_GEOMETRY_FEATURES, "geometry feature assertions are incomplete")
    roof_coverage = geometry_validation.get("roofCoverage", {})
    for field in ("sampleSpacingX", "sampleSpacingY", "edgeMarginX", "edgeMarginY", "rayClearanceMm", "rayDepthMm"):
        _require(isinstance(roof_coverage.get(field), (int, float)) and roof_coverage[field] > 0, f"roofCoverage.{field} must be positive")
    _require(roof_coverage.get("maximumUncoveredSamples") == 0, "roof coverage must allow no exposed structure samples")
    tile_lap = geometry_validation.get("tileLap", {})
    _require(isinstance(tile_lap.get("interfaceToleranceMm"), (int, float)) and 0 < tile_lap["interfaceToleranceMm"] <= 1, "tile lap interface tolerance must be at most 1 mm")
    _require(isinstance(tile_lap.get("minimumVisibleStepMm"), (int, float)) and tile_lap["minimumVisibleStepMm"] > 0, "tile lap must retain a visible step")
    _require(isinstance(tile_lap.get("samplesPerOverlap"), int) and tile_lap["samplesPerOverlap"] >= 3, "tile lap must be sampled at least three times")

    support_validation = fixture["supportValidation"]
    _require(isinstance(support_validation.get("surfaceGapToleranceMm"), (int, float)) and 0 < support_validation["surfaceGapToleranceMm"] <= 2, "surface gap tolerance must be at most 2 mm")
    _require(isinstance(support_validation.get("directionToleranceMm"), (int, float)) and support_validation["directionToleranceMm"] >= 0, "support direction tolerance must be non-negative")
    _require(isinstance(support_validation.get("jointAllowancesMm"), dict), "support joint allowances are required")
    _require(isinstance(support_validation.get("maximumLateralOffsetMm"), (int, float)) and 0 < support_validation["maximumLateralOffsetMm"] <= 2, "maximum lateral offset must be at most 2 mm")
    _require(isinstance(support_validation.get("minimumGrooveContactVertices"), int) and support_validation["minimumGrooveContactVertices"] >= 4, "groove contact vertex threshold is too low")
    _require(isinstance(support_validation.get("minimumBearingAreaMm2"), (int, float)) and support_validation["minimumBearingAreaMm2"] > 0, "minimum bearing area must be positive")

    curve = fixture["assembly"].get("roofCurve", {})
    _require(curve.get("family") == "pairedCubicC0", "roof curve must use the frozen paired-slope family")
    _require(curve.get("halfSpan") == 3600 and curve.get("ridgeHeight") == fixture["assembly"]["levels"]["ridge"], "roof curve span and ridge must match the assembly")
    _require(len(curve.get("dropCoefficients", [])) == 3, "roof curve coefficients are incomplete")
    _require(isinstance(curve.get("ridgeOneSidedSlope"), (int, float)) and curve["ridgeOneSidedSlope"] > 0, "roof ridge must retain a non-zero one-sided slope")
    _require(abs(float(curve.get("ridgeSlopeJump", 0)) - 2 * float(curve["ridgeOneSidedSlope"])) <= 1e-9, "ridge slope jump must match the paired one-sided slopes")
    _require(isinstance(curve.get("sampleStepMm"), (int, float)) and 0 < curve["sampleStepMm"] <= 40, "roof curve sampling must be 40 mm or finer")
    _require(isinstance(curve.get("edgeTangentLimit"), (int, float)) and 0 < curve["edgeTangentLimit"] <= 0.3, "roof edge tangent limit is invalid")

    templates = fixture["componentTemplates"]
    materials = fixture["materials"]
    _require(bool(materials), "materials must not be empty")
    template_types = set(templates)
    required_types = set(fixture["requiredResolvedTypes"])
    _require(required_types == REQUIRED_COMPONENT_TYPES, "requiredResolvedTypes must match the frozen L1 component set")
    _require(required_types <= template_types, "all required component templates must exist")
    for component_type in sorted(required_types):
        template = templates[component_type]
        _require(template.get("geometryStatus") == "resolved", f"{component_type} must be resolved")
        _require(template.get("representation") not in {None, "box", "cylinder", "placeholder", "mergedMesh"}, f"{component_type} uses a forbidden simplified representation")
        _require(bool(template.get("parameters")), f"{component_type} must define parameters")
        _require(template.get("materialCode") in materials, f"{component_type} must reference a declared material")
    for tile_type in ("panTile", "coverTile"):
        parameters = templates[tile_type]["parameters"]
        _require(isinstance(parameters.get("longitudinalSegments"), int) and parameters["longitudinalSegments"] >= 4, f"{tile_type} must follow the roof curve with at least four longitudinal segments")
        _require(parameters.get("lapTailDepth") == parameters.get("thickness"), f"{tile_type} lap tail must clear one full tile thickness")
        _require(isinstance(parameters.get("lapTransitionLength"), (int, float)) and 0 < parameters["lapTransitionLength"] < parameters["length"] - parameters["overlap"], f"{tile_type} lap transition length is invalid")
    expected_ridge_seat_drop = templates["roofBoard"]["parameters"]["thickness"] / 2 * (
        1 - 1 / (1 + curve["ridgeOneSidedSlope"] ** 2) ** 0.5
    )
    _require(abs(templates["ridgeTile"]["parameters"].get("seatDrop", -1) - expected_ridge_seat_drop) <= 0.001, "ridge seat drop must match the paired roof slopes")

    connections = fixture["connections"]
    _require(bool(connections), "connections must not be empty")
    for item in connections:
        _require(item.get("fromType") in template_types, "connection fromType must reference a component type")
        _require(item.get("toType") in template_types, "connection toType must reference a component type")
        _require(item.get("relation") in {"supportedBy", "connectedTo", "containedBy"}, "unsupported connection relation")
    for roof_type in ("panTile", "coverTile", "ridgeTile"):
        _require(_has_support_path(connections, roof_type, "foundation"), f"{roof_type} must have a support path to foundation")

    views = fixture["views"]
    view_ids = {item.get("id") for item in views}
    _require(len(views) == len(REQUIRED_VIEWS) and view_ids == REQUIRED_VIEWS, "view ids must be unique and match the frozen L1 matrix")
    view_by_id = {item["id"]: item for item in views}
    for view in views:
        _require(view.get("geometryRevisionId") == fixture["geometryRevisionId"], f"{view['id']} must reference the fixture geometry revision")
        _require(view.get("derivation") in {"visibleLineProjection", "planeIntersection", "controlledDetailProjection"}, f"{view['id']} has an unsupported derivation")
        frame = view.get("viewFrame", {})
        origin = _vector(frame.get("origin"), f"{view['id']}.viewFrame.origin")
        right = _vector(frame.get("right"), f"{view['id']}.viewFrame.right")
        up = _vector(frame.get("up"), f"{view['id']}.viewFrame.up")
        depth = _vector(frame.get("depth"), f"{view['id']}.viewFrame.depth")
        for name, vector in (("right", right), ("up", up), ("depth", depth)):
            _require(_close(_dot(vector, vector), 1.0, 2e-8), f"{view['id']} {name} must be a unit vector")
        _require(_close(_dot(right, up), 0) and _close(_dot(right, depth), 0) and _close(_dot(up, depth), 0), f"{view['id']} view axes must be orthogonal")
        _require(all(_close(a, -b, 2e-8) for a, b in zip(_cross(right, up), depth)), f"{view['id']} view frame must use camera-to-model depth")
        expected_matrix = [
            [*right, -_dot(right, origin)],
            [*up, -_dot(up, origin)],
            [*depth, -_dot(depth, origin)],
            [0.0, 0.0, 0.0, 1.0],
        ]
        matrix = frame.get("modelToView")
        _require(isinstance(matrix, list) and len(matrix) == 4 and all(isinstance(row, list) and len(row) == 4 for row in matrix), f"{view['id']} modelToView must be 4x4")
        _require(all(_close(float(matrix[row][column]), expected_matrix[row][column], 2e-8) for row in range(4) for column in range(4)), f"{view['id']} modelToView must match its frozen frame")
        clip_rect = frame.get("clipRectMm")
        clip_depth = frame.get("clipDepthMm")
        _require(isinstance(clip_rect, list) and len(clip_rect) == 4 and clip_rect[0] < clip_rect[2] and clip_rect[1] < clip_rect[3], f"{view['id']} clip rectangle is invalid")
        _require(isinstance(clip_depth, list) and len(clip_depth) == 2 and clip_depth[0] < clip_depth[1], f"{view['id']} depth range is invalid")
        _require(view.get("hiddenLineMode") == "remove", f"{view['id']} must remove hidden lines unless a future explicit selection contract is frozen")

        placement = view.get("paperPlacement", {})
        _require(placement.get("sheet") in {"T0B-01", "T0B-02"}, f"{view['id']} paper sheet is missing")
        viewport = placement.get("viewportRectMm")
        _require(isinstance(viewport, list) and len(viewport) == 4 and viewport[2] > 0 and viewport[3] > 0, f"{view['id']} paper viewport is invalid")
        expected_scale = 1 / int(str(view["scale"]).split(":", 1)[1])
        _require(_close(float(placement.get("paperScale", 0)), expected_scale), f"{view['id']} paper scale does not match its title")
        paper_matrix = placement.get("viewToPaper")
        _require(isinstance(paper_matrix, list) and len(paper_matrix) == 3 and all(isinstance(row, list) and len(row) == 3 for row in paper_matrix), f"{view['id']} viewToPaper must be 3x3")
        _require(_close(float(paper_matrix[0][0]), expected_scale) and _close(float(paper_matrix[1][1]), expected_scale), f"{view['id']} viewToPaper scale is invalid")
        expected_tx = viewport[0] + viewport[2] / 2 - expected_scale * (clip_rect[0] + clip_rect[2]) / 2
        expected_ty = viewport[1] + viewport[3] / 2 - expected_scale * (clip_rect[1] + clip_rect[3]) / 2
        expected_paper_matrix = [[expected_scale, 0, expected_tx], [0, expected_scale, expected_ty], [0, 0, 1]]
        _require(all(_close(float(paper_matrix[row][column]), expected_paper_matrix[row][column], 2e-6) for row in range(3) for column in range(3)), f"{view['id']} viewToPaper must center the frozen clip")
        paper_width = (clip_rect[2] - clip_rect[0]) * expected_scale
        paper_height = (clip_rect[3] - clip_rect[1]) * expected_scale
        _require(paper_width <= viewport[2] + 1e-8 and paper_height <= viewport[3] + 1e-8, f"{view['id']} cannot fit its frozen viewport")
        _require(placement.get("rotationDeg") == 0, f"{view['id']} paper rotation is not supported by the frozen transform")
        safe = placement.get("annotationSafeRectMm")
        _require(isinstance(safe, list) and len(safe) == 4 and safe[2] > 0 and safe[3] > 0, f"{view['id']} annotation safe rectangle is invalid")
        _require(
            safe[0] >= viewport[0]
            and safe[1] >= viewport[1]
            and safe[0] + safe[2] <= viewport[0] + viewport[2]
            and safe[1] + safe[3] <= viewport[1] + viewport[3],
            f"{view['id']} annotation safe rectangle must stay inside its viewport",
        )
        minimum_margin = placement.get("minimumAnnotationMarginMm")
        _require(isinstance(minimum_margin, (int, float)) and minimum_margin >= 5, f"{view['id']} annotation margin is invalid")
        structure = [
            expected_scale * clip_rect[0] + expected_tx,
            expected_scale * clip_rect[1] + expected_ty,
            expected_scale * clip_rect[2] + expected_tx,
            expected_scale * clip_rect[3] + expected_ty,
        ]
        margins = [
            structure[0] - safe[0],
            structure[1] - safe[1],
            safe[0] + safe[2] - structure[2],
            safe[1] + safe[3] - structure[3],
        ]
        _require(min(margins) + 1e-8 >= float(minimum_margin), f"{view['id']} does not reserve its frozen annotation margin")

        if view["id"] in {"floorPlan", "transverseSection", "longitudinalSection"}:
            _require(view["derivation"] == "planeIntersection", f"{view['id']} must use a plane intersection")
            section = view.get("section", {})
            plane_origin = _vector(section.get("planeOrigin"), f"{view['id']}.section.planeOrigin")
            plane_normal = _vector(section.get("planeNormal"), f"{view['id']}.section.planeNormal")
            retained = _vector(section.get("retainedDirection"), f"{view['id']}.section.retainedDirection")
            _require(section.get("mode") == "cut-and-depth-projection", f"{view['id']} must combine a true cut with depth projection")
            _require(all(_close(a, b) for a, b in zip(plane_origin, origin)), f"{view['id']} section plane must anchor the view frame")
            _require_unit_parallel(plane_normal, retained, f"{view['id']}.section")
            _require(all(_close(a, b) for a, b in zip(retained, depth)), f"{view['id']} section retained direction must match view depth")
            _require(0 < section.get("cutToleranceMm", 0) <= geometry_validation["curveToleranceMm"], f"{view['id']} section tolerance is too loose")
            _require(section.get("stabilityProbeMm") == 0.5, f"{view['id']} must freeze a 0.5 mm section stability probe")
        elif view["derivation"] == "visibleLineProjection":
            direction = _vector(view.get("direction"), f"{view['id']}.direction")
            _require(view.get("directionSemantics") == "camera-to-model", f"{view['id']} direction semantics are ambiguous")
            _require(all(_close(a, b) for a, b in zip(direction, depth)), f"{view['id']} direction must match view depth")
        else:
            detail = view.get("detail", {})
            _require(detail.get("mode") in {"section-projection", "occlusion-projection"}, f"{view['id']} detail mode is invalid")
            _require_uuid(detail.get("anchorEntityId"), f"{view['id']}.anchorEntityId")
            anchor_point = _vector(detail.get("anchorPoint"), f"{view['id']}.anchorPoint")
            bounds = detail.get("cropBoundsModelMm")
            _require(isinstance(bounds, list) and len(bounds) == 2 and all(isinstance(point, list) and len(point) == 3 for point in bounds), f"{view['id']} detail crop must be a 3D box")
            _require(all(bounds[0][index] < bounds[1][index] for index in range(3)), f"{view['id']} detail crop is invalid")
            _require(all(bounds[0][index] <= anchor_point[index] <= bounds[1][index] for index in range(3)), f"{view['id']} anchor must be inside its detail crop")
            _require(set(detail.get("targetTypes", [])) <= required_types and detail.get("targetTypes"), f"{view['id']} detail types are invalid")
            _require(detail.get("anchorComponentType") in detail["targetTypes"], f"{view['id']} anchor type must be selected by the detail")
            anchor_centroid = _vector(detail.get("anchorCentroid"), f"{view['id']}.anchorCentroid")
            _require(all(bounds[0][index] <= anchor_centroid[index] <= bounds[1][index] for index in range(3)), f"{view['id']} anchor centroid must be inside its detail crop")
            if detail["mode"] == "section-projection":
                section = detail.get("section", {})
                detail_plane_origin = _vector(section.get("planeOrigin"), f"{view['id']}.section.planeOrigin")
                plane_normal = _vector(section.get("planeNormal"), f"{view['id']}.section.planeNormal")
                retained = _vector(section.get("retainedDirection"), f"{view['id']}.section.retainedDirection")
                _require_unit_parallel(plane_normal, retained, f"{view['id']}.section")
                _require(all(_close(a, b) for a, b in zip(retained, depth)), f"{view['id']} detail retained direction must match view depth")
                _require(_close(_dot([anchor_point[index] - detail_plane_origin[index] for index in range(3)], plane_normal), 0.0, 1e-6), f"{view['id']} section anchor point must lie on its cut plane")
                _require(section.get("stabilityProbeMm") == 0.5, f"{view['id']} must freeze a 0.5 mm section stability probe")
            else:
                direction = _vector(view.get("direction"), f"{view['id']}.direction")
                _require(view.get("directionSemantics") == "camera-to-model" and all(_close(a, b) for a, b in zip(direction, depth)), f"{view['id']} detail direction is ambiguous")

    transverse = view_by_id["transverseSection"]
    _require(transverse["section"]["planeOrigin"] == [-1750, 0, 0], "transverse section must pass through the stable west column frame cut")
    _require(transverse["section"].get("anchorEntityId") == "094027ab-3397-5117-bad8-81c07d961879", "transverse section must retain its column anchor")

    requirements = fixture["drawingRequirements"]
    _require(set(requirements.get("dimensionCategories", [])) == REQUIRED_DIMENSION_CATEGORIES, "dimension coverage is incomplete")
    _require(set(requirements.get("levelCategories", [])) == REQUIRED_LEVEL_CATEGORIES, "level coverage is incomplete")
    _require(set(requirements.get("titleBlockFields", [])) >= {"project", "drawingTitle", "drawingNumber", "scale", "unit", "status", "revision", "date", "responsibilityBoundary"}, "title block fields are incomplete")
    _require(set(requirements.get("dimensionCoverage", {})) == REQUIRED_VIEWS, "per-view dimension coverage is incomplete")
    _require(set(requirements.get("levelCoverage", {})) == REQUIRED_VIEWS, "per-view level coverage is incomplete")
    projection_policy = requirements.get("projectionPolicy", {})
    _require(projection_policy.get("hiddenLineRemoval") is True, "hidden-line removal is required")
    _require(projection_policy.get("triangleInteriorEdges") == "forbidden", "triangle interior edges must be forbidden")
    _require(isinstance(projection_policy.get("featureAngleDeg"), (int, float)) and 0 < projection_policy["featureAngleDeg"] < 90, "feature-edge angle is invalid")
    _require(isinstance(projection_policy.get("visibilityProbeToleranceMm"), (int, float)) and 0 < projection_policy["visibilityProbeToleranceMm"] <= geometry_validation["curveToleranceMm"], "visibility tolerance is too loose")
    _require(isinstance(projection_policy.get("occlusionSplitToleranceMm"), (int, float)) and 0 < projection_policy["occlusionSplitToleranceMm"] <= 5, "occlusion split tolerance is too loose")
    _require(set(projection_policy.get("structuralLineClasses", [])) == {"cut", "silhouette", "feature", "componentBoundary"}, "structural line classes are incomplete")
    _require(set(projection_policy.get("visibilityClasses", [])) == {"visible", "hidden"}, "visibility classes are incomplete")
    _require(
        requirements.get("lineClassLayerMap")
        == {
            "cut": "GJ-CUT",
            "silhouette": "GJ-OUTLINE",
            "feature": "GJ-OUTLINE",
            "componentBoundary": "GJ-PROJECTION",
            "visible": "GJ-PROJECTION",
            "hidden": "GJ-HIDDEN",
            "axis": "GJ-AXIS",
            "dimension": "GJ-DIMENSION",
            "annotation": "GJ-TEXT",
            "hatch": "GJ-HATCH",
        },
        "line classes must map to the frozen CAD layers",
    )
    _require(requirements.get("detailTracePolicy") == {"sourceEntityCoverage": 1.0, "geometryRevisionRequired": True, "derivationTransformRequired": True}, "detail trace policy is incomplete")
    _require(set(requirements.get("nativeCadEntities", [])) == REQUIRED_NATIVE_CAD_ENTITIES, "native CAD entity requirements are incomplete")
    _require(set(requirements.get("requiredLayers", [])) == REQUIRED_CAD_LAYERS, "professional CAD layer requirements are incomplete")
    _require(requirements.get("pageQuality") == {"missingGlyphs": 0, "fontSubstitutions": 0, "questionMarkPlaceholders": 0, "clippedElements": 0, "overlaps": 0}, "page quality gates are incomplete")
    outputs = requirements.get("outputMatrix", {})
    _require(outputs.get("dxf") == {"files": 1, "layouts": ["T0B-01", "T0B-02"], "modelSpaceUnit": "mm", "modelSpaceScale": "1:1"}, "DXF output matrix is incomplete")
    _require(outputs.get("svg") == {"files": ["T0B-01.svg", "T0B-02.svg"], "vectorRequired": True}, "SVG output matrix is incomplete")
    _require(outputs.get("pdf") == {"files": 1, "pages": 2, "vectorRequired": True, "searchableText": True, "embeddedFonts": True}, "PDF output matrix is incomplete")
    _require(outputs.get("reviewPng") == {"files": ["T0B-01-300dpi.png", "T0B-02-300dpi.png"], "dpi": 300, "pixelSize": [9933, 7016]}, "review PNG output matrix is incomplete")

    sheets = fixture["drawingSheets"]
    all_sheet_view_ids = [view_id for sheet in sheets for view_id in sheet.get("viewIds", [])]
    sheet_views = set(all_sheet_view_ids)
    _require({sheet.get("drawingNumber") for sheet in sheets} == {"T0B-01", "T0B-02"}, "the frozen sample requires two drawing sheets")
    _require(len(all_sheet_view_ids) == len(REQUIRED_VIEWS) and sheet_views == REQUIRED_VIEWS, "drawing sheets must cover each view exactly once")
    for sheet in sheets:
        _require(sheet.get("size") == "A1" and sheet.get("orientation") == "landscape" and sheet.get("pageMm") == [841, 594], f"{sheet.get('drawingNumber')} must be A1 landscape")
        _require(sheet.get("render300DpiPx") == [9933, 7016], f"{sheet.get('drawingNumber')} 300 dpi size is invalid")
        _require(isinstance(sheet.get("printableRectMm"), list) and len(sheet["printableRectMm"]) == 4, f"{sheet.get('drawingNumber')} printable rectangle is missing")
        _require(isinstance(sheet.get("titleBlockRectMm"), list) and len(sheet["titleBlockRectMm"]) == 4, f"{sheet.get('drawingNumber')} title block is missing")
        printable = sheet["printableRectMm"]
        title_block = sheet["titleBlockRectMm"]
        for name, rectangle in (("printable", printable), ("title block", title_block)):
            _require(
                0 <= rectangle[0] < rectangle[2] <= sheet["pageMm"][0]
                and 0 <= rectangle[1] < rectangle[3] <= sheet["pageMm"][1],
                f"{sheet.get('drawingNumber')} {name} rectangle must stay inside the page",
            )
        separated_from_title = (
            printable[2] <= title_block[0]
            or title_block[2] <= printable[0]
            or printable[3] <= title_block[1]
            or title_block[3] <= printable[1]
        )
        _require(separated_from_title, f"{sheet.get('drawingNumber')} printable area and title block must not overlap")
        for view_id in sheet["viewIds"]:
            _require(view_by_id[view_id]["paperPlacement"]["sheet"] == sheet["drawingNumber"], f"{view_id} is assigned to the wrong sheet")
            rectangle = view_by_id[view_id]["paperPlacement"]["viewportRectMm"]
            _require(
                rectangle[0] >= printable[0]
                and rectangle[1] >= printable[1]
                and rectangle[0] + rectangle[2] <= printable[2]
                and rectangle[1] + rectangle[3] <= printable[3],
                f"{view_id} viewport must stay inside the printable rectangle",
            )
        rectangles = {
            view_id: view_by_id[view_id]["paperPlacement"]["viewportRectMm"]
            for view_id in sheet["viewIds"]
        }
        names = sorted(rectangles)
        for index, left_name in enumerate(names):
            left = rectangles[left_name]
            for right_name in names[index + 1:]:
                right = rectangles[right_name]
                separated = (
                    left[0] + left[2] <= right[0]
                    or right[0] + right[2] <= left[0]
                    or left[1] + left[3] <= right[1]
                    or right[1] + right[3] <= left[1]
                )
                _require(separated, f"{left_name} and {right_name} paper viewports overlap")

    condition = fixture["conditionRecord"]
    _require(condition.get("producerType") == "demo", "condition record must retain demo provenance")
    _require(condition.get("targetType") in template_types, "condition record must target a component type")
    _require(bool(condition.get("description")), "condition record must include a description")

    known = fixture["knownAnswers"]
    _require(known.get("bayWidth") == fixture["assembly"]["bayWidth"], "known bay width must match the assembly")
    _require(known.get("depth") == fixture["assembly"]["depth"], "known depth must match the assembly")
    _require(known.get("roofWidth") == fixture["assembly"]["roofWidth"], "known roof width must match the assembly")
    _require(known.get("geometryRevisionId") == fixture["geometryRevisionId"], "known answer must bind the geometry revision")
    _require(isinstance(known.get("geometrySignature"), str) and len(known["geometrySignature"]) == 64, "known geometry signature must be a sha256 value")
    expected_revision = str(uuid5(GEOMETRY_REVISION_NAMESPACE, known["geometrySignature"]))
    _require(fixture["geometryRevisionId"] == expected_revision, "geometry revision must be derived from the frozen geometry signature")
    oracle = known.get("geometryOracle", {})
    _require(set(oracle) == {"overallBounds", "stepBounds", "doorLeafBounds", "ridgeBounds"}, "numeric geometry oracle is incomplete")
    for field, bounds in oracle.items():
        _require(isinstance(bounds, list) and len(bounds) == 2 and all(isinstance(point, list) and len(point) == 3 for point in bounds), f"{field} must be 3D bounds")
    _require(set(known.get("requiredViewIds", [])) == REQUIRED_VIEWS, "known answer view matrix is incomplete")
    view_oracle = known.get("viewOracle", {})
    _require(view_oracle.get("hashConvention") == "sha256 of LF-delimited sorted entity UUIDs; section segment hashes use sorted 0.001 mm canonical endpoint records", "view oracle hash convention is not frozen")
    _require("not quality or qualification thresholds" in str(view_oracle.get("metricUse")), "diagnostic counts must not become quality gates")
    oracle_views = view_oracle.get("views", {})
    _require(set(oracle_views) == REQUIRED_VIEWS, "per-view oracle matrix is incomplete")
    for view_id, view_answer in oracle_views.items():
        _require_sha256(view_answer.get("selectionEntitySetSha256"), f"{view_id}.selectionEntitySetSha256")
        _require(isinstance(view_answer.get("selectionCountDiagnostic"), int) and view_answer["selectionCountDiagnostic"] > 0, f"{view_id} selection diagnostic is invalid")
        _require(set(view_answer.get("selectionTypes", [])) <= required_types and view_answer.get("selectionTypes"), f"{view_id} selection type oracle is invalid")
        _require(isinstance(view_answer.get("anchorModelPointsMm"), dict) or view_id.endswith("Detail"), f"{view_id} anchor oracle is missing")
        _require(isinstance(view_answer.get("dimensionsMm"), dict) and isinstance(view_answer.get("levelsMm"), dict), f"{view_id} dimensions and levels must be frozen")
    for view_id in {"floorPlan", "transverseSection", "longitudinalSection", "eaveDetail", "columnBaseDetail"}:
        answer = oracle_views[view_id]
        _require_sha256(answer.get("cutEntitySetSha256"), f"{view_id}.cutEntitySetSha256")
        _require_sha256(answer.get("cutSegmentSha256"), f"{view_id}.cutSegmentSha256")
    for view_id in {"floorPlan", "transverseSection", "longitudinalSection"}:
        answer = oracle_views[view_id]
        _require(isinstance(answer.get("cutClosedRegionCount"), int) and answer["cutClosedRegionCount"] > 0, f"{view_id} cut topology is missing")
        _require(answer.get("cutOpenOrDangleCount") == 0, f"{view_id} cut topology must be closed")
        _require(isinstance(answer.get("cutClosedRegionsByType"), dict) and answer["cutClosedRegionsByType"], f"{view_id} cut type topology is missing")
        _require(isinstance(answer.get("cutBounds2dMm"), list) and len(answer["cutBounds2dMm"]) == 4, f"{view_id} cut bounds are missing")
    for view_id in {"eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"}:
        _require(oracle_views[view_id].get("anchorEntityId") == view_by_id[view_id]["detail"]["anchorEntityId"], f"{view_id} oracle must use the frozen detail instance")
        _require(set(oracle_views[view_id].get("requiredTypes", [])) == set(view_by_id[view_id]["detail"]["targetTypes"]), f"{view_id} oracle types must match the detail selection")

    acceptance = fixture["acceptance"]
    _require(acceptance.get("structuralSourceEntityCoverage") == 1.0, "structural source entity coverage must be 100%")
    _require(acceptance.get("structureLineClassificationCoverage") == 1.0, "structure line classification coverage must be 100%")
    _require(acceptance.get("detailSourceTraceCoverage") == 1.0, "detail source trace coverage must be 100%")
    _require(acceptance.get("independentSectionRecalculation") is True, "independent section recalculation is required")
    _require(acceptance.get("independentProjectionVerification") is True, "independent projection verification is required")
    _require(acceptance.get("externalReferenceIsolation") is True, "external reference isolation is required")
    _require(acceptance.get("nativeCadObjectValidation") is True, "native CAD object validation is required")
    _require(acceptance.get("glyphAndPageValidation") is True, "glyph and page validation is required")
    _require(acceptance.get("noTriangleInteriorEdges") is True, "triangle interior edges must be rejected")
    _require(acceptance.get("zeroOcclusionErrors") is True, "occlusion errors must be rejected")
    _require(acceptance.get("qualificationMustBeIndependent") is True, "qualification must be independent from generation")
    _require(acceptance.get("professionalReviewRequired") is True, "professional review is required")
    _require(set(acceptance.get("forbiddenPassMetrics", [])) == FORBIDDEN_PASS_METRICS, "forbidden pass metrics must be explicit")
    actual_view_signature = _view_contract_signature(fixture)
    _require(fixture.get("viewContractSignature") == actual_view_signature, "view contract signature must match the frozen views, sheets, and requirements")
    _require(fixture.get("viewContractRevisionId") == str(uuid5(VIEW_CONTRACT_REVISION_NAMESPACE, actual_view_signature)), "view contract revision must be derived from its signature")
    return fixture


def load_fixture(path: Path) -> dict:
    return validate_fixture(json.loads(path.read_text(encoding="utf-8")))
