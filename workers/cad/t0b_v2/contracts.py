from __future__ import annotations

from collections import deque
import json
from pathlib import Path
from uuid import UUID


class ContractError(ValueError):
    pass


REQUIRED_COMPONENT_TYPES = {
    "foundation",
    "groundLayer",
    "terrace",
    "step",
    "columnBase",
    "column",
    "eaveBeam",
    "tieBeam",
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
        "scope",
        "coordinateSystem",
        "materials",
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
    _require(fixture["coordinateSystem"] == {"x": "east", "y": "north", "z": "up"}, "coordinate system must be fixed")

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
    _require(known.get("geometryRevisionId") == fixture["geometryRevisionId"], "known answer must bind the geometry revision")
    _require(set(known.get("requiredViewIds", [])) == REQUIRED_VIEWS, "known answer view matrix is incomplete")

    acceptance = fixture["acceptance"]
    _require(acceptance.get("structuralSourceEntityCoverage") == 1.0, "structural source entity coverage must be 100%")
    _require(acceptance.get("independentSectionRecalculation") is True, "independent section recalculation is required")
    _require(acceptance.get("independentProjectionVerification") is True, "independent projection verification is required")
    _require(acceptance.get("noTriangleInteriorEdges") is True, "triangle interior edges must be rejected")
    _require(acceptance.get("professionalReviewRequired") is True, "professional review is required")
    _require(set(acceptance.get("forbiddenPassMetrics", [])) == FORBIDDEN_PASS_METRICS, "forbidden pass metrics must be explicit")
    return fixture


def load_fixture(path: Path) -> dict:
    return validate_fixture(json.loads(path.read_text(encoding="utf-8")))
