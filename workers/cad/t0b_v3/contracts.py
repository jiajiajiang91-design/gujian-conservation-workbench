from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5


GEOMETRY_REVISION_NAMESPACE = UUID("450b6735-9609-4a80-a8c4-76f7210be2ef")

GEOMETRIC_RESOLUTIONS = {"resolved", "simplified", "placeholder", "unknown"}
CONSTRUCTION_RESOLUTIONS = {"demoDefined", "evidenceResolved", "unknown", "notApplicable"}
TYPOLOGY_STATUSES = {"neutralRole", "evidenceConfirmed", "unknown"}
FACT_BASES = {"demoParameter", "derivedGeometry", "measuredEvidence", "expertDecision", "unknown"}
INTERFACE_KINDS = {
    "bearing",
    "lap",
    "grooveSeat",
    "mortiseTenon",
    "halfLap",
    "clearance",
    "containment",
    "throughHousing",
    "closure",
    "unknown",
}
CONTACT_MODES = {"surface", "line", "overlapZone", "clearance", "none"}
PARAMETER_VALUE_TYPES = {"length", "angle", "count", "ratio", "text"}
PARAMETER_UNITS = {"length": "mm", "angle": "deg", "count": "1", "ratio": "1", "text": None}

NEUTRAL_TERMS = {
    "bracketSeat": "承托座（团队演示）",
    "bracketArm": "承托臂（团队演示）",
    "bearingBlock": "檩下承块（团队演示）",
}
FORBIDDEN_TYPOLOGY_TERMS = {"斗栱", "斗拱", "栌斗", "栱", "昂", "撑拱"}

REQUIRED_COMPONENT_TYPES = {
    "groundLayer",
    "foundationLayer",
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
    "eaveClosure",
    "roofBoard",
    "panTile",
    "coverTile",
    "ridgeTile",
    "wall",
    "doorFrameMember",
    "doorLeafStile",
    "doorLeafRail",
    "doorLeafPanel",
    "latticeFrameMember",
    "latticeBar",
}

REQUIRED_INTERFACE_ROLES = {
    "ground-step",
    "foundation-ground",
    "foundation-bearing-ground",
    "foundation-course-stack",
    "terrace-foundation",
    "terrace-course-stack",
    "step-course-stack",
    "step-terrace",
    "column-base",
    "base-terrace",
    "column-eave-beam",
    "column-tie-beam",
    "tie-beam-interior-post",
    "interior-post-purlin",
    "eave-beam-seat",
    "seat-arm-x",
    "seat-arm-y",
    "arm-cross-half-lap",
    "arm-bearing-block",
    "bearing-block-purlin",
    "rafter-purlin",
    "fly-rafter-rafter",
    "roof-board-rafter",
    "pan-tile-roof-board",
    "cover-tile-pan-tile",
    "tile-longitudinal-lap",
    "ridge-roof-finish",
    "eave-closure",
    "wall-terrace",
    "door-frame-terrace",
    "frame-corner-joint",
    "door-leaf-rail-stile",
    "door-panel-groove",
    "door-leaf-clearance",
    "lattice-cross-joint",
    "lattice-frame-corner",
    "lattice-bar-frame",
    "opening-closure",
}


class ContractError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def _require_uuid(value: Any, field: str) -> None:
    try:
        UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ContractError(f"{field} must be a UUID") from exc


def _require_sha(value: Any, field: str, allow_unfrozen: bool = False) -> None:
    if allow_unfrozen and value == "UNFROZEN":
        return
    _require(isinstance(value, str) and len(value) == 64, f"{field} must be a sha256 value")
    _require(all(char in "0123456789abcdef" for char in value), f"{field} must be lowercase hexadecimal")


def _require_demo_fact(item: dict, field: str) -> None:
    _require(item.get("producerType") == "demo", f"{field} must retain demo provenance")
    _require(item.get("factBasis") in {"demoParameter", "derivedGeometry", "unknown"}, f"{field} has an unsupported fact basis")
    _require(item.get("formalEligibility") == "ineligible", f"{field} must remain formally ineligible")


def expected_geometry_revision(geometry_signature: str) -> str:
    return str(uuid5(GEOMETRY_REVISION_NAMESPACE, geometry_signature))


def parameter_type_map(registry: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for value_type, definition in registry.items():
        for name in definition["parameters"]:
            result[name] = {"valueType": value_type, "unit": definition["unit"]}
    return result


def validate_fixture(fixture: dict, *, allow_unfrozen: bool = False) -> dict:
    required_root = {
        "schemaVersion",
        "projectId",
        "fixtureId",
        "geometryRevisionId",
        "producerType",
        "formalEligibility",
        "unit",
        "coordinateSystem",
        "sourceRefs",
        "referenceIsolation",
        "scope",
        "materials",
        "assembly",
        "parameterTypeRegistry",
        "unknownRegistry",
        "dimensionFacts",
        "geometryValidation",
        "componentTemplates",
        "requiredComponentTypes",
        "interfaceTemplates",
        "requiredInterfaceRoles",
        "observationCandidates",
        "protectionRecommendationCandidates",
        "knownAnswers",
        "acceptance",
    }
    missing = sorted(required_root - set(fixture))
    _require(not missing, f"missing root fields: {', '.join(missing)}")
    _require(fixture["schemaVersion"] == "t0b-v3-geometry-fixture-2", "unsupported fixture schema")
    _require_uuid(fixture["projectId"], "projectId")
    _require_uuid(fixture["fixtureId"], "fixtureId")
    if not (allow_unfrozen and fixture["geometryRevisionId"] == "UNFROZEN"):
        _require_uuid(fixture["geometryRevisionId"], "geometryRevisionId")
    _require(fixture["producerType"] == "demo", "fixture must be demo data")
    _require(fixture["formalEligibility"] == "ineligible", "fixture cannot enter formal results")
    _require(fixture["unit"] == "mm", "fixture unit must be millimetres")
    _require(fixture["coordinateSystem"] == {"x": "east", "y": "north", "z": "up"}, "coordinate system is not frozen")
    _require(fixture["scope"] == "team-owned-local-construction-sample", "fixture scope is invalid")
    _require(fixture["sourceRefs"] and all(str(item).startswith("demo:") for item in fixture["sourceRefs"]), "sourceRefs must use the demo scheme")
    _require(
        fixture["referenceIsolation"]
        == {"fixtureOnly": True, "allowedSourceSchemes": ["demo"], "externalAssetsAllowed": False},
        "external references must be isolated",
    )

    materials = fixture["materials"]
    _require(set(materials) >= {"timber-demo", "stone-demo", "earth-demo", "ceramic-demo"}, "material set is incomplete")
    for code, fact in materials.items():
        _require_demo_fact(fact, f"material {code}")
        _require(fact.get("materialCode") == code and bool(fact.get("displayNameZh")), f"material {code} is incomplete")

    parameter_registry = fixture["parameterTypeRegistry"]
    _require(set(parameter_registry) == PARAMETER_VALUE_TYPES, "parameter type registry is incomplete")
    declared_parameters: list[str] = []
    for value_type, definition in parameter_registry.items():
        _require(definition.get("unit") == PARAMETER_UNITS[value_type], f"{value_type} parameter unit is invalid")
        names = definition.get("parameters")
        _require(isinstance(names, list) and all(isinstance(name, str) and name for name in names), f"{value_type} parameter names are invalid")
        declared_parameters.extend(names)
    _require(len(declared_parameters) == len(set(declared_parameters)), "a parameter cannot have multiple value types")
    parameter_types = parameter_type_map(parameter_registry)

    unknown_registry = fixture["unknownRegistry"]
    _require(isinstance(unknown_registry, dict) and unknown_registry, "unknown registry is required")
    reason_codes: set[str] = set()
    for stable_key, item in unknown_registry.items():
        _require(isinstance(stable_key, str) and stable_key, "unknown stable key is invalid")
        reason_code = item.get("reasonCode")
        _require(isinstance(reason_code, str) and reason_code and reason_code not in reason_codes, f"{stable_key} reasonCode is invalid")
        reason_codes.add(reason_code)
        _require(bool(item.get("displayNameZh")), f"{stable_key} requires a Chinese display name")
        _require(isinstance(item.get("requiredEvidence"), list) and item["requiredEvidence"], f"{stable_key} required evidence is missing")
        _require(isinstance(item.get("affectedClaims"), list) and item["affectedClaims"], f"{stable_key} affected claims are missing")
        for field in ("blocksProxyResult", "blocksFormalEligibility", "blocksL1"):
            _require(isinstance(item.get(field), bool), f"{stable_key} {field} must be boolean")
        _require(item["blocksFormalEligibility"] and item["blocksL1"], f"{stable_key} must block formal and L1 qualification")

    dimension_facts = fixture["dimensionFacts"]
    _require(isinstance(dimension_facts, dict) and dimension_facts, "dimension facts are required")
    for stable_key, fact in dimension_facts.items():
        _require(stable_key.startswith("DIM-"), f"invalid dimension fact key: {stable_key}")
        _require(isinstance(fact.get("value"), (int, float)), f"{stable_key} value is invalid")
        _require(fact.get("unit") == "mm", f"{stable_key} unit must be mm")
        _require(fact.get("factBasis") in {"demoParameter", "derivedGeometry"}, f"{stable_key} fact basis is invalid")

    templates = fixture["componentTemplates"]
    _require(set(fixture["requiredComponentTypes"]) == REQUIRED_COMPONENT_TYPES, "required component type set differs from v3 contract")
    _require(set(templates) == REQUIRED_COMPONENT_TYPES, "component template set differs from v3 contract")
    for component_type, template in templates.items():
        resolution = template.get("resolution", {})
        _require(resolution.get("geometric") in GEOMETRIC_RESOLUTIONS, f"{component_type} geometric resolution is invalid")
        _require(resolution.get("construction") in CONSTRUCTION_RESOLUTIONS, f"{component_type} construction resolution is invalid")
        _require(resolution.get("l1DemoEligibility") == "blocked", f"{component_type} must remain blocked from L1")
        _require(resolution["geometric"] == "resolved", f"{component_type} must be resolved in the frozen v3 sample")
        _require(resolution["construction"] in {"demoDefined", "unknown"}, f"{component_type} construction resolution is unsupported")
        domain = template.get("domainTerm", {})
        _require(domain.get("stableKey") == component_type, f"{component_type} domain stable key is invalid")
        _require(bool(domain.get("displayNameZh")), f"{component_type} requires a Chinese display name")
        _require(domain.get("typologyStatus") in TYPOLOGY_STATUSES, f"{component_type} typology status is invalid")
        if component_type in NEUTRAL_TERMS:
            _require(domain["displayNameZh"] == NEUTRAL_TERMS[component_type], f"{component_type} must use the frozen neutral term")
            _require(domain.get("typologyClaim") is None and domain.get("typologyStatus") in {"neutralRole", "unknown"}, f"{component_type} cannot claim a typology")
            _require(domain.get("typologyEvidenceRefs") == [], f"{component_type} cannot carry unsupported typology evidence")
        visible_term = json.dumps(domain, ensure_ascii=False)
        _require(not any(term in visible_term for term in FORBIDDEN_TYPOLOGY_TERMS), f"{component_type} contains an unsupported typology term")
        _require(template.get("materialCode") in materials, f"{component_type} material is not declared")
        parameters = template.get("parameters")
        _require(bool(parameters), f"{component_type} parameters are missing")
        for name, value in parameters.items():
            _require(name in parameter_types, f"{component_type}.{name} has no declared value type")
            value_type = parameter_types[name]["valueType"]
            if value_type == "count":
                _require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, f"{component_type}.{name} must be a count")
            elif value_type == "text":
                _require(isinstance(value, str), f"{component_type}.{name} must be text")
            else:
                _require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{component_type}.{name} must be numeric")
        _require(bool(template.get("assemblyRole")) and bool(template.get("memberRole")), f"{component_type} assembly role is incomplete")
        _require(isinstance(template.get("requiredFeatureProfile"), list), f"{component_type} feature profile must be a list")
        _require(isinstance(template.get("unknowns"), list), f"{component_type} unknowns must be a list")
        _require(set(template["unknowns"]) <= set(unknown_registry), f"{component_type} references an undeclared unknown")
        _require_demo_fact(template, f"component {component_type}")

    used_parameters = {
        name
        for template in templates.values()
        for name in template["parameters"]
    }
    _require(set(parameter_types) == used_parameters, "parameter type registry contains missing or unused entries")

    interface_templates = fixture["interfaceTemplates"]
    _require(interface_templates, "interface templates are required")
    interface_ids: set[str] = set()
    roles: set[str] = set()
    for item in interface_templates:
        interface_id = item.get("interfaceId")
        _require(isinstance(interface_id, str) and interface_id and interface_id not in interface_ids, "interfaceId must be unique")
        interface_ids.add(interface_id)
        role = item.get("role")
        _require(role in REQUIRED_INTERFACE_ROLES, f"unsupported interface role: {role}")
        roles.add(role)
        _require(item.get("fromEntityKey") and item.get("toEntityKey"), f"{interface_id} must bind two entity keys")
        _require(item.get("fromSurfaceRef") and item.get("toSurfaceRef"), f"{interface_id} must bind two surfaces")
        _require(item.get("interfaceKind") in INTERFACE_KINDS, f"{interface_id} interface kind is invalid")
        _require(item.get("contactMode") in CONTACT_MODES, f"{interface_id} contact mode is invalid")
        _require(item.get("interfaceStatus") in {"demoDefined", "evidenceResolved", "unknown", "notApplicable"}, f"{interface_id} status is invalid")
        _require(item.get("factBasis") in FACT_BASES, f"{interface_id} fact basis is invalid")
        _require(item.get("formalEligibility") == "ineligible", f"{interface_id} must remain formally ineligible")
        _require(isinstance(item.get("dimensionRefs"), list), f"{interface_id} dimensionRefs must be a list")
        _require(set(item["dimensionRefs"]) <= set(dimension_facts), f"{interface_id} references an unknown dimension fact")
        _require(isinstance(item.get("direction"), list) and len(item["direction"]) == 3, f"{interface_id} direction is invalid")
        for tolerance in ("expectedGapMm", "maximumGapMm", "maximumUnexpectedOverlapMm3"):
            value = item.get(tolerance)
            _require(value is None or isinstance(value, (int, float)), f"{interface_id} {tolerance} is invalid")
    _require(set(fixture["requiredInterfaceRoles"]) == REQUIRED_INTERFACE_ROLES, "required interface roles differ from v3 contract")
    _require(roles == REQUIRED_INTERFACE_ROLES, "interface role coverage is incomplete")

    observations = fixture["observationCandidates"]
    _require(len(observations) >= 1, "at least one observation candidate is required")
    observation_ids = set()
    for item in observations:
        _require_uuid(item.get("observationCandidateId"), "observationCandidateId")
        observation_ids.add(item["observationCandidateId"])
        _require(item.get("targetEntityKey") and item.get("targetSurfaceRef") and item.get("locationGeometry"), "observation candidate must bind an entity surface and location")
        _require_demo_fact(item, "observation candidate")
        _require(item.get("diagnosis") is None and item.get("cause") is None and item.get("severity") is None, "demo observation cannot contain a diagnosis")
        _require(item.get("candidateStatus") == "unreviewed", "demo observation must remain unreviewed")
    recommendations = fixture["protectionRecommendationCandidates"]
    _require(len(recommendations) >= 1, "at least one protection recommendation candidate is required")
    for item in recommendations:
        _require_uuid(item.get("protectionRecommendationCandidateId"), "protectionRecommendationCandidateId")
        _require(item.get("observationCandidateRef") in observation_ids, "protection candidate must reference an observation")
        _require_demo_fact(item, "protection recommendation candidate")
        _require(item.get("candidateStatus") == "unreviewed" and item.get("responsibleReviewerRef") is None, "protection candidate cannot be confirmed")

    validation = fixture["geometryValidation"]
    for field in (
        "contactToleranceMm",
        "clearanceToleranceMm",
        "maximumUnexpectedOverlapMm3",
        "curveToleranceMm",
        "maxChordErrorMm",
    ):
        _require(isinstance(validation.get(field), (int, float)) and validation[field] >= 0, f"{field} is invalid")
    _require(validation.get("forbiddenExternalTokens") and isinstance(validation["forbiddenExternalTokens"], list), "external token guard is missing")
    tile_lap = validation.get("tileLap", {})
    _require(
        isinstance(tile_lap.get("interfaceToleranceMm"), (int, float))
        and isinstance(tile_lap.get("minimumVisibleStepMm"), (int, float))
        and isinstance(tile_lap.get("samplesPerOverlap"), int)
        and tile_lap["samplesPerOverlap"] >= 3,
        "tile lap validation policy is incomplete",
    )
    coverage = validation.get("roofCoverage", {})
    for field in ("sampleSpacingX", "sampleSpacingY", "edgeMarginX", "edgeMarginY", "rayClearanceMm", "rayDepthMm"):
        _require(isinstance(coverage.get(field), (int, float)) and coverage[field] > 0, f"roofCoverage.{field} is invalid")
    _require(isinstance(coverage.get("maximumUncoveredSamples"), int) and coverage["maximumUncoveredSamples"] >= 0, "roofCoverage.maximumUncoveredSamples is invalid")

    known = fixture["knownAnswers"]
    _require_sha(known.get("geometrySignature"), "knownAnswers.geometrySignature", allow_unfrozen)
    _require_sha(known.get("sourceMeshBundleSha256"), "knownAnswers.sourceMeshBundleSha256", allow_unfrozen)
    if allow_unfrozen and known.get("geometrySignature") == "UNFROZEN":
        _require(fixture["geometryRevisionId"] == "UNFROZEN", "unfrozen fixture must use an unfrozen revision")
    else:
        _require(fixture["geometryRevisionId"] == expected_geometry_revision(known["geometrySignature"]), "geometryRevisionId must derive from geometrySignature")
    _require(fixture["acceptance"] == {"status": "generated-not-qualified", "L1": False, "formalEligibility": "ineligible"}, "acceptance boundary is invalid")
    return fixture


def load_fixture(path: Path, *, allow_unfrozen: bool = False) -> dict:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    return validate_fixture(fixture, allow_unfrozen=allow_unfrozen)


def sanitized_generation_input(fixture: dict) -> dict:
    validated = validate_fixture(deepcopy(fixture), allow_unfrozen=True)
    allowed = {
        "schemaVersion",
        "projectId",
        "fixtureId",
        "geometryRevisionId",
        "producerType",
        "formalEligibility",
        "unit",
        "coordinateSystem",
        "sourceRefs",
        "referenceIsolation",
        "scope",
        "materials",
        "assembly",
        "parameterTypeRegistry",
        "unknownRegistry",
        "dimensionFacts",
        "geometryValidation",
        "componentTemplates",
        "requiredComponentTypes",
        "interfaceTemplates",
        "requiredInterfaceRoles",
        "observationCandidates",
        "protectionRecommendationCandidates",
        "acceptance",
    }
    return {key: deepcopy(validated[key]) for key in allowed}
