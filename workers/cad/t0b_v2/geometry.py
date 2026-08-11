from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient
from shapely.ops import triangulate
import trimesh

from .contracts import REQUIRED_COMPONENT_TYPES, validate_fixture


TYPE_NAMESPACE = UUID("743bca5e-bb31-5447-a47e-b6a56f92e871")
ENTITY_NAMESPACE = UUID("f63437b9-e1c7-5745-b768-17fe3bc73921")
MATERIAL_NAMESPACE = UUID("4b89c177-7dbe-5838-8f5f-a5055af1b321")
MATERIAL_COLORS = {
    "stone-demo": [184, 184, 176, 255],
    "earth-demo": [166, 148, 120, 255],
    "timber-demo": [116, 45, 36, 255],
    "ceramic-demo": [54, 58, 61, 255],
}

MESH_HASH_PRECISION_MM = 3


@dataclass
class SemanticMesh:
    entity_id: str
    type_id: str
    key: str
    component_type: str
    material_id: str
    material_code: str
    geometry_status: str
    source_refs: list[str]
    mesh: trimesh.Trimesh

    def record(self) -> dict:
        bounds = np.asarray(self.mesh.bounds, dtype=float)
        centroid = np.asarray(self.mesh.centroid, dtype=float)
        return {
            "entityId": self.entity_id,
            "typeId": self.type_id,
            "key": self.key,
            "componentType": self.component_type,
            "materialId": self.material_id,
            "materialCode": self.material_code,
            "geometryStatus": self.geometry_status,
            "sourceRefs": self.source_refs,
            "bounds": np.round(bounds, 6).tolist(),
            "centroid": np.round(centroid, 6).tolist(),
            "volume": round(float(abs(self.mesh.volume)), 6),
            "vertices": int(len(self.mesh.vertices)),
            "faces": int(len(self.mesh.faces)),
            "watertight": bool(self.mesh.is_watertight),
            "meshHash": _canonical_mesh_hash(self.mesh),
            "meshHashPrecisionMm": 10 ** -MESH_HASH_PRECISION_MM,
        }


@dataclass(frozen=True)
class GeometryRelation:
    from_entity_id: str
    relation: str
    to_entity_id: str

    def record(self) -> dict:
        return {
            "fromEntityId": self.from_entity_id,
            "relation": self.relation,
            "toEntityId": self.to_entity_id,
        }


@dataclass
class GeometryModel:
    project_id: str
    fixture_id: str
    geometry_revision_id: str
    unit: str
    producer_type: str
    source_refs: list[str]
    entities: list[SemanticMesh]
    relations: list[GeometryRelation]

    def manifest(self) -> dict:
        entity_records = [item.record() for item in sorted(self.entities, key=lambda item: item.entity_id)]
        relation_records = [item.record() for item in sorted(self.relations, key=lambda item: (item.from_entity_id, item.relation, item.to_entity_id))]
        signature_payload = {"entities": entity_records, "relations": relation_records}
        signature = sha256(json.dumps(signature_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {
            "schemaVersion": "t0b-v2-geometry-1",
            "projectId": self.project_id,
            "fixtureId": self.fixture_id,
            "geometryRevisionId": self.geometry_revision_id,
            "unit": self.unit,
            "producerType": self.producer_type,
            "sourceRefs": self.source_refs,
            "geometrySignature": signature,
            "entities": entity_records,
            "relations": relation_records,
        }


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _stable_id(namespace: UUID, *parts: object) -> str:
    return str(uuid5(namespace, ":".join(str(part) for part in parts)))


def _canonical_mesh_hash(mesh: trimesh.Trimesh) -> str:
    vertices = np.round(np.asarray(mesh.vertices, dtype=float), MESH_HASH_PRECISION_MM)
    vertex_records = sorted(tuple(float(value) for value in vertex) for vertex in vertices)
    triangle_records = []
    for face in np.asarray(mesh.faces, dtype=int):
        triangle_records.append(sorted(tuple(float(value) for value in vertices[index]) for index in face))
    payload = {"vertices": vertex_records, "triangles": sorted(triangle_records)}
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _box(center: tuple[float, float, float], extents: tuple[float, float, float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.box(extents=np.asarray(extents, dtype=float))
    mesh.apply_translation(np.asarray(center, dtype=float))
    return mesh


def _frustum(center: tuple[float, float, float], bottom_radius: float, top_radius: float, height: float, sections: int) -> trimesh.Trimesh:
    angles = np.linspace(0.0, math.tau, sections, endpoint=False)
    bottom = np.column_stack((np.cos(angles) * bottom_radius, np.sin(angles) * bottom_radius, np.full(sections, -height / 2)))
    top = np.column_stack((np.cos(angles) * top_radius, np.sin(angles) * top_radius, np.full(sections, height / 2)))
    vertices = np.vstack((bottom, top, [[0, 0, -height / 2], [0, 0, height / 2]]))
    faces: list[tuple[int, int, int]] = []
    for index in range(sections):
        nxt = (index + 1) % sections
        faces.extend(((index, nxt, sections + nxt), (index, sections + nxt, sections + index)))
        faces.append((2 * sections, nxt, index))
        faces.append((2 * sections + 1, sections + index, sections + nxt))
    mesh = trimesh.Trimesh(vertices=vertices, faces=np.asarray(faces), process=True)
    mesh.apply_translation(np.asarray(center, dtype=float))
    return mesh


def _stacked_revolved_profile(profile: list[list[float]], sections: int) -> trimesh.Trimesh:
    parts: list[trimesh.Trimesh] = []
    for (bottom_radius, bottom_z), (top_radius, top_z) in zip(profile, profile[1:]):
        height = float(top_z - bottom_z)
        if height <= 0:
            raise ValueError("revolved profile heights must increase")
        parts.append(
            _frustum(
                (0.0, 0.0, float(bottom_z) + height / 2),
                float(bottom_radius),
                float(top_radius),
                height,
                sections,
            )
        )
    return trimesh.util.concatenate(parts)


def _profile_prism(profile: list[tuple[float, float]], depth: float, axis: str) -> trimesh.Trimesh:
    polygon = orient(Polygon(profile), sign=1.0)
    if not polygon.is_valid or polygon.area <= 0:
        raise ValueError("profile must be a valid positive polygon")
    triangles = [triangle for triangle in triangulate(polygon) if polygon.covers(triangle.representative_point())]
    coordinates: list[tuple[float, float]] = []
    index_by_coordinate: dict[tuple[float, float], int] = {}

    def index_of(point: tuple[float, float]) -> int:
        key = (round(point[0], 9), round(point[1], 9))
        if key not in index_by_coordinate:
            index_by_coordinate[key] = len(coordinates)
            coordinates.append(key)
        return index_by_coordinate[key]

    triangle_indices: list[tuple[int, int, int]] = []
    for triangle in triangles:
        coords = list(triangle.exterior.coords)[:3]
        if not triangle.exterior.is_ccw:
            coords.reverse()
        triangle_indices.append(tuple(index_of((float(x), float(y))) for x, y in coords))
    boundary = [index_of((float(x), float(y))) for x, y in list(polygon.exterior.coords)[:-1]]
    count = len(coordinates)
    vertices: list[list[float]] = []
    for side in (-depth / 2, depth / 2):
        for a, b in coordinates:
            vertices.append([a, side, b] if axis == "y" else [side, a, b])
    faces: list[tuple[int, int, int]] = []
    for a, b, c in triangle_indices:
        if axis == "y":
            faces.append((a, b, c))
            faces.append((a + count, c + count, b + count))
        else:
            faces.append((a, c, b))
            faces.append((a + count, b + count, c + count))
    for index, current in enumerate(boundary):
        nxt = boundary[(index + 1) % len(boundary)]
        if axis == "y":
            faces.extend(((current, current + count, nxt + count), (current, nxt + count, nxt)))
        else:
            faces.extend(((current, nxt, nxt + count), (current, nxt + count, current + count)))
    return trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)


def _segment_prism(start: np.ndarray, end: np.ndarray, width: float, thickness: float) -> trimesh.Trimesh:
    vector = np.asarray(end, dtype=float) - np.asarray(start, dtype=float)
    length = float(np.linalg.norm(vector))
    if length <= 0:
        raise ValueError("segment length must be positive")
    tangent = vector / length
    across = np.array([1.0, 0.0, 0.0])
    if abs(float(np.dot(across, tangent))) > 0.95:
        across = np.array([0.0, 1.0, 0.0])
    normal = np.cross(tangent, across)
    normal /= np.linalg.norm(normal)
    across = np.cross(normal, tangent)
    across /= np.linalg.norm(across)
    transform = np.eye(4)
    transform[:3, :3] = np.column_stack((across, normal, tangent))
    transform[:3, 3] = (np.asarray(start, dtype=float) + np.asarray(end, dtype=float)) / 2
    mesh = trimesh.creation.box(extents=[width, thickness, length])
    mesh.apply_transform(transform)
    return mesh


def _roof_panel(start: np.ndarray, end: np.ndarray, width: float, thickness: float) -> trimesh.Trimesh:
    return _segment_prism(start, end, width, thickness)


def _roof_curve_value(curve: dict, y: float) -> float:
    half_span = float(curve["halfSpan"])
    t = max(0.0, abs(float(y)) / half_span)
    drop = sum(float(coefficient) * t ** power for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"]))
    return float(curve["ridgeHeight"] - drop)


def _roof_curve_slope(curve: dict, y: float, ridge_side: float | None = None) -> float:
    half_span = float(curve["halfSpan"])
    t = max(0.0, abs(float(y)) / half_span)
    derivative = sum(power * float(coefficient) * t ** (power - 1) for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"]))
    if y < 0:
        side = -1.0
    elif y > 0:
        side = 1.0
    else:
        side = float(ridge_side or 0.0)
    return float(-side * derivative / half_span)


def _roof_frame(curve: dict, y: float, ridge_side: float | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    across = np.asarray([1.0, 0.0, 0.0])
    tangent = np.asarray([0.0, 1.0, _roof_curve_slope(curve, y, ridge_side)], dtype=float)
    tangent /= np.linalg.norm(tangent)
    normal = np.cross(across, tangent)
    normal /= np.linalg.norm(normal)
    if normal[2] < 0:
        normal *= -1
    return across, tangent, normal


def _roof_point(
    curve: dict,
    y: float,
    x: float = 0.0,
    normal_offset: float = 0.0,
    ridge_side: float | None = None,
) -> np.ndarray:
    _, _, normal = _roof_frame(curve, y, ridge_side)
    return np.asarray([x, y, _roof_curve_value(curve, y)], dtype=float) + normal * normal_offset


def _roof_path(curve: dict, start_y: float, end_y: float, x: float, normal_offset: float, step_mm: float | None = None) -> list[np.ndarray]:
    step = float(step_mm or curve["sampleStepMm"])
    count = max(2, int(math.ceil(abs(end_y - start_y) / step)) + 1)
    ridge_side = -1.0 if (start_y + end_y) / 2 < 0 else 1.0
    return [_roof_point(curve, float(y), x, normal_offset, ridge_side) for y in np.linspace(start_y, end_y, count)]


def _path_prism(points: list[np.ndarray], width: float, thickness: float) -> trimesh.Trimesh:
    if len(points) < 2:
        raise ValueError("path prism requires at least two points")
    vertices: list[np.ndarray] = []
    for index, point in enumerate(points):
        if index == 0:
            tangent = points[1] - point
        elif index == len(points) - 1:
            tangent = point - points[index - 1]
        else:
            tangent = points[index + 1] - points[index - 1]
        tangent /= np.linalg.norm(tangent)
        across = np.asarray([1.0, 0.0, 0.0])
        normal = np.cross(across, tangent)
        normal /= np.linalg.norm(normal)
        if normal[2] < 0:
            normal *= -1
        vertices.extend(
            (
                point - across * width / 2 - normal * thickness / 2,
                point + across * width / 2 - normal * thickness / 2,
                point + across * width / 2 + normal * thickness / 2,
                point - across * width / 2 + normal * thickness / 2,
            )
        )
    faces: list[tuple[int, int, int]] = []
    for index in range(len(points) - 1):
        current = index * 4
        nxt = (index + 1) * 4
        for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
            faces.extend(((current + a, current + b, nxt + b), (current + a, nxt + b, nxt + a)))
    faces.extend(((0, 2, 1), (0, 3, 2)))
    last = (len(points) - 1) * 4
    faces.extend(((last, last + 1, last + 2), (last, last + 2, last + 3)))
    return trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)


def _curved_tile(width: float, rise: float, thickness: float, length: float, convex: bool, sections: int = 12) -> trimesh.Trimesh:
    xs = np.linspace(-width / 2, width / 2, sections + 1)
    ratio = xs / (width / 2)
    surface = rise * (1.0 - ratio**2) if convex else rise * ratio**2
    bottom = surface - thickness
    vertices: list[list[float]] = []
    for y in (-length / 2, length / 2):
        vertices.extend([[float(x), y, float(z)] for x, z in zip(xs, surface)])
        vertices.extend([[float(x), y, float(z)] for x, z in zip(xs, bottom)])
    row = sections + 1
    top_front = 0
    bottom_front = row
    top_back = row * 2
    bottom_back = row * 3
    faces: list[tuple[int, int, int]] = []
    for index in range(sections):
        nxt = index + 1
        faces.extend(
            (
                (top_front + index, top_front + nxt, top_back + nxt),
                (top_front + index, top_back + nxt, top_back + index),
                (bottom_front + index, bottom_back + index, bottom_back + nxt),
                (bottom_front + index, bottom_back + nxt, bottom_front + nxt),
                (top_front + index, bottom_front + index, bottom_front + nxt),
                (top_front + index, bottom_front + nxt, top_front + nxt),
                (top_back + index, top_back + nxt, bottom_back + nxt),
                (top_back + index, bottom_back + nxt, bottom_back + index),
            )
        )
    faces.extend(
        (
            (top_front, top_back, bottom_back),
            (top_front, bottom_back, bottom_front),
            (top_front + sections, bottom_front + sections, bottom_back + sections),
            (top_front + sections, bottom_back + sections, top_back + sections),
        )
    )
    return trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)


def _curved_roof_tile(
    width: float,
    rise: float,
    thickness: float,
    length: float,
    overlap: float,
    lap_depth: float,
    lap_transition: float,
    convex: bool,
    curve: dict,
    x: float,
    y: float,
    normal_offset: float,
    cross_sections: int = 12,
    longitudinal_sections: int = 6,
) -> trimesh.Trimesh:
    """Build one lapped tile as a solid swept over one side of the roof."""
    xs = np.linspace(-width / 2, width / 2, cross_sections + 1)
    side = -1.0 if y < 0 else 1.0
    center_distance = abs(float(y))
    start_distance = max(0.0, center_distance - length / 2)
    end_distance = center_distance + length / 2
    tail_end = min(end_distance, start_distance + overlap)
    transition_end = min(end_distance, tail_end + lap_transition)
    tail_distances = np.linspace(start_distance, tail_end, 3)
    body_distances = np.linspace(transition_end, end_distance, longitudinal_sections + 1)
    stations = [(float(distance), -lap_depth) for distance in tail_distances]
    stations.extend((float(distance), 0.0) for distance in body_distances)
    ratio = xs / (width / 2)
    surface = rise * (1.0 - ratio**2) if convex else rise * ratio**2
    bottom = surface - thickness
    row = cross_sections + 1
    layer = row * len(stations)
    vertices: list[np.ndarray] = []
    for local_z in (surface, bottom):
        for distance, lap_offset in stations:
            path_y = side * distance
            _, _, normal = _roof_frame(curve, path_y, side)
            base = _roof_point(curve, path_y, x, normal_offset, side)
            vertices.extend(
                base + np.asarray([local_x, 0.0, 0.0]) + normal * (float(z) + lap_offset)
                for local_x, z in zip(xs, local_z)
            )

    def top(y_index: int, x_index: int) -> int:
        return y_index * row + x_index

    def lower(y_index: int, x_index: int) -> int:
        return layer + y_index * row + x_index

    faces: list[tuple[int, int, int]] = []
    longitudinal_count = len(stations) - 1
    for y_index in range(longitudinal_count):
        for x_index in range(cross_sections):
            faces.extend(
                (
                    (top(y_index, x_index), top(y_index, x_index + 1), top(y_index + 1, x_index + 1)),
                    (top(y_index, x_index), top(y_index + 1, x_index + 1), top(y_index + 1, x_index)),
                    (lower(y_index, x_index), lower(y_index + 1, x_index + 1), lower(y_index, x_index + 1)),
                    (lower(y_index, x_index), lower(y_index + 1, x_index), lower(y_index + 1, x_index + 1)),
                )
            )
        faces.extend(
            (
                (top(y_index, 0), top(y_index + 1, 0), lower(y_index + 1, 0)),
                (top(y_index, 0), lower(y_index + 1, 0), lower(y_index, 0)),
                (top(y_index, cross_sections), lower(y_index + 1, cross_sections), top(y_index + 1, cross_sections)),
                (top(y_index, cross_sections), lower(y_index, cross_sections), lower(y_index + 1, cross_sections)),
            )
        )
    for x_index in range(cross_sections):
        faces.extend(
            (
                (top(0, x_index), lower(0, x_index + 1), top(0, x_index + 1)),
                (top(0, x_index), lower(0, x_index), lower(0, x_index + 1)),
                (top(longitudinal_count, x_index), top(longitudinal_count, x_index + 1), lower(longitudinal_count, x_index + 1)),
                (top(longitudinal_count, x_index), lower(longitudinal_count, x_index + 1), lower(longitudinal_count, x_index)),
            )
        )
    return trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)


def _orient_to_roof(mesh: trimesh.Trimesh, curve: dict, x: float, y: float, normal_offset: float) -> trimesh.Trimesh:
    across, tangent, normal = _roof_frame(curve, y)
    transform = np.eye(4)
    transform[:3, :3] = np.column_stack((across, tangent, normal))
    transform[:3, 3] = _roof_point(curve, y, x, normal_offset)
    result = mesh.copy()
    result.apply_transform(transform)
    return result


class GeometryBuilder:
    def __init__(self, fixture: dict):
        self.fixture = validate_fixture(fixture)
        self.entities: list[SemanticMesh] = []
        self.templates = fixture["componentTemplates"]
        self.purlin_centers: dict[int, np.ndarray] = {}

    def add(self, component_type: str, key: str, mesh: trimesh.Trimesh) -> SemanticMesh:
        template = self.templates[component_type]
        mesh = mesh.copy()
        mesh.remove_unreferenced_vertices()
        type_id = _stable_id(TYPE_NAMESPACE, self.fixture["fixtureId"], component_type, _canonical(template))
        entity_id = _stable_id(ENTITY_NAMESPACE, self.fixture["fixtureId"], key)
        material_code = template["materialCode"]
        material_id = _stable_id(MATERIAL_NAMESPACE, self.fixture["fixtureId"], material_code)
        record = SemanticMesh(
            entity_id=entity_id,
            type_id=type_id,
            key=key,
            component_type=component_type,
            material_id=material_id,
            material_code=material_code,
            geometry_status=template["geometryStatus"],
            source_refs=list(self.fixture["sourceRefs"]),
            mesh=mesh,
        )
        self.entities.append(record)
        return record

    def build(self) -> GeometryModel:
        self._build_ground_and_foundations()
        self._build_columns_and_beams()
        self._build_roof_structure()
        self._build_brackets()
        self._build_roof_finish()
        self._build_enclosure()
        relations = _build_relations(self.entities, self.fixture["connections"])
        model = GeometryModel(
            project_id=self.fixture["projectId"],
            fixture_id=self.fixture["fixtureId"],
            geometry_revision_id=self.fixture["geometryRevisionId"],
            unit=self.fixture["unit"],
            producer_type=self.fixture["producerType"],
            source_refs=list(self.fixture["sourceRefs"]),
            entities=self.entities,
            relations=relations,
        )
        validate_geometry(model, self.fixture)
        return model

    def _build_ground_and_foundations(self) -> None:
        levels = self.fixture["assembly"]["levels"]
        ground = self.templates["groundLayer"]["parameters"]
        for index in range(int(ground["layers"])):
            thickness = float(ground["thickness"]) / int(ground["layers"])
            center_z = -float(ground["thickness"]) + thickness * (index + 0.5)
            self.add("groundLayer", f"ground:layer:{index}", _box((0, 0, center_z), (ground["width"], ground["depth"], thickness)))

        footing = self.templates["foundation"]["parameters"]
        axis_x = self.fixture["assembly"]["axisX"]
        axis_y = self.fixture["assembly"]["axisY"]
        course_height = float(footing["height"]) / int(footing["courses"])
        for x_index, x in enumerate(axis_x):
            for y_index, y in enumerate(axis_y):
                for course in range(int(footing["courses"])):
                    reduction = course * 90
                    width = float(footing["width"]) - reduction
                    depth = float(footing["depth"]) - reduction
                    z = levels["foundationBottom"] + course_height * (course + 0.5)
                    self.add("foundation", f"foundation:{x_index}:{y_index}:course:{course}", _box((x, y, z), (width, depth, course_height)))

        terrace = self.templates["terrace"]["parameters"]
        course_height = float(terrace["courseHeight"])
        course_count = round(float(terrace["height"]) / course_height)
        for course in range(course_count):
            inset = (course_count - course - 1) * 40
            z = course_height * (course + 0.5)
            self.add("terrace", f"terrace:course:{course}", _box((0, 0, z), (terrace["width"] - inset * 2, terrace["depth"] - inset * 2, course_height)))

        step = self.templates["step"]["parameters"]
        for index in range(int(step["count"])):
            height = float(step["riser"]) * (index + 1)
            depth = float(step["tread"]) * (int(step["count"]) - index)
            center_y = -float(terrace["depth"]) / 2 - depth / 2 + float(step["tread"]) * index
            self.add("step", f"step:south:{index}", _box((0, center_y, height / 2), (step["width"], depth, height)))

    def _build_columns_and_beams(self) -> None:
        levels = self.fixture["assembly"]["levels"]
        axis_x = self.fixture["assembly"]["axisX"]
        axis_y = self.fixture["assembly"]["axisY"]
        base = self.templates["columnBase"]["parameters"]
        column = self.templates["column"]["parameters"]
        for x_index, x in enumerate(axis_x):
            for y_index, y in enumerate(axis_y):
                profile = [
                    [base["lowerDiameter"] / 2, 0],
                    [base["lowerDiameter"] / 2, 55],
                    [base["upperDiameter"] / 2 + 45, 100],
                    [base["upperDiameter"] / 2 + 45, 155],
                    [base["upperDiameter"] / 2, base["height"]],
                ]
                base_mesh = _stacked_revolved_profile(profile, sections=32)
                base_mesh.apply_translation([x, y, levels["terraceTop"]])
                self.add("columnBase", f"column-base:{x_index}:{y_index}", base_mesh)
                center_z = levels["terraceTop"] + base["height"] + column["height"] / 2
                column_mesh = _frustum((x, y, center_z), column["bottomDiameter"] / 2, column["topDiameter"] / 2, column["height"], int(column["facets"]))
                self.add("column", f"column:{x_index}:{y_index}", column_mesh)

        eave = self.templates["eaveBeam"]["parameters"]
        length_x = float(self.fixture["assembly"]["bayWidth"] + 900)
        profile_x = [
            (-length_x / 2, 0),
            (-length_x / 2, eave["height"] - eave["endNotchDepth"]),
            (-length_x / 2 + 180, eave["height"] - eave["endNotchDepth"]),
            (-length_x / 2 + 180, eave["height"]),
            (length_x / 2 - 180, eave["height"]),
            (length_x / 2 - 180, eave["height"] - eave["endNotchDepth"]),
            (length_x / 2, eave["height"] - eave["endNotchDepth"]),
            (length_x / 2, 0),
        ]
        for y_index, y in enumerate(axis_y):
            mesh = _profile_prism(profile_x, float(eave["width"]), "y")
            mesh.apply_translation([0, y, levels["columnTop"] - eave["height"]])
            self.add("eaveBeam", f"eave-beam:{y_index}", mesh)

        tie = self.templates["tieBeam"]["parameters"]
        length_y = float(self.fixture["assembly"]["depth"] + 400)
        profile_y = [
            (-length_y / 2, 0),
            (-length_y / 2, tie["height"] - tie["endNotchDepth"]),
            (-length_y / 2 + 160, tie["height"] - tie["endNotchDepth"]),
            (-length_y / 2 + 160, tie["height"]),
            (length_y / 2 - 160, tie["height"]),
            (length_y / 2 - 160, tie["height"] - tie["endNotchDepth"]),
            (length_y / 2, tie["height"] - tie["endNotchDepth"]),
            (length_y / 2, 0),
        ]
        for x_index, x in enumerate(axis_x):
            mesh = _profile_prism(profile_y, float(tie["width"]), "x")
            mesh.apply_translation([x, 0, levels["columnTop"] - tie["height"]])
            self.add("tieBeam", f"tie-beam:{x_index}", mesh)

    def _build_brackets(self) -> None:
        levels = self.fixture["assembly"]["levels"]
        axis_x = self.fixture["assembly"]["axisX"]
        axis_y = self.fixture["assembly"]["axisY"]
        eave = self.templates["eaveBeam"]["parameters"]

        seat = self.templates["bracketSeat"]["parameters"]
        arm = self.templates["bracketArm"]["parameters"]
        bearing = self.templates["bearingBlock"]["parameters"]
        socket_half = float(seat["socketWidth"]) / 2
        seat_profile = [
            (-seat["width"] / 2, 0),
            (seat["width"] / 2, 0),
            (seat["width"] / 2 - 70, seat["height"]),
            (socket_half, seat["height"]),
            (socket_half, seat["height"] - seat["socketDepth"]),
            (-socket_half, seat["height"] - seat["socketDepth"]),
            (-socket_half, seat["height"]),
            (-seat["width"] / 2 + 70, seat["height"]),
        ]
        arm_profile = [
            (-arm["length"] / 2, arm["endRise"]),
            (-arm["length"] / 2 + 140, 70),
            (-arm["neck"] / 2, 0),
            (arm["neck"] / 2, 0),
            (arm["length"] / 2 - 140, 70),
            (arm["length"] / 2, arm["endRise"]),
            (arm["length"] / 2 - 80, arm["endRise"] + arm["height"] * 0.35),
            (arm["neck"] / 2 + 80, arm["height"]),
            (-arm["neck"] / 2 - 80, arm["height"]),
            (-arm["length"] / 2 + 80, arm["endRise"] + arm["height"] * 0.35),
        ]
        for x_index, x in enumerate(axis_x):
            for y_index, y in enumerate(axis_y):
                seat_mesh = _profile_prism(seat_profile, seat["depth"], "y")
                seat_mesh.apply_translation([x, y, levels["columnTop"]])
                self.add("bracketSeat", f"bracket-seat:{x_index}:{y_index}", seat_mesh)
                arm_x = _profile_prism(arm_profile, arm["width"], "y")
                arm_base = levels["columnTop"] + seat["height"] - seat["socketDepth"]
                arm_x.apply_translation([x, y, arm_base])
                self.add("bracketArm", f"bracket-arm-x:{x_index}:{y_index}", arm_x)
                arm_y = _profile_prism(arm_profile, arm["width"], "x")
                arm_y.apply_translation([x, y, arm_base])
                self.add("bracketArm", f"bracket-arm-y:{x_index}:{y_index}", arm_y)

                purlin_center = self.purlin_centers[0 if y < 0 else 6]
                purlin_radius = self.templates["purlin"]["parameters"]["diameter"] / 2
                bearing_base = arm_base + arm["height"]
                shoulder_z = float(purlin_center[2]) - (purlin_radius - bearing["socketDepth"])
                body_height = shoulder_z - bearing_base
                if body_height < bearing["minimumBodyHeight"]:
                    raise ValueError("bearing block cannot reach the eave purlin without violating its minimum body height")
                groove_half = math.sqrt(2 * purlin_radius * bearing["socketDepth"] - bearing["socketDepth"] ** 2)
                groove_y = np.linspace(-groove_half, groove_half, 9)
                groove = [
                    (float(offset), float(purlin_center[2] - math.sqrt(purlin_radius**2 - offset**2) - bearing_base))
                    for offset in groove_y
                ]
                bearing_profile = [
                    (-bearing["depth"] / 2, 0),
                    (bearing["depth"] / 2, 0),
                    (bearing["depth"] / 2, body_height),
                    (groove_half, body_height),
                    *list(reversed(groove[1:-1])),
                    (-groove_half, body_height),
                    (-bearing["depth"] / 2, body_height),
                ]
                block = _profile_prism(bearing_profile, bearing["width"], "x")
                block.apply_translation([x, float(purlin_center[1]), bearing_base])
                self.add("bearingBlock", f"bearing-block:{x_index}:{y_index}", block)

    def _build_roof_structure(self) -> None:
        assembly = self.fixture["assembly"]
        curve = assembly["roofCurve"]
        roof_width = float(assembly["roofWidth"])
        board = self.templates["roofBoard"]["parameters"]
        rafter = self.templates["rafter"]["parameters"]
        purlin = self.templates["purlin"]["parameters"]
        y_positions = [-3000, -2400, -1200, 0, 1200, 2400, 3000]
        for index, y in enumerate(y_positions):
            center = _roof_point(curve, y, 0.0, -(board["thickness"] / 2 + rafter["height"] + purlin["diameter"] / 2))
            self.purlin_centers[index] = center
            mesh = trimesh.creation.cylinder(
                radius=purlin["diameter"] / 2,
                segment=[[-roof_width / 2, center[1], center[2]], [roof_width / 2, center[1], center[2]]],
                sections=int(purlin["facets"]),
            )
            self.add("purlin", f"purlin:{index}", mesh)

        post = self.templates["interiorPost"]["parameters"]
        tie_top = self.fixture["assembly"]["levels"]["columnTop"]
        for x_index, x in enumerate(assembly["axisX"]):
            for y_index, _ in enumerate(y_positions[1:-1]):
                purlin_center = self.purlin_centers[y_index + 1]
                target_z = float(purlin_center[2] - purlin["diameter"] / 2)
                height = target_z - tie_top
                if height <= 120:
                    continue
                groove_depth = float(post["socketDepth"])
                radius = purlin["diameter"] / 2
                groove_half = math.sqrt(2 * radius * groove_depth - groove_depth**2)
                groove_y = np.linspace(-groove_half, groove_half, 9)
                groove = [
                    (float(offset), float(purlin_center[2] - math.sqrt(radius**2 - offset**2) - tie_top))
                    for offset in groove_y
                ]
                post_profile = [
                    (-post["depth"] / 2, 0),
                    (post["depth"] / 2, 0),
                    (post["depth"] / 2, height + groove_depth),
                    (groove_half, height + groove_depth),
                    *list(reversed(groove[1:-1])),
                    (-groove_half, height + groove_depth),
                    (-post["depth"] / 2, height + groove_depth),
                ]
                mesh = _profile_prism(post_profile, post["width"], "x")
                mesh.apply_translation([x, float(purlin_center[1]), tie_top])
                self.add("interiorPost", f"interior-post:{x_index}:{y_index}", mesh)

        fly = self.templates["flyRafter"]["parameters"]
        x_positions = np.arange(-roof_width / 2 + rafter["width"] / 2, roof_width / 2, rafter["spacing"])
        for x_index, x in enumerate(x_positions):
            for side_name, start_y, end_y in (("south", -3000.0, 0.0), ("north", 0.0, 3000.0)):
                rafter_offset = -(board["thickness"] / 2 + rafter["height"] / 2)
                path = _roof_path(curve, start_y, end_y, float(x), rafter_offset)
                member = _path_prism(path, rafter["width"], rafter["height"])
                end_point = path[0] if side_name == "south" else path[-1]
                cap = trimesh.creation.cylinder(radius=rafter["height"] / 2, height=rafter["width"], sections=24)
                cap.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
                cap.apply_translation(end_point)
                self.add("rafter", f"rafter:{side_name}:{x_index}", trimesh.util.concatenate((member, cap)))

            for side_name, start_y, end_y in (("south", -3600.0, -3000.0), ("north", 3000.0, 3600.0)):
                fly_offset = -(board["thickness"] / 2 + fly["height"] / 2)
                path = _roof_path(curve, start_y, end_y, float(x), fly_offset)
                member = _path_prism(path, fly["width"], fly["height"])
                end_point = path[0] if side_name == "south" else path[-1]
                cap = trimesh.creation.cylinder(radius=fly["height"] / 2, height=fly["width"], sections=24)
                cap.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
                cap.apply_translation(end_point)
                self.add("flyRafter", f"fly-rafter:{side_name}:{x_index}", trimesh.util.concatenate((member, cap)))

        panel_x = np.arange(-roof_width / 2 + board["panelWidth"] / 2, roof_width / 2, board["panelWidth"])
        for x_index, x in enumerate(panel_x):
            for side_name, start_y, end_y in (("south", -3600.0, 0.0), ("north", 0.0, 3600.0)):
                path = _roof_path(curve, start_y, end_y, float(x), 0.0)
                self.add("roofBoard", f"roof-board:{side_name}:{x_index}", _path_prism(path, board["panelWidth"], board["thickness"]))

    def _build_roof_finish(self) -> None:
        assembly = self.fixture["assembly"]
        curve = assembly["roofCurve"]
        roof_width = float(assembly["roofWidth"])
        board = self.templates["roofBoard"]["parameters"]
        pan = self.templates["panTile"]["parameters"]
        cover = self.templates["coverTile"]["parameters"]
        step = float(pan["length"] - pan["overlap"])
        x_pan = np.arange(-roof_width / 2 + pan["width"] / 2, roof_width / 2, pan["width"])
        x_cover = (x_pan[:-1] + x_pan[1:]) / 2
        for direction, side_name in ((-1.0, "south"), (1.0, "north")):
            count = int(math.ceil(3600 / step))
            for row in range(count):
                distance = row * step + pan["length"] / 2
                y = direction * distance
                for column, x in enumerate(x_pan):
                    self.add(
                        "panTile",
                        f"pan-tile:{side_name}:{row}:{column}",
                        _curved_roof_tile(
                            pan["width"],
                            pan["rise"],
                            pan["thickness"],
                            pan["length"],
                            pan["overlap"],
                            pan["lapTailDepth"],
                            pan["lapTransitionLength"],
                            False,
                            curve,
                            float(x),
                            y,
                            board["thickness"] / 2 + pan["thickness"] + pan["lapTailDepth"],
                            longitudinal_sections=int(pan["longitudinalSegments"]),
                        ),
                    )
                for column, x in enumerate(x_cover):
                    self.add(
                        "coverTile",
                        f"cover-tile:{side_name}:{row}:{column}",
                        _curved_roof_tile(
                            cover["width"],
                            cover["rise"],
                            cover["thickness"],
                            cover["length"],
                            cover["overlap"],
                            cover["lapTailDepth"],
                            cover["lapTransitionLength"],
                            True,
                            curve,
                            float(x),
                            y,
                            board["thickness"] / 2 + cover["thickness"] + cover["lapTailDepth"],
                            longitudinal_sections=int(cover["longitudinalSegments"]),
                        ),
                    )

        ridge = self.templates["ridgeTile"]["parameters"]
        ridge_count = int(math.ceil(roof_width / (ridge["unitLength"] - ridge["overlap"])))
        step_x = ridge["unitLength"] - ridge["overlap"]
        for index in range(ridge_count):
            x = -roof_width / 2 + ridge["unitLength"] / 2 + index * step_x
            if x > roof_width / 2:
                break
            base_profile = [
                (-ridge["baseWidth"] / 2, 0),
                (ridge["baseWidth"] / 2, 0),
                (ridge["baseWidth"] * 0.38, ridge["baseHeight"]),
                (-ridge["baseWidth"] * 0.38, ridge["baseHeight"]),
            ]
            base = _profile_prism(base_profile, ridge["unitLength"], "x")
            roll = trimesh.creation.cylinder(
                radius=ridge["rollRadius"],
                segment=[[-ridge["unitLength"] / 2, 0, ridge["baseHeight"] + ridge["rollRadius"] * 0.85], [ridge["unitLength"] / 2, 0, ridge["baseHeight"] + ridge["rollRadius"] * 0.85]],
                sections=24,
            )
            crest_profile = [
                (-ridge["crestWidth"] / 2, 0),
                (ridge["crestWidth"] / 2, 0),
                (ridge["crestWidth"] * 0.32, ridge["crestHeight"]),
                (-ridge["crestWidth"] * 0.32, ridge["crestHeight"]),
            ]
            crest = _profile_prism(crest_profile, ridge["unitLength"], "x")
            crest.apply_translation([0, 0, ridge["baseHeight"] + ridge["rollRadius"] * 1.55])
            mesh = trimesh.util.concatenate((base, roll, crest))
            mesh.apply_translation([x, 0, curve["ridgeHeight"] + board["thickness"] / 2 - ridge["seatDrop"]])
            self.add("ridgeTile", f"ridge-tile:{index}", mesh)

    def _build_enclosure(self) -> None:
        levels = self.fixture["assembly"]["levels"]
        axis_x = self.fixture["assembly"]["axisX"]
        y = float(self.fixture["assembly"]["axisY"][0])
        wall = self.templates["wall"]["parameters"]
        wall_top = levels["terraceTop"] + wall["baseHeight"] + wall["panelHeight"]
        door = self.templates["doorFrame"]["parameters"]
        window = self.templates["latticeWindow"]["parameters"]
        thickness = wall["thickness"]
        segments = [
            (axis_x[0], -door["openingWidth"] / 2 - 120, levels["terraceTop"], wall_top),
            (door["openingWidth"] / 2 + 120, axis_x[1], levels["terraceTop"], wall_top),
            (-door["openingWidth"] / 2 - 120, door["openingWidth"] / 2 + 120, levels["terraceTop"] + door["openingHeight"], wall_top),
        ]
        for index, (x0, x1, z0, z1) in enumerate(segments):
            if x1 > x0 and z1 > z0:
                core_depth = thickness - wall["finishThickness"] * 2
                parts = [
                    _box(((x0 + x1) / 2, y + thickness / 2, (z0 + z1) / 2), (x1 - x0, core_depth, z1 - z0)),
                    _box(((x0 + x1) / 2, y + wall["finishThickness"] / 2, (z0 + z1) / 2), (x1 - x0, wall["finishThickness"], z1 - z0)),
                    _box(((x0 + x1) / 2, y + thickness - wall["finishThickness"] / 2, (z0 + z1) / 2), (x1 - x0, wall["finishThickness"], z1 - z0)),
                ]
                self.add("wall", f"wall:south:{index}", trimesh.util.concatenate(parts))

        tenon = float(door["tenonLength"])
        frame_parts = [
            _box((-door["openingWidth"] / 2 - door["stile"] / 2, y - 35, levels["terraceTop"] + door["openingHeight"] / 2), (door["stile"], 120, door["openingHeight"] + tenon * 2)),
            _box((door["openingWidth"] / 2 + door["stile"] / 2, y - 35, levels["terraceTop"] + door["openingHeight"] / 2), (door["stile"], 120, door["openingHeight"] + tenon * 2)),
            _box((0, y - 35, levels["terraceTop"] + door["openingHeight"] + door["head"] / 2), (door["openingWidth"] + door["stile"] * 2 + tenon * 2, 120, door["head"])),
            _box((0, y - 35, levels["terraceTop"] + door["threshold"] / 2), (door["openingWidth"] + door["stile"] * 2 + tenon * 2, 120, door["threshold"])),
        ]
        self.add("doorFrame", "door-frame:south:center", trimesh.util.concatenate(frame_parts))

        leaf = self.templates["doorLeaf"]["parameters"]
        leaf_width = door["openingWidth"] / int(leaf["count"])
        for index in range(int(leaf["count"])):
            center_x = -door["openingWidth"] / 2 + leaf_width * (index + 0.5)
            parts = [
                _box((center_x - leaf_width / 2 + leaf["stile"] / 2, y - 105, levels["terraceTop"] + door["openingHeight"] / 2), (leaf["stile"], leaf["thickness"], door["openingHeight"])),
                _box((center_x + leaf_width / 2 - leaf["stile"] / 2, y - 105, levels["terraceTop"] + door["openingHeight"] / 2), (leaf["stile"], leaf["thickness"], door["openingHeight"])),
            ]
            for rail_index in range(5):
                z = levels["terraceTop"] + rail_index * door["openingHeight"] / 4
                parts.append(_box((center_x, y - 105, z), (leaf_width - leaf["stile"] * 2, leaf["thickness"], leaf["rail"])))
            for panel_index in range(int(leaf["panels"])):
                panel_bottom = levels["terraceTop"] + panel_index * door["openingHeight"] / int(leaf["panels"]) + leaf["rail"] / 2
                panel_top = levels["terraceTop"] + (panel_index + 1) * door["openingHeight"] / int(leaf["panels"]) - leaf["rail"] / 2
                parts.append(
                    _box(
                        (center_x, y - 108, (panel_bottom + panel_top) / 2),
                        (leaf_width - leaf["stile"] * 2 - 40, leaf["thickness"] * 0.6, panel_top - panel_bottom),
                    )
                )
            self.add("doorLeaf", f"door-leaf:south:{index}", trimesh.util.concatenate(parts))

        for side, center_x in (("left", -1300), ("right", 1300)):
            parts = []
            sill = levels["terraceTop"] + wall["baseHeight"]
            for x in (center_x - window["width"] / 2 + window["frame"] / 2, center_x + window["width"] / 2 - window["frame"] / 2):
                parts.append(_box((x, y - 90, sill + window["height"] / 2), (window["frame"], 80, window["height"])))
            for z in (sill + window["frame"] / 2, sill + window["height"] - window["frame"] / 2):
                parts.append(_box((center_x, y - 90, z), (window["width"], 80, window["frame"])))
            for column in range(1, int(window["columns"])):
                x = center_x - window["width"] / 2 + column * window["width"] / int(window["columns"])
                parts.append(_box((x, y - 95, sill + window["height"] / 2), (window["bar"], 70, window["height"] - window["frame"] * 2)))
            for row in range(1, int(window["rows"])):
                z = sill + row * window["height"] / int(window["rows"])
                parts.append(_box((center_x, y - 95, z), (window["width"] - window["frame"] * 2, 70, window["bar"])))
            self.add("latticeWindow", f"lattice-window:south:{side}", trimesh.util.concatenate(parts))


def _build_relations(entities: list[SemanticMesh], rules: list[dict]) -> list[GeometryRelation]:
    by_type: dict[str, list[SemanticMesh]] = {}
    for entity in entities:
        by_type.setdefault(entity.component_type, []).append(entity)
    relations: set[tuple[str, str, str]] = set()

    def add(source: SemanticMesh, relation: str, targets: list[SemanticMesh]) -> None:
        for target in targets:
            relations.add((source.entity_id, relation, target.entity_id))

    def key_parts(entity: SemanticMesh) -> list[str]:
        return entity.key.split(":")

    boards = by_type["roofBoard"]
    rafters = by_type["rafter"]
    purlins = by_type["purlin"]
    posts = by_type["interiorPost"]
    bearings = by_type["bearingBlock"]
    arms = by_type["bracketArm"]
    seats = by_type["bracketSeat"]
    eave_beams = by_type["eaveBeam"]
    tie_beams = by_type["tieBeam"]
    columns = by_type["column"]
    bases = by_type["columnBase"]
    terrace_courses = sorted(by_type["terrace"], key=lambda item: int(key_parts(item)[-1]))
    foundations = by_type["foundation"]

    for component_type in ("panTile", "coverTile"):
        for source in by_type[component_type]:
            parts = key_parts(source)
            side = parts[1]
            target = min(
                (item for item in boards if key_parts(item)[1] == side),
                key=lambda item: abs(float(item.mesh.centroid[0] - source.mesh.centroid[0])),
            )
            add(source, "supportedBy", [target])
    for source in by_type["ridgeTile"]:
        target = min(boards, key=lambda item: abs(float(item.mesh.centroid[0] - source.mesh.centroid[0])))
        add(source, "supportedBy", [target])
    for source in boards:
        parts = key_parts(source)
        side = parts[1]
        target = min(
            (item for item in rafters if key_parts(item)[1] == side),
            key=lambda item: abs(float(item.mesh.centroid[0] - source.mesh.centroid[0])),
        )
        add(source, "supportedBy", [target])
    for source in by_type["flyRafter"]:
        parts = key_parts(source)
        side, index = parts[1], parts[2]
        add(source, "connectedTo", [item for item in rafters if key_parts(item)[1:] == [side, index]])
    for source in rafters:
        side = key_parts(source)[1]
        allowed = {0, 1, 2, 3} if side == "south" else {3, 4, 5, 6}
        add(source, "supportedBy", [item for item in purlins if int(key_parts(item)[1]) in allowed])
    for source in purlins:
        index = int(key_parts(source)[1])
        if index in {0, 6}:
            y_index = 0 if index == 0 else 1
            add(source, "supportedBy", [item for item in bearings if int(key_parts(item)[2]) == y_index])
        else:
            post_y_index = index - 1
            add(source, "supportedBy", [item for item in posts if int(key_parts(item)[2]) == post_y_index])
    for source in posts:
        x_index = int(key_parts(source)[1])
        add(source, "supportedBy", [item for item in tie_beams if int(key_parts(item)[1]) == x_index])
    for source in bearings:
        x_index, y_index = key_parts(source)[1:3]
        add(source, "supportedBy", [item for item in arms if key_parts(item)[1:3] == [x_index, y_index]])
    for source in arms:
        x_index, y_index = key_parts(source)[1:3]
        add(source, "supportedBy", [item for item in seats if key_parts(item)[1:3] == [x_index, y_index]])
    for source in seats:
        y_index = key_parts(source)[2]
        add(source, "supportedBy", [item for item in eave_beams if key_parts(item)[1] == y_index])
    for source in eave_beams:
        y_index = key_parts(source)[1]
        add(source, "supportedBy", [item for item in columns if key_parts(item)[2] == y_index])
    for source in tie_beams:
        x_index = key_parts(source)[1]
        add(source, "supportedBy", [item for item in columns if key_parts(item)[1] == x_index])
    for source in columns:
        add(source, "supportedBy", [item for item in bases if key_parts(item)[1:3] == key_parts(source)[1:3]])
    for source in bases:
        add(source, "supportedBy", [terrace_courses[-1]])
    add(terrace_courses[0], "supportedBy", [item for item in foundations if key_parts(item)[-1] == "2"])
    for course, support in zip(terrace_courses[1:], terrace_courses[:-1]):
        add(course, "supportedBy", [support])
    for source in by_type["wall"]:
        add(source, "supportedBy", [terrace_courses[-1]])

    for source in by_type["groundLayer"]:
        add(source, "connectedTo", foundations)
    for source in by_type["step"]:
        add(source, "connectedTo", terrace_courses)
    for source in by_type["doorLeaf"]:
        add(source, "containedBy", by_type["doorFrame"])
    for source in by_type["doorFrame"]:
        add(source, "connectedTo", columns)
    for source in by_type["latticeWindow"]:
        add(source, "connectedTo", columns)

    declared_pairs = {(rule["fromType"], rule["relation"], rule["toType"]) for rule in rules}
    actual_pairs = {
        (
            next(item.component_type for item in entities if item.entity_id == source),
            relation,
            next(item.component_type for item in entities if item.entity_id == target),
        )
        for source, relation, target in relations
    }
    undeclared = sorted(actual_pairs - declared_pairs - {("terrace", "supportedBy", "terrace")})
    if undeclared:
        raise ValueError(f"generated undeclared relation pairs: {undeclared}")
    return [GeometryRelation(*item) for item in sorted(relations)]


def _has_instance_support_path(model: GeometryModel, start: str, target_types: set[str]) -> bool:
    type_by_id = {item.entity_id: item.component_type for item in model.entities}
    graph: dict[str, list[str]] = {}
    for relation in model.relations:
        if relation.relation == "supportedBy":
            graph.setdefault(relation.from_entity_id, []).append(relation.to_entity_id)
    queue = [start]
    visited: set[str] = set()
    while queue:
        current = queue.pop()
        if type_by_id.get(current) in target_types:
            return True
        if current in visited:
            continue
        visited.add(current)
        queue.extend(graph.get(current, []))
    return False


def _fill_ratio(mesh: trimesh.Trimesh) -> float:
    extents = np.ptp(mesh.bounds, axis=0)
    if np.any(extents <= 0):
        return 0.0
    return float(abs(mesh.volume) / np.prod(extents))


def _actual_tile_curvature(entity: SemanticMesh, fixture: dict) -> float:
    parts = entity.key.split(":")
    side, row = parts[1], int(parts[2])
    pan = fixture["componentTemplates"]["panTile"]["parameters"]
    step = float(pan["length"] - pan["overlap"])
    distance = row * step + pan["length"] / 2
    y = -distance if side == "south" else distance
    curve = fixture["assembly"]["roofCurve"]
    _, tangent, normal = _roof_frame(curve, y)
    section = entity.mesh.section(plane_origin=_roof_point(curve, y), plane_normal=tangent)
    if section is None:
        raise ValueError(f"{entity.key} has no transverse tile section")
    projected = np.asarray(section.vertices, dtype=float) @ normal
    xs = np.asarray(section.vertices, dtype=float)[:, 0]
    unique_x = sorted(set(np.round(xs, 6)))
    surface = []
    for x in unique_x:
        values = projected[np.isclose(xs, x, atol=1e-6)]
        surface.append(float(np.max(values)))
    return float(np.polyfit(np.asarray(unique_x), np.asarray(surface), 2)[0])


def _max_curve_chord_error(curve: dict) -> float:
    step = float(curve["sampleStepMm"])
    half_span = float(curve["halfSpan"])
    maximum = 0.0
    for start in np.arange(-half_span, half_span, step):
        end = min(half_span, start + step)
        midpoint = (start + end) / 2
        chord_midpoint = (_roof_curve_value(curve, start) + _roof_curve_value(curve, end)) / 2
        maximum = max(maximum, abs(_roof_curve_value(curve, midpoint) - chord_midpoint))
    return float(maximum)


def _validate_component_features(model: GeometryModel, fixture: dict) -> None:
    by_type: dict[str, list[SemanticMesh]] = {}
    for entity in model.entities:
        by_type.setdefault(entity.component_type, []).append(entity)

    for component_type in ("panTile", "coverTile"):
        for entity in by_type[component_type]:
            if len(entity.mesh.vertices) < 20 or not (0.01 < _fill_ratio(entity.mesh) < 0.25):
                raise ValueError(f"{entity.key} does not retain a curved tile section")
            coefficient = _actual_tile_curvature(entity, fixture)
            if component_type == "panTile" and coefficient <= 0:
                raise ValueError(f"{entity.key} does not retain concave pan-tile curvature")
            if component_type == "coverTile" and coefficient >= 0:
                raise ValueError(f"{entity.key} does not retain convex cover-tile curvature")

    for entity in by_type["ridgeTile"]:
        if len(entity.mesh.split(only_watertight=False)) < 3 or len(entity.mesh.vertices) < 40:
            raise ValueError(f"{entity.key} does not retain the stacked ridge family")
    for entity in by_type["bracketArm"]:
        if len(entity.mesh.vertices) < 8 or _fill_ratio(entity.mesh) >= 0.95:
            raise ValueError(f"{entity.key} does not retain a profiled support section")
    for entity in by_type["bearingBlock"]:
        if len(entity.mesh.vertices) < 24 or len(np.unique(np.round(entity.mesh.vertices[:, 2], 3))) < 5:
            raise ValueError(f"{entity.key} does not retain its saddle groove")

    if any(len(entity.mesh.split(only_watertight=False)) < 3 for entity in by_type["wall"]):
        raise ValueError("wall geometry does not retain its core and finish layers")
    if any(len(entity.mesh.split(only_watertight=False)) < 4 for entity in by_type["doorFrame"]):
        raise ValueError("door frame does not retain its jointed member assembly")
    if any(len(entity.mesh.split(only_watertight=False)) < 2 for entity in by_type["rafter"] + by_type["flyRafter"]):
        raise ValueError("rafter geometry does not retain its rounded eave end")

    window_parameters = fixture["componentTemplates"]["latticeWindow"]["parameters"]
    expected_window_parts = 4 + int(window_parameters["columns"]) - 1 + int(window_parameters["rows"]) - 1
    for entity in by_type["latticeWindow"]:
        if len(entity.mesh.split(only_watertight=False)) != expected_window_parts:
            raise ValueError(f"{entity.key} does not retain the declared lattice division")
    door_parameters = fixture["componentTemplates"]["doorLeaf"]["parameters"]
    expected_door_parts = 3 + 2 * int(door_parameters["panels"])
    for entity in by_type["doorLeaf"]:
        if len(entity.mesh.split(only_watertight=False)) != expected_door_parts:
            raise ValueError(f"{entity.key} does not retain the declared panel division")

    curve = fixture["assembly"]["roofCurve"]
    epsilon = 1e-6
    left_slope = _roof_curve_slope(curve, -epsilon)
    right_slope = _roof_curve_slope(curve, epsilon)
    expected_slope = float(curve["ridgeOneSidedSlope"])
    if abs(left_slope - expected_slope) > 1e-6 or abs(right_slope + expected_slope) > 1e-6:
        raise ValueError("paired roof slopes must retain the frozen non-zero ridge break")
    if abs(left_slope - right_slope - float(curve["ridgeSlopeJump"])) > 1e-6:
        raise ValueError("ridge slope jump differs from the frozen C0 roof definition")
    if abs(_roof_curve_slope(curve, curve["halfSpan"])) > curve["edgeTangentLimit"]:
        raise ValueError("roof curve does not retain the controlled eave upturn")
    if _max_curve_chord_error(curve) > fixture["geometryValidation"]["maxChordErrorMm"]:
        raise ValueError("roof curve sampling exceeds maxChordErrorMm")


def validate_geometry(model: GeometryModel, fixture: dict) -> None:
    entity_ids = [item.entity_id for item in model.entities]
    if len(entity_ids) != len(set(entity_ids)):
        raise ValueError("entity IDs must be unique")
    present_types = {item.component_type for item in model.entities}
    missing_types = sorted(REQUIRED_COMPONENT_TYPES - present_types)
    if missing_types:
        raise ValueError(f"missing component types: {', '.join(missing_types)}")
    for entity in model.entities:
        if entity.geometry_status != "resolved":
            raise ValueError(f"{entity.key} is not resolved")
        if not np.isfinite(entity.mesh.vertices).all():
            raise ValueError(f"{entity.key} contains non-finite geometry")
        if len(entity.mesh.faces) == 0 or abs(float(entity.mesh.volume)) <= 0:
            raise ValueError(f"{entity.key} has no solid geometry")
        if not entity.mesh.is_watertight:
            raise ValueError(f"{entity.key} is not watertight")
        if not entity.mesh.is_winding_consistent:
            raise ValueError(f"{entity.key} has inconsistent face winding")
        if entity.source_refs != fixture["sourceRefs"] or any(not item.startswith("demo:") for item in entity.source_refs):
            raise ValueError(f"{entity.key} is not isolated to the demo fixture")
    valid_ids = set(entity_ids)
    for relation in model.relations:
        if relation.from_entity_id not in valid_ids or relation.to_entity_id not in valid_ids:
            raise ValueError("relation references an unknown entity")
    for entity in model.entities:
        if entity.component_type in {"panTile", "coverTile", "ridgeTile"} and not _has_instance_support_path(model, entity.entity_id, {"foundation"}):
            raise ValueError(f"{entity.key} has no support path to foundation")
    if model.geometry_revision_id != fixture["geometryRevisionId"]:
        raise ValueError("geometry revision does not match fixture")
    if model.source_refs != fixture["sourceRefs"] or any(not item.startswith("demo:") for item in model.source_refs):
        raise ValueError("geometry generation must remain isolated to the demo fixture")
    _validate_component_features(model, fixture)


def build_geometry(fixture: dict) -> GeometryModel:
    return GeometryBuilder(fixture).build()


def export_glb(model: GeometryModel, path: Path) -> None:
    scene = trimesh.Scene()
    z_up_mm_to_gltf_y_up_metres = np.asarray(
        [
            [0.001, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.001, 0.0],
            [0.0, -0.001, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    for entity in model.entities:
        mesh = entity.mesh.copy()
        mesh.apply_transform(z_up_mm_to_gltf_y_up_metres)
        mesh.metadata.update(
            {
                "entityId": entity.entity_id,
                "typeId": entity.type_id,
                "componentType": entity.component_type,
                "materialId": entity.material_id,
                "geometryRevisionId": model.geometry_revision_id,
                "producerType": model.producer_type,
            }
        )
        mesh.visual.face_colors = np.tile(np.asarray(MATERIAL_COLORS[entity.material_code], dtype=np.uint8), (len(mesh.faces), 1))
        scene.add_geometry(mesh, node_name=f"{entity.component_type}|{entity.key}|{entity.entity_id}", geom_name=entity.entity_id)
    path.write_bytes(scene.export(file_type="glb"))
