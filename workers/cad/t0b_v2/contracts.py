from __future__ import annotations

from collections import deque
import json
from pathlib import Path
from uuid import UUID, uuid5


class ContractError(ValueError):
    pass


GEOMETRY_REVISION_NAMESPACE = UUID("1f321b7d-38a4-5b48-8a82-353bc6298225")


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
    _require(view_ids == REQUIRED_VIEWS, "view set must match the frozen L1 matrix")
    for view in views:
        _require(view.get("geometryRevisionId") == fixture["geometryRevisionId"], f"{view['id']} must reference the fixture geometry revision")
        _require(view.get("derivation") in {"visibleLineProjection", "planeIntersection", "controlledDetailProjection"}, f"{view['id']} has an unsupported derivation")
        if view["id"] in {"floorPlan", "transverseSection", "longitudinalSection"}:
            _require(view["derivation"] == "planeIntersection", f"{view['id']} must use a plane intersection")
            _require(len(view.get("planeOrigin", [])) == 3 and len(view.get("planeNormal", [])) == 3, f"{view['id']} must define a section plane")
        else:
            _require(len(view.get("direction", [])) == 3, f"{view['id']} must define a projection direction")

    requirements = fixture["drawingRequirements"]
    _require(set(requirements.get("dimensionCategories", [])) == REQUIRED_DIMENSION_CATEGORIES, "dimension coverage is incomplete")
    _require(set(requirements.get("levelCategories", [])) == REQUIRED_LEVEL_CATEGORIES, "level coverage is incomplete")
    _require(set(requirements.get("titleBlockFields", [])) >= {"project", "drawingTitle", "drawingNumber", "scale", "unit", "status", "revision", "date", "responsibilityBoundary"}, "title block fields are incomplete")
    _require(set(requirements.get("dimensionCoverage", {})) == REQUIRED_VIEWS, "per-view dimension coverage is incomplete")
    _require(set(requirements.get("levelCoverage", {})) == REQUIRED_VIEWS, "per-view level coverage is incomplete")
    projection_policy = requirements.get("projectionPolicy", {})
    _require(projection_policy.get("hiddenLineRemoval") is True, "hidden-line removal is required")
    _require(projection_policy.get("triangleInteriorEdges") == "forbidden", "triangle interior edges must be forbidden")
    _require(requirements.get("detailTracePolicy") == {"sourceEntityCoverage": 1.0, "geometryRevisionRequired": True, "derivationTransformRequired": True}, "detail trace policy is incomplete")
    _require(set(requirements.get("nativeCadEntities", [])) == REQUIRED_NATIVE_CAD_ENTITIES, "native CAD entity requirements are incomplete")
    _require(set(requirements.get("requiredLayers", [])) == REQUIRED_CAD_LAYERS, "professional CAD layer requirements are incomplete")
    _require(requirements.get("pageQuality") == {"missingGlyphs": 0, "fontSubstitutions": 0, "questionMarkPlaceholders": 0, "clippedElements": 0, "overlaps": 0}, "page quality gates are incomplete")

    sheets = fixture["drawingSheets"]
    sheet_views = {view_id for sheet in sheets for view_id in sheet.get("viewIds", [])}
    _require({sheet.get("drawingNumber") for sheet in sheets} == {"T0B-01", "T0B-02"}, "the frozen sample requires two drawing sheets")
    _require(sheet_views == REQUIRED_VIEWS, "drawing sheets must cover the complete view matrix")

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
    return fixture


def load_fixture(path: Path) -> dict:
    return validate_fixture(json.loads(path.read_text(encoding="utf-8")))
