from __future__ import annotations

from dataclasses import asdict, dataclass
from hashlib import sha256
import json
from pathlib import Path
import uuid

import ifcopenshell.guid


NAMESPACE = uuid.UUID("7b0b6bf8-6520-5adb-91cb-90a89f29e52d")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_spec(path: Path) -> dict:
    spec = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "schemaVersion",
        "projectId",
        "name",
        "producerType",
        "fixtureId",
        "unit",
        "bays",
        "depth",
        "plinthHeight",
        "eaveHeight",
        "ridgeHeight",
        "roofOverhang",
        "roofThickness",
        "columnSize",
        "beamWidth",
        "beamDepth",
        "sectionX",
        "site",
        "frontOpenings",
    }
    missing = sorted(required - spec.keys())
    if missing:
        raise ValueError(f"missing spec fields: {', '.join(missing)}")
    if spec["producerType"] != "demo":
        raise ValueError("T0 fixture must use producerType=demo")
    if spec["unit"] != "mm":
        raise ValueError("T0 fixture currently requires millimetres")
    if len(spec["bays"]) < 3 or any(float(v) <= 0 for v in spec["bays"]):
        raise ValueError("bays must contain at least three positive spans")
    width = sum(float(v) for v in spec["bays"])
    if not 0 < float(spec["sectionX"]) < width:
        raise ValueError("sectionX must lie inside the building")
    if float(spec["ridgeHeight"]) <= float(spec["eaveHeight"]):
        raise ValueError("ridgeHeight must be above eaveHeight")
    return spec


def spec_hash(spec: dict) -> str:
    return sha256(canonical_json(spec).encode("utf-8")).hexdigest()


def stable_uuid(spec: dict, key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{spec['projectId']}:{key}"))


def stable_ifc_guid(spec: dict, key: str) -> str:
    return ifcopenshell.guid.compress(uuid.UUID(stable_uuid(spec, key)).hex)


@dataclass(frozen=True)
class BoxObject:
    key: str
    entity_id: str
    ifc_guid: str
    ifc_class: str
    name: str
    center_mm: tuple[float, float, float]
    size_mm: tuple[float, float, float]
    colour: tuple[int, int, int]
    producer_type: str = "demo"


@dataclass(frozen=True)
class MeshObject:
    key: str
    entity_id: str
    ifc_guid: str
    ifc_class: str
    name: str
    vertices_mm: tuple[tuple[float, float, float], ...]
    faces: tuple[tuple[int, int, int], ...]
    colour: tuple[int, int, int]
    producer_type: str = "demo"


def _box(spec: dict, key: str, ifc_class: str, name: str, center, size, colour) -> BoxObject:
    return BoxObject(
        key=key,
        entity_id=stable_uuid(spec, key),
        ifc_guid=stable_ifc_guid(spec, key),
        ifc_class=ifc_class,
        name=name,
        center_mm=tuple(float(v) for v in center),
        size_mm=tuple(float(v) for v in size),
        colour=colour,
    )


def _sloped_prism(spec: dict, key: str, name: str, x0, x1, y0, y1, z0, z1, thickness) -> MeshObject:
    bottom = (
        (x0, y0, z0),
        (x1, y0, z0),
        (x1, y1, z1),
        (x0, y1, z1),
    )
    top = tuple((x, y, z + thickness) for x, y, z in bottom)
    vertices = bottom + top
    faces = (
        (0, 2, 1), (0, 3, 2),
        (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4),
        (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6),
        (3, 0, 4), (3, 4, 7),
    )
    return MeshObject(
        key=key,
        entity_id=stable_uuid(spec, key),
        ifc_guid=stable_ifc_guid(spec, key),
        ifc_class="IfcSlab",
        name=name,
        vertices_mm=tuple(tuple(float(v) for v in point) for point in vertices),
        faces=faces,
        colour=(92, 102, 112),
    )


def grid_x(spec: dict) -> list[float]:
    result = [0.0]
    for bay in spec["bays"]:
        result.append(result[-1] + float(bay))
    return result


def build_objects(spec: dict) -> list[BoxObject | MeshObject]:
    xs = grid_x(spec)
    width = xs[-1]
    depth = float(spec["depth"])
    plinth = float(spec["plinthHeight"])
    eave = float(spec["eaveHeight"])
    ridge = float(spec["ridgeHeight"])
    column = float(spec["columnSize"])
    beam_w = float(spec["beamWidth"])
    beam_d = float(spec["beamDepth"])
    overhang = float(spec["roofOverhang"])
    objects: list[BoxObject | MeshObject] = []

    objects.append(_box(spec, "slab:ground", "IfcSlab", "台基", (width / 2, depth / 2, plinth / 2), (width + 800, depth + 800, plinth), (176, 170, 158)))

    for row_name, y in (("south", 0.0), ("north", depth)):
        for index, x in enumerate(xs):
            objects.append(_box(
                spec,
                f"column:{row_name}:{index}",
                "IfcColumn",
                f"{row_name} column {index + 1}",
                (x, y, plinth + (eave - plinth) / 2),
                (column, column, eave - plinth),
                (126, 76, 48),
            ))

    for row_name, y in (("south", 0.0), ("north", depth)):
        for index, span in enumerate(spec["bays"]):
            x0, x1 = xs[index], xs[index + 1]
            objects.append(_box(
                spec,
                f"beam:{row_name}:{index}",
                "IfcBeam",
                f"{row_name} beam {index + 1}",
                ((x0 + x1) / 2, y, eave - beam_d / 2),
                (float(span), beam_w, beam_d),
                (112, 66, 42),
            ))

    for side_name, x in (("west", 0.0), ("east", width)):
        objects.append(_box(
            spec,
            f"beam:{side_name}",
            "IfcBeam",
            f"{side_name} tie beam",
            (x, depth / 2, eave - beam_d / 2),
            (beam_w, depth, beam_d),
            (112, 66, 42),
        ))

    for index, opening in enumerate(spec["frontOpenings"]):
        bay_index = int(opening["bayIndex"])
        x0, x1 = xs[bay_index], xs[bay_index + 1]
        center_x = (x0 + x1) / 2
        sill = float(opening["sill"])
        height = float(opening["height"])
        kind = str(opening["kind"])
        ifc_class = "IfcDoor" if kind == "door" else "IfcWindow"
        objects.append(_box(
            spec,
            f"opening:{kind}:{index}",
            ifc_class,
            f"front {kind} {index + 1}",
            (center_x, 90, plinth + sill + height / 2),
            (float(opening["width"]), 120, height),
            (72, 94, 108) if kind == "window" else (92, 56, 36),
        ))

    mid_y = depth / 2
    objects.append(_sloped_prism(spec, "roof:south", "南坡屋面", -overhang, width + overhang, -overhang, mid_y, eave, ridge, float(spec["roofThickness"])))
    objects.append(_sloped_prism(spec, "roof:north", "北坡屋面", -overhang, width + overhang, mid_y, depth + overhang, ridge, eave, float(spec["roofThickness"])))
    return objects


def _rect(x: float, y: float, width: float, height: float, layer: str, entity_id: str | None = None) -> dict:
    return {"kind": "rect", "x": x, "y": y, "width": width, "height": height, "layer": layer, "entityId": entity_id}


def _polyline(points, layer: str, entity_id: str | None = None, closed: bool = False) -> dict:
    return {"kind": "polyline", "points": [[float(x), float(y)] for x, y in points], "layer": layer, "entityId": entity_id, "closed": closed}


def build_views(spec: dict, objects: list[BoxObject | MeshObject]) -> dict[str, list[dict]]:
    xs = grid_x(spec)
    width = xs[-1]
    depth = float(spec["depth"])
    plinth = float(spec["plinthHeight"])
    eave = float(spec["eaveHeight"])
    ridge = float(spec["ridgeHeight"])
    overhang = float(spec["roofOverhang"])
    column = float(spec["columnSize"])
    beam_w = float(spec["beamWidth"])
    beam_d = float(spec["beamDepth"])
    by_key = {item.key: item.entity_id for item in objects}

    plan: list[dict] = [_rect(0, 0, width, depth, "A-WALL", by_key["slab:ground"])]
    plan.append(_rect(-overhang, -overhang, width + 2 * overhang, depth + 2 * overhang, "A-ROOF", by_key["roof:south"]))
    plan.append(_polyline(((-overhang, depth / 2), (width + overhang, depth / 2)), "A-ROOF", by_key["roof:north"]))
    for row_name, y in (("south", 0.0), ("north", depth)):
        for index, span in enumerate(spec["bays"]):
            plan.append(_rect(xs[index], y - beam_w / 2, float(span), beam_w, "A-BEAM", by_key[f"beam:{row_name}:{index}"]))
    plan.append(_rect(-beam_w / 2, 0, beam_w, depth, "A-BEAM", by_key["beam:west"]))
    plan.append(_rect(width - beam_w / 2, 0, beam_w, depth, "A-BEAM", by_key["beam:east"]))
    for row_name, y in (("south", 0.0), ("north", depth)):
        for index, x in enumerate(xs):
            plan.append(_rect(x - column / 2, y - column / 2, column, column, "A-COLS", by_key[f"column:{row_name}:{index}"]))
    for index, x in enumerate(xs):
        plan.append(_polyline(((x, -1200), (x, depth + 1200)), "A-GRID"))
    plan.extend((_polyline(((-1200, 0), (width + 1200, 0)), "A-GRID"), _polyline(((-1200, depth), (width + 1200, depth)), "A-GRID")))
    for index, opening in enumerate(spec["frontOpenings"]):
        bay_index = int(opening["bayIndex"])
        center = (xs[bay_index] + xs[bay_index + 1]) / 2
        half = float(opening["width"]) / 2
        plan.append(_polyline(((center - half, 0), (center + half, 0)), "A-OPEN", by_key[f"opening:{opening['kind']}:{index}"]))

    elevation: list[dict] = [
        _polyline(((-400, 0), (width + 400, 0)), "A-GROUND"),
        _rect(-400, 0, width + 800, plinth, "A-WALL", by_key["slab:ground"]),
        _polyline(((-overhang, eave), (width / 2, ridge), (width + overhang, eave)), "A-ROOF"),
    ]
    for index, x in enumerate(xs):
        elevation.append(_rect(x - column / 2, plinth, column, eave - plinth, "A-COLS", by_key[f"column:south:{index}"]))
    elevation.append(_rect(0, eave - beam_d, width, beam_d, "A-BEAM"))
    for index, opening in enumerate(spec["frontOpenings"]):
        bay_index = int(opening["bayIndex"])
        center = (xs[bay_index] + xs[bay_index + 1]) / 2
        elevation.append(_rect(center - float(opening["width"]) / 2, plinth + float(opening["sill"]), float(opening["width"]), float(opening["height"]), "A-OPEN", by_key[f"opening:{opening['kind']}:{index}"]))

    section: list[dict] = [
        _polyline(((-400, 0), (depth + 400, 0)), "A-GROUND"),
        _rect(-400, 0, depth + 800, plinth, "A-WALL", by_key["slab:ground"]),
        _polyline(((-overhang, eave), (depth / 2, ridge)), "A-ROOF", by_key["roof:south"]),
        _polyline(((depth / 2, ridge), (depth + overhang, eave)), "A-ROOF", by_key["roof:north"]),
        _rect(-column / 2, plinth, column, eave - plinth, "A-COLS"),
        _rect(depth - column / 2, plinth, column, eave - plinth, "A-COLS"),
        _rect(0, eave - beam_d, depth, beam_d, "A-BEAM"),
    ]
    return {"plan": plan, "elevation": elevation, "section": section}


def serialise_geometry(spec: dict, objects: list[BoxObject | MeshObject], views: dict) -> dict:
    return {
        "schemaVersion": "t0-geometry-output-1",
        "projectId": spec["projectId"],
        "specHash": spec_hash(spec),
        "producerType": "demo",
        "fixtureId": spec["fixtureId"],
        "objects": [asdict(item) | {"type": item.__class__.__name__} for item in objects],
        "views": views,
    }
