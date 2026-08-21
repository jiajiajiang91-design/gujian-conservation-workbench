from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any


SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
EXACT_RE = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:/(?:[1-9]\d*))?$")
FORBIDDEN_INPUT_KEYS = {"path", "url", "prompt", "projectName", "sampleName"}


class ContractError(ValueError):
    pass


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def geometry_spec_input_hash(spec: dict[str, Any]) -> str:
    copy = json.loads(json.dumps(spec))
    copy["inputHash"] = "0" * 64
    return sha256_bytes(canonical_bytes(copy))


def _uuid(value: Any, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ContractError(f"{field} must be a UUID") from error


def _exact(value: Any, field: str) -> float:
    if not isinstance(value, str) or not EXACT_RE.fullmatch(value):
        raise ContractError(f"{field} must be an exact number string")
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        return float(numerator) / float(denominator)
    return float(value)


def _scan_forbidden(value: Any, trail: tuple[str, ...] = ()) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FORBIDDEN_INPUT_KEYS:
                raise ContractError(f"forbidden input field: {'.'.join((*trail, key))}")
            _scan_forbidden(child, (*trail, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _scan_forbidden(child, (*trail, str(index)))
    elif isinstance(value, str):
        lowered = value.lower()
        if re.match(r"^[a-z]:[\\/]", value, re.I) or value.startswith(("/", "\\\\")):
            raise ContractError(f"absolute path is forbidden at {'.'.join(trail)}")
        if lowered.startswith(("http://", "https://", "file://")):
            raise ContractError(f"URL is forbidden at {'.'.join(trail)}")
        if lowered.endswith((".dwg", ".dwt")):
            raise ContractError(f"external CAD input is forbidden at {'.'.join(trail)}")


def validate_geometry_spec(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schemaVersion") != "2.0":
        raise ContractError("project geometry spec schemaVersion must be 2.0")
    _scan_forbidden(value)
    for key in ("id", "projectId", "projectRevisionId", "buildingId"):
        _uuid(value.get(key), key)
    if not SHA256_RE.fullmatch(str(value.get("inputHash", ""))):
        raise ContractError("inputHash must be SHA-256")
    if geometry_spec_input_hash(value) != value["inputHash"]:
        raise ContractError("inputHash does not match canonical GeometrySpec")
    coordinate = value.get("coordinateSystem")
    if not isinstance(coordinate, dict) or coordinate.get("axisOrder") != "XYZ" or coordinate.get("upAxis") != "Z" or coordinate.get("lengthUnit") != "mm":
        raise ContractError("coordinate system must be XYZ, Z-up and millimetres")
    tolerances = value.get("tolerances")
    if not isinstance(tolerances, dict) or any(not isinstance(tolerances.get(key), (int, float)) or tolerances[key] <= 0 for key in ("modellingMm", "interfaceMm", "tessellationMm")):
        raise ContractError("positive tolerances are required")
    objects = value.get("objects")
    if not isinstance(objects, list) or not objects:
        raise ContractError("at least one geometry object is required")
    object_ids: set[str] = set()
    stable_keys: set[str] = set()
    for index, item in enumerate(objects):
        if not isinstance(item, dict):
            raise ContractError(f"objects[{index}] must be an object")
        object_id = _uuid(item.get("id"), f"objects[{index}].id")
        stable_key = item.get("stableKey")
        if object_id in object_ids or not isinstance(stable_key, str) or not stable_key or stable_key in stable_keys:
            raise ContractError("geometry object ids and stable keys must be unique")
        object_ids.add(object_id)
        stable_keys.add(stable_key)
        solid = item.get("solid")
        if not isinstance(solid, dict) or solid.get("kind") not in {"box", "cylinder", "extrudedProfile"}:
            raise ContractError(f"objects[{index}].solid is unsupported")
        for field in ({"box": ("sizeX", "sizeY", "sizeZ"), "cylinder": ("radius", "height"), "extrudedProfile": ("depth",)}[solid["kind"]]):
            if _exact(solid.get(field), f"objects[{index}].solid.{field}") <= 0:
                raise ContractError("solid dimensions must be positive")
        parameters = item.get("parameters")
        if not isinstance(parameters, list):
            raise ContractError("parameters must be an array")
        for parameter in parameters:
            value_type = parameter.get("valueType") if isinstance(parameter, dict) else None
            expected_unit = {"length": "mm", "angle": "deg", "count": "1", "ratio": "1", "text": "1"}.get(value_type)
            if expected_unit is None or parameter.get("unit") != expected_unit:
                raise ContractError("typed parameter unit does not match its valueType")
            if value_type == "count" and (not isinstance(parameter.get("value"), int) or parameter["value"] < 0):
                raise ContractError("count parameter must be a non-negative integer")
            if value_type in {"length", "angle", "ratio"}:
                _exact(parameter.get("exactValue"), "parameter.exactValue")
    unknowns = value.get("unknowns")
    if not isinstance(unknowns, list):
        raise ContractError("unknowns must be an array")
    unknown_ids = {_uuid(item.get("id"), "unknown.id") for item in unknowns if isinstance(item, dict)}
    if len(unknown_ids) != len(unknowns):
        raise ContractError("unknown ids must be unique")
    for item in objects:
        if item.get("parentId") is not None and str(item["parentId"]) not in object_ids:
            raise ContractError("parent object is missing")
        if any(str(ref) not in unknown_ids for ref in item.get("unknownRefs", [])):
            raise ContractError("object unknown reference is missing")
    interface_ids: set[str] = set()
    interfaces = value.get("interfaces")
    if not isinstance(interfaces, list):
        raise ContractError("interfaces must be an array")
    for index, item in enumerate(interfaces):
        interface_id = _uuid(item.get("id"), f"interfaces[{index}].id")
        if interface_id in interface_ids or item.get("fromObjectId") not in object_ids or item.get("toObjectId") not in object_ids or item.get("fromObjectId") == item.get("toObjectId"):
            raise ContractError("interface closure is invalid")
        interface_ids.add(interface_id)
        if item.get("interfaceType") not in {"contact", "bearing", "containment", "lap"}:
            raise ContractError("interface type is invalid")
    return value


def load_geometry_spec(path: Path) -> dict[str, Any]:
    return validate_geometry_spec(json.loads(path.read_text(encoding="utf-8")))
