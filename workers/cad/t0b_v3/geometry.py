from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
import math
from typing import Iterable
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import MultiPolygon, Polygon, box as polygon_box
from shapely.geometry.polygon import orient
from shapely.ops import triangulate, unary_union
import trimesh

from .contracts import expected_geometry_revision, parameter_type_map, sanitized_generation_input


TYPE_NAMESPACE = UUID("13a45cfb-1ef4-42ca-afcf-c6a99971da26")
ENTITY_NAMESPACE = UUID("89856eb1-8f3d-4724-acbb-e4a78798c887")
MATERIAL_NAMESPACE = UUID("74fe8d98-ecff-4fd8-b7df-a36b28b00a0a")
ASSEMBLY_NAMESPACE = UUID("15824e5e-f0b5-44aa-b1d8-4097c4370728")
FEATURE_NAMESPACE = UUID("c458a5d8-0d41-4a71-8fe8-fae1e6164893")
DIMENSION_NAMESPACE = UUID("8ec581f4-ddc4-48fc-b8ad-8f604f1b5200")
PARAMETER_NAMESPACE = UUID("3af0d813-77f9-4b98-b3dc-2df17f09cde7")
UNKNOWN_NAMESPACE = UUID("fd405822-0d6c-4d7e-89e5-c3cbf13a80a9")


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _stable_id(namespace: UUID, *parts: object) -> str:
    return str(uuid5(namespace, "|".join(_canonical(part) for part in parts)))


def _canonical_triangle(points: Iterable[Iterable[float]]) -> tuple:
    triangle = tuple(tuple(round(float(value), 3) for value in point) for point in points)
    rotations = (triangle, triangle[1:] + triangle[:1], triangle[2:] + triangle[:2])
    return min(rotations)


def canonical_mesh_hash(mesh: trimesh.Trimesh) -> str:
    vertices = np.asarray(mesh.vertices, dtype=float)
    vertex_records = sorted(tuple(round(float(value), 3) for value in vertex) for vertex in vertices)
    oriented_triangles = sorted(_canonical_triangle(vertices[face]) for face in np.asarray(mesh.faces, dtype=int))
    return sha256(_canonical({"vertices": vertex_records, "orientedTriangles": oriented_triangles}).encode("utf-8")).hexdigest()


def _box(center: tuple[float, float, float], extents: tuple[float, float, float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.box(extents=np.asarray(extents, dtype=float))
    mesh.apply_translation(np.asarray(center, dtype=float))
    return mesh


def _frustum(
    center: tuple[float, float, float],
    bottom_radius: float,
    top_radius: float,
    height: float,
    sections: int,
) -> trimesh.Trimesh:
    vertices: list[list[float]] = []
    for z, radius in ((-height / 2, bottom_radius), (height / 2, top_radius)):
        for index in range(sections):
            angle = 2 * math.pi * index / sections
            vertices.append([radius * math.cos(angle), radius * math.sin(angle), z])
    faces: list[tuple[int, int, int]] = []
    for index in range(sections):
        nxt = (index + 1) % sections
        faces.extend(((index, nxt, sections + nxt), (index, sections + nxt, sections + index)))
    bottom_center = len(vertices)
    vertices.append([0.0, 0.0, -height / 2])
    top_center = len(vertices)
    vertices.append([0.0, 0.0, height / 2])
    for index in range(sections):
        nxt = (index + 1) % sections
        faces.extend(((bottom_center, nxt, index), (top_center, sections + index, sections + nxt)))
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)
    mesh.apply_translation(np.asarray(center, dtype=float))
    return mesh


def _extrude_single_polygon(polygon: Polygon, depth: float, axis: str) -> trimesh.Trimesh:
    polygon = orient(polygon, sign=1.0)
    if not polygon.is_valid or polygon.area <= 0:
        raise ValueError("profile must be a valid positive polygon")
    triangles = [item for item in triangulate(polygon) if polygon.covers(item.representative_point())]
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
    rings = [list(polygon.exterior.coords)[:-1], *(list(ring.coords)[:-1] for ring in polygon.interiors)]
    boundary_rings = [[index_of((float(x), float(y))) for x, y in ring] for ring in rings]
    count = len(coordinates)
    vertices: list[list[float]] = []
    for side in (-depth / 2, depth / 2):
        for a, b in coordinates:
            if axis == "y":
                vertices.append([a, side, b])
            elif axis == "x":
                vertices.append([side, a, b])
            else:
                vertices.append([a, b, side])
    faces: list[tuple[int, int, int]] = []
    for a, b, c in triangle_indices:
        if axis == "y":
            faces.extend(((a, b, c), (a + count, c + count, b + count)))
        else:
            faces.extend(((a, c, b), (a + count, b + count, c + count)))
    for ring in boundary_rings:
        for index, current in enumerate(ring):
            nxt = ring[(index + 1) % len(ring)]
            if axis == "y":
                faces.extend(((current, current + count, nxt + count), (current, nxt + count, nxt)))
            else:
                faces.extend(((current, nxt, nxt + count), (current, nxt + count, current + count)))
    return trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)


def _extrude_polygon(polygon: Polygon | MultiPolygon, depth: float, axis: str) -> trimesh.Trimesh:
    if isinstance(polygon, MultiPolygon):
        return trimesh.util.concatenate([_extrude_single_polygon(item, depth, axis) for item in polygon.geoms])
    return _extrude_single_polygon(polygon, depth, axis)


def _rectangular_opening_solid(
    outer: Polygon,
    openings: list[Polygon],
    depth: float,
    axis: str,
) -> trimesh.Trimesh:
    """Build a closed solid around axis-aligned openings without hole triangulation."""
    if axis != "y":
        raise ValueError("rectangular opening solid currently supports the y axis only")
    min_x, min_z, max_x, max_z = outer.bounds
    x_breaks = {float(min_x), float(max_x)}
    z_breaks = {float(min_z), float(max_z)}
    for opening in openings:
        opening_min_x, opening_min_z, opening_max_x, opening_max_z = opening.bounds
        x_breaks.update((float(opening_min_x), float(opening_max_x)))
        z_breaks.update((float(opening_min_z), float(opening_max_z)))
    xs = sorted(x_breaks)
    zs = sorted(z_breaks)
    solids: list[trimesh.Trimesh] = []
    for x0, x1 in zip(xs[:-1], xs[1:]):
        for z0, z1 in zip(zs[:-1], zs[1:]):
            if x1 - x0 <= 1e-6 or z1 - z0 <= 1e-6:
                continue
            sample = Polygon(
                [
                    (x0, z0),
                    (x1, z0),
                    (x1, z1),
                    (x0, z1),
                ]
            ).representative_point()
            if not outer.covers(sample) or any(opening.covers(sample) for opening in openings):
                continue
            solids.append(_box(((x0 + x1) / 2, 0, (z0 + z1) / 2), (x1 - x0, depth, z1 - z0)))
    if not solids:
        raise ValueError("rectangular openings removed the complete profile")
    return trimesh.util.concatenate(solids)


def _profile_prism(profile: list[tuple[float, float]], depth: float, axis: str) -> trimesh.Trimesh:
    return _extrude_polygon(Polygon(profile), depth, axis)


def _stacked_revolved_profile(profile: list[list[float]], sections: int) -> trimesh.Trimesh:
    parts: list[trimesh.Trimesh] = []
    for lower, upper in zip(profile[:-1], profile[1:]):
        lower_radius, lower_z = float(lower[0]), float(lower[1])
        upper_radius, upper_z = float(upper[0]), float(upper[1])
        parts.append(
            _frustum(
                (0.0, 0.0, (lower_z + upper_z) / 2),
                lower_radius,
                upper_radius,
                upper_z - lower_z,
                sections,
            )
        )
    return trimesh.util.concatenate(parts)


def _roof_curve_value(curve: dict, y: float) -> float:
    half_span = float(curve["halfSpan"])
    absolute_y = abs(float(y))
    t = min(1.0, max(0.0, absolute_y / half_span))
    drop = sum(float(coefficient) * t**power for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"]))
    value = float(curve["ridgeHeight"] - drop)
    if absolute_y > half_span:
        edge_slope = _roof_curve_slope(curve, half_span, 1.0)
        value += edge_slope * (absolute_y - half_span)
    return value


def _roof_curve_slope(curve: dict, y: float, ridge_side: float | None = None) -> float:
    half_span = float(curve["halfSpan"])
    t = min(1.0, max(0.0, abs(float(y)) / half_span))
    derivative = sum(
        power * float(coefficient) * t ** (power - 1)
        for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"])
    )
    if y < 0:
        side = -1.0
    elif y > 0:
        side = 1.0
    else:
        side = float(ridge_side or 0.0)
    return float(-side * derivative / half_span)


def _finished_half_span(curve: dict, fly_rafter: dict) -> float:
    _, tangent, _ = _roof_frame(curve, float(curve["halfSpan"]), 1.0)
    return float(curve["halfSpan"] + abs(tangent[1]) * float(fly_rafter["length"]))


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
    x: float,
    normal_offset: float,
    ridge_side: float | None = None,
) -> np.ndarray:
    _, _, normal = _roof_frame(curve, y, ridge_side)
    return np.asarray([x, y, _roof_curve_value(curve, y)], dtype=float) + normal * normal_offset


def _roof_path(
    curve: dict,
    start_y: float,
    end_y: float,
    x: float,
    normal_offset: float,
    step_mm: float | None = None,
) -> list[np.ndarray]:
    step = float(step_mm or curve["sampleStepMm"])
    count = max(2, int(math.ceil(abs(end_y - start_y) / step)) + 1)
    side = -1.0 if (start_y + end_y) / 2 < 0 else 1.0
    return [_roof_point(curve, float(y), x, normal_offset, side) for y in np.linspace(start_y, end_y, count)]


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


def _curved_roof_tile(
    *,
    width: float,
    rise: float,
    thickness: float,
    length: float,
    overlap: float,
    convex: bool,
    curve: dict,
    x: float,
    y: float,
    normal_offset: float,
    longitudinal_sections: int,
    raised_overlap: bool,
    lap_clearance: float,
) -> trimesh.Trimesh:
    cross_sections = 12
    xs = np.linspace(-width / 2, width / 2, cross_sections + 1)
    side = -1.0 if y < 0 else 1.0
    center_distance = abs(float(y))
    start_distance = max(0.0, center_distance - length / 2)
    end_distance = center_distance + length / 2
    transition_length = min(20.0, overlap / 2)
    overlap_start = max(start_distance, end_distance - overlap)
    if raised_overlap:
        transition_start = max(start_distance, overlap_start - transition_length)
        stations = [
            (float(distance), 0.0)
            for distance in np.linspace(start_distance, transition_start, longitudinal_sections + 1)
        ]
        stations.extend(
            [
                (float(overlap_start), thickness + lap_clearance),
                (float(end_distance), thickness + lap_clearance),
            ]
        )
    else:
        stations = [
            (float(distance), 0.0)
            for distance in np.linspace(start_distance, overlap_start, longitudinal_sections + 1)
        ]
        stations.append((float(end_distance), 0.0))
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
    for y_index in range(len(stations) - 1):
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
    last_station = len(stations) - 1
    for x_index in range(cross_sections):
        faces.extend(
            (
                (top(0, x_index), lower(0, x_index + 1), top(0, x_index + 1)),
                (top(0, x_index), lower(0, x_index), lower(0, x_index + 1)),
                (top(last_station, x_index), top(last_station, x_index + 1), lower(last_station, x_index + 1)),
                (top(last_station, x_index), lower(last_station, x_index + 1), lower(last_station, x_index)),
            )
        )
    return trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)


@dataclass
class SemanticEntity:
    fixture_id: str
    key: str
    component_type: str
    template: dict
    material: dict
    source_refs: list[str]
    mesh: trimesh.Trimesh
    parameter_types: dict[str, dict]
    unknown_registry: dict[str, dict]
    local_feature_names: list[str] = field(default_factory=list)

    @property
    def entity_id(self) -> str:
        return _stable_id(ENTITY_NAMESPACE, self.fixture_id, self.key)

    def record(self) -> dict:
        template = self.template
        feature_names = sorted(set(template["requiredFeatureProfile"]) | set(self.local_feature_names))
        feature_ids = [
            {"featureId": _stable_id(FEATURE_NAMESPACE, self.fixture_id, self.key, name), "featureName": name}
            for name in feature_names
        ]
        parameter_facts = []
        dimensions = []
        for name, value in sorted(template["parameters"].items()):
            value_type = self.parameter_types[name]
            parameter_id = _stable_id(PARAMETER_NAMESPACE, self.fixture_id, self.key, name)
            fact = {
                "parameterId": parameter_id,
                "stableKey": name,
                "valueType": value_type["valueType"],
                "value": value,
                "unit": value_type["unit"],
                "factBasis": "demoParameter",
                "sourceRefs": self.source_refs,
                "reviewStatus": "unreviewed",
                "formalEligibility": "ineligible",
            }
            parameter_facts.append(fact)
            if value_type["valueType"] in {"length", "angle"}:
                dimensions.append(
                    {
                        "dimensionId": parameter_id,
                        "category": name,
                        "valueType": value_type["valueType"],
                        "value": value,
                        "unit": value_type["unit"],
                        "factBasis": "demoParameter",
                        "sourceRefs": self.source_refs,
                        "reviewStatus": "unreviewed",
                        "formalEligibility": "ineligible",
                    }
                )
        unknowns = []
        for stable_key in template["unknowns"]:
            unknowns.append(
                {
                    "unknownId": _stable_id(UNKNOWN_NAMESPACE, self.fixture_id, self.key, stable_key),
                    "stableKey": stable_key,
                    **self.unknown_registry[stable_key],
                    "affectedEntityId": self.entity_id,
                    "reviewStatus": "unreviewed",
                    "formalEligibility": "ineligible",
                }
            )
        bounds = np.asarray(self.mesh.bounds, dtype=float)
        return {
            "entityId": self.entity_id,
            "typeId": _stable_id(TYPE_NAMESPACE, self.fixture_id, self.component_type, template),
            "key": self.key,
            "componentType": self.component_type,
            "domainTerm": template["domainTerm"],
            "resolution": template["resolution"],
            "assemblyRole": template["assemblyRole"],
            "parentAssemblyId": _stable_id(ASSEMBLY_NAMESPACE, self.fixture_id, template["assemblyRole"]),
            "memberRole": template["memberRole"],
            "featureIds": feature_ids,
            "requiredFeatureProfile": template["requiredFeatureProfile"],
            "materialFact": {**self.material, "sourceRefs": self.source_refs},
            "parameterFacts": parameter_facts,
            "dimensionFacts": dimensions,
            "unknowns": unknowns,
            "producerType": "demo",
            "factBasis": template["factBasis"],
            "formalEligibility": "ineligible",
            "sourceRefs": self.source_refs,
            "bounds": np.round(bounds, 6).tolist(),
            "centroid": np.round(np.asarray(self.mesh.centroid, dtype=float), 6).tolist(),
            "volumeMm3": round(float(abs(self.mesh.volume)), 6),
            "vertices": int(len(self.mesh.vertices)),
            "faces": int(len(self.mesh.faces)),
            "watertight": bool(self.mesh.is_watertight),
            "windingConsistent": bool(self.mesh.is_winding_consistent),
            "meshHash": canonical_mesh_hash(self.mesh),
            "meshHashPrecisionMm": 0.001,
        }


@dataclass
class GeometryModel:
    fixture: dict
    entities: list[SemanticEntity]
    interfaces: list[dict]

    def manifest(self) -> dict:
        entity_records = [item.record() for item in sorted(self.entities, key=lambda item: item.entity_id)]
        interface_records = sorted(self.interfaces, key=lambda item: item["interfaceId"])
        entity_by_key = {item.key: item for item in self.entities}
        observations = []
        for candidate in self.fixture["observationCandidates"]:
            item = dict(candidate)
            item["targetEntityId"] = entity_by_key[item.pop("targetEntityKey")].entity_id
            observations.append(item)
        recommendations = [dict(item) for item in self.fixture["protectionRecommendationCandidates"]]
        dimension_facts = [
            {
                "dimensionFactId": _stable_id(DIMENSION_NAMESPACE, self.fixture["fixtureId"], stable_key),
                "stableKey": stable_key,
                **fact,
                "producerType": "demo",
                "formalEligibility": "ineligible",
                "sourceRefs": self.fixture["sourceRefs"],
            }
            for stable_key, fact in sorted(self.fixture["dimensionFacts"].items())
        ]
        signature_payload = {
            "entities": entity_records,
            "interfaces": interface_records,
            "dimensionFacts": dimension_facts,
            "observationCandidates": observations,
            "protectionRecommendationCandidates": recommendations,
        }
        signature = sha256(_canonical(signature_payload).encode("utf-8")).hexdigest()
        revision_id = expected_geometry_revision(signature)
        frozen_revision = self.fixture["geometryRevisionId"]
        if frozen_revision != "UNFROZEN" and frozen_revision != revision_id:
            raise ValueError("frozen geometry revision differs from generated signature")
        return {
            "schemaVersion": "t0b-v3-geometry-manifest-2",
            "projectId": self.fixture["projectId"],
            "fixtureId": self.fixture["fixtureId"],
            "geometryRevisionId": revision_id,
            "geometrySignature": signature,
            "unit": "mm",
            "coordinateSystem": self.fixture["coordinateSystem"],
            "producerType": "demo",
            "formalEligibility": "ineligible",
            "sourceRefs": self.fixture["sourceRefs"],
            "entities": entity_records,
            "interfaces": interface_records,
            "dimensionFacts": dimension_facts,
            "observationCandidates": observations,
            "protectionRecommendationCandidates": recommendations,
            "qualification": {
                "status": "generated-not-qualified",
                "technicalVerification": "pending",
                "L1": False,
                "formalEligibility": "ineligible",
            },
        }


class GeometryBuilder:
    def __init__(self, fixture: dict):
        self.fixture = sanitized_generation_input(fixture)
        self.templates = self.fixture["componentTemplates"]
        self.entities: list[SemanticEntity] = []
        self.entity_by_key: dict[str, SemanticEntity] = {}
        self.purlin_centers: dict[int, np.ndarray] = {}

    def add(
        self,
        component_type: str,
        key: str,
        mesh: trimesh.Trimesh,
        local_features: Iterable[str] = (),
    ) -> SemanticEntity:
        if key in self.entity_by_key:
            raise ValueError(f"duplicate entity key: {key}")
        mesh = mesh.copy()
        mesh.remove_unreferenced_vertices()
        template = self.templates[component_type]
        material = self.fixture["materials"][template["materialCode"]]
        entity = SemanticEntity(
            fixture_id=self.fixture["fixtureId"],
            key=key,
            component_type=component_type,
            template=template,
            material=material,
            source_refs=list(self.fixture["sourceRefs"]),
            mesh=mesh,
            parameter_types=parameter_type_map(self.fixture["parameterTypeRegistry"]),
            unknown_registry=self.fixture["unknownRegistry"],
            local_feature_names=list(local_features),
        )
        self.entities.append(entity)
        self.entity_by_key[key] = entity
        return entity

    def build(self) -> GeometryModel:
        self._build_ground_foundation_and_terrace()
        self._build_columns_and_beams()
        self._build_roof_structure()
        self._build_eave_supports()
        self._build_roof_finish()
        self._build_enclosure()
        interfaces = self._resolve_interfaces()
        model = GeometryModel(self.fixture, self.entities, interfaces)
        validate_model(model)
        return model

    def _build_ground_foundation_and_terrace(self) -> None:
        assembly = self.fixture["assembly"]
        levels = assembly["levels"]
        ground = self.templates["groundLayer"]["parameters"]
        foundation = self.templates["foundationLayer"]["parameters"]
        course_height = foundation["height"] / int(foundation["courses"])
        half_w = ground["width"] / 2
        half_d = ground["depth"] / 2
        ground_bottom = -float(ground["thickness"])
        for course in range(int(foundation["courses"])):
            course_bottom = levels["foundationBottom"] + course_height * course
            course_top = course_bottom + course_height
            slice_bottom = max(ground_bottom, course_bottom)
            slice_top = min(0.0, course_top)
            if slice_top - slice_bottom <= 1e-6:
                continue
            opening = foundation["width"] - course * foundation["courseReduction"]
            openings = [
                (x - opening / 2, x + opening / 2, y - opening / 2, y + opening / 2)
                for x in assembly["axisX"]
                for y in assembly["axisY"]
            ]
            x_breaks = sorted({-half_w, half_w, *(value for item in openings for value in item[:2])})
            y_breaks = sorted({-half_d, half_d, *(value for item in openings for value in item[2:])})
            ground_parts: list[trimesh.Trimesh] = []
            for x0, x1 in zip(x_breaks[:-1], x_breaks[1:]):
                for y0, y1 in zip(y_breaks[:-1], y_breaks[1:]):
                    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                    if any(ox0 < cx < ox1 and oy0 < cy < oy1 for ox0, ox1, oy0, oy1 in openings):
                        continue
                    ground_parts.append(
                        _box(
                            (cx, cy, (slice_bottom + slice_top) / 2),
                            (x1 - x0, y1 - y0, slice_top - slice_bottom),
                        )
                    )
            self.add(
                "groundLayer",
                f"ground:ring:foundation-course:{course}",
                trimesh.util.concatenate(ground_parts),
                [f"foundation-opening-course-{course}"],
            )
        bearing_pad_width = foundation["width"] + ground["bearingPadPlanMargin"] * 2
        bearing_pad_depth = foundation["depth"] + ground["bearingPadPlanMargin"] * 2
        bearing_pad_top = float(levels["foundationBottom"])
        bearing_pad_bottom = bearing_pad_top - float(ground["bearingPadThickness"])
        for x_index, x in enumerate(assembly["axisX"]):
            for y_index, y in enumerate(assembly["axisY"]):
                self.add(
                    "groundLayer",
                    f"ground:bearing:{x_index}:{y_index}",
                    _box(
                        (x, y, (bearing_pad_bottom + bearing_pad_top) / 2),
                        (bearing_pad_width, bearing_pad_depth, ground["bearingPadThickness"]),
                    ),
                    ["foundation-bearing-pad", "ground-bearing-top-face"],
                )
        for x_index, x in enumerate(assembly["axisX"]):
            for y_index, y in enumerate(assembly["axisY"]):
                for course in range(int(foundation["courses"])):
                    reduction = course * foundation["courseReduction"]
                    width = foundation["width"] - reduction
                    depth = foundation["depth"] - reduction
                    z = levels["foundationBottom"] + course_height * (course + 0.5)
                    self.add(
                        "foundationLayer",
                        f"foundation:{x_index}:{y_index}:course:{course}",
                        _box((x, y, z), (width, depth, course_height)),
                        [f"bearing-face-course-{course}"],
                    )

        terrace = self.templates["terrace"]["parameters"]
        course_count = round(terrace["height"] / terrace["courseHeight"])
        for course in range(course_count):
            inset = (course_count - course - 1) * terrace["courseInset"]
            z = terrace["courseHeight"] * (course + 0.5)
            self.add(
                "terrace",
                f"terrace:course:{course}",
                _box(
                    (0, 0, z),
                    (terrace["width"] - inset * 2, terrace["depth"] - inset * 2, terrace["courseHeight"]),
                ),
            )

        step = self.templates["step"]["parameters"]
        for index in range(int(step["count"])):
            depth = step["tread"] * (int(step["count"]) - index)
            center_y = -terrace["depth"] / 2 - depth / 2
            center_z = step["riser"] * (index + 0.5)
            self.add(
                "step",
                f"step:south:{index}",
                _box((0, center_y, center_z), (step["width"], depth, step["riser"])),
            )

    def _build_columns_and_beams(self) -> None:
        assembly = self.fixture["assembly"]
        levels = assembly["levels"]
        base = self.templates["columnBase"]["parameters"]
        column = self.templates["column"]["parameters"]
        for x_index, x in enumerate(assembly["axisX"]):
            for y_index, y in enumerate(assembly["axisY"]):
                profile = [
                    [base["lowerDiameter"] / 2, 0],
                    [base["lowerDiameter"] / 2, 55],
                    [base["upperDiameter"] / 2 + 45, 100],
                    [base["upperDiameter"] / 2 + 45, 155],
                    [base["upperDiameter"] / 2, base["height"]],
                ]
                base_mesh = _stacked_revolved_profile(profile, 48)
                base_mesh.apply_translation([x, y, levels["terraceTop"]])
                self.add("columnBase", f"column-base:{x_index}:{y_index}", base_mesh)
                insertion = float(column["seatInsertionDepth"])
                actual_height = column["height"] + insertion
                center_z = levels["columnBaseTop"] + actual_height / 2
                self.add(
                    "column",
                    f"column:{x_index}:{y_index}",
                    _frustum(
                        (x, y, center_z),
                        column["bottomDiameter"] / 2,
                        column["topDiameter"] / 2,
                        actual_height,
                        int(column["facets"]),
                    ),
                )

        eave = self.templates["eaveBeam"]["parameters"]
        beam_center_z = levels["columnTop"] + eave["height"] / 2
        for y_index, y in enumerate(assembly["axisY"]):
            beam = self._member_with_bottom_recesses(
                axis="x",
                length=eave["length"],
                width=eave["width"],
                height=eave["height"],
                center=(0.0, y),
                bottom_z=levels["columnTop"],
                recess_centers=[float(value) for value in assembly["axisX"]],
                recess_width=column["topDiameter"],
                recess_depth=eave["columnSeatDepth"],
            )
            self.add(
                "eaveBeam",
                f"eave-beam:{y_index}",
                beam,
                ["column-bearing-recess-west", "column-bearing-recess-east"],
            )
        tie = self.templates["tieBeam"]["parameters"]
        for x_index, x in enumerate(assembly["axisX"]):
            beam = self._member_with_bottom_recesses(
                axis="y",
                length=tie["length"],
                width=tie["width"],
                height=tie["height"],
                center=(x, 0.0),
                bottom_z=levels["columnTop"],
                recess_centers=[float(value) for value in assembly["axisY"]],
                recess_width=column["topDiameter"],
                recess_depth=tie["columnSeatDepth"],
            )
            self.add(
                "tieBeam",
                f"tie-beam:{x_index}",
                beam,
                ["column-bearing-recess-south", "column-bearing-recess-north"],
            )

    @staticmethod
    def _member_with_bottom_recesses(
        *,
        axis: str,
        length: float,
        width: float,
        height: float,
        center: tuple[float, float],
        bottom_z: float,
        recess_centers: list[float],
        recess_width: float,
        recess_depth: float,
    ) -> trimesh.Trimesh:
        upper_height = height - recess_depth
        parts = [
            _box(
                (center[0], center[1], bottom_z + recess_depth + upper_height / 2),
                (length, width, upper_height) if axis == "x" else (width, length, upper_height),
            )
        ]
        boundaries = [-length / 2, *(value - recess_width / 2 for value in recess_centers), *(value + recess_width / 2 for value in recess_centers), length / 2]
        boundaries = sorted(set(float(value) for value in boundaries))
        for start, end in zip(boundaries[:-1], boundaries[1:]):
            midpoint = (start + end) / 2
            if any(abs(midpoint - value) < recess_width / 2 - 1e-6 for value in recess_centers):
                continue
            local_center = (center[0] + midpoint, center[1]) if axis == "x" else (center[0], center[1] + midpoint)
            extents = (end - start, width, recess_depth) if axis == "x" else (width, end - start, recess_depth)
            parts.append(_box((local_center[0], local_center[1], bottom_z + recess_depth / 2), extents))
        return trimesh.util.concatenate(parts)

    def _build_roof_structure(self) -> None:
        assembly = self.fixture["assembly"]
        curve = assembly["roofCurve"]
        board = self.templates["roofBoard"]["parameters"]
        rafter = self.templates["rafter"]["parameters"]
        fly = self.templates["flyRafter"]["parameters"]
        purlin = self.templates["purlin"]["parameters"]
        purlin_seat_depth = float(rafter["purlinSeatCenterDepth"])
        # 檩位默认保持首版 demo 的手工对齐值；fixture 可通过 assembly.purlinYPositions 覆盖
        y_positions = [float(value) for value in assembly.get("purlinYPositions", [-3000, -2400, -1200, 0, 1200, 2400, 3000])]
        self.purlin_y_positions = y_positions
        for index, y in enumerate(y_positions):
            side = -1 if y <= 0 else 1
            rafter_bottom = _roof_point(
                curve,
                y,
                0.0,
                -(board["thickness"] / 2 + rafter["height"]),
                side,
            )
            center = np.asarray(
                [0.0, rafter_bottom[1], rafter_bottom[2] + purlin_seat_depth - purlin["diameter"] / 2],
                dtype=float,
            )
            if abs(float(y)) <= 1e-9:
                _, _, ridge_normal = _roof_frame(curve, 0.0, 1.0)
                ridge_bottom_y = float(ridge_normal[1] * -(board["thickness"] / 2 + rafter["height"]))
                ridge_bottom_z = float(
                    _roof_curve_value(curve, 0.0)
                    + ridge_normal[2] * -(board["thickness"] / 2 + rafter["height"])
                )
                ridge_circle_height = math.sqrt((purlin["diameter"] / 2) ** 2 - ridge_bottom_y**2)
                center = np.asarray(
                    [0.0, 0.0, ridge_bottom_z + purlin_seat_depth - ridge_circle_height],
                    dtype=float,
                )
            self.purlin_centers[index] = center
            mesh = trimesh.creation.cylinder(
                radius=purlin["diameter"] / 2,
                segment=[[-assembly["roofWidth"] / 2, center[1], center[2]], [assembly["roofWidth"] / 2, center[1], center[2]]],
                sections=int(purlin["facets"]),
            )
            self.add("purlin", f"purlin:{index}", mesh, [f"bearing-contact-{index}"])

        post = self.templates["interiorPost"]["parameters"]
        tie = self.templates["tieBeam"]["parameters"]
        for x_index, x in enumerate(assembly["axisX"]):
            for index in range(1, len(y_positions) - 1):
                center = self.purlin_centers[index]
                bottom = assembly["levels"]["columnTop"] + tie["height"]
                radius = purlin["diameter"] / 2
                groove_half = math.sqrt(2 * radius * post["socketDepth"] - post["socketDepth"] ** 2)
                groove_y = np.linspace(-groove_half, groove_half, 13)
                shoulder = center[2] - (radius - post["socketDepth"])
                profile = [
                    (-post["depth"] / 2, bottom),
                    (post["depth"] / 2, bottom),
                    (post["depth"] / 2, shoulder),
                    (groove_half, shoulder),
                    *[
                        (float(offset), float(center[2] - math.sqrt(radius**2 - offset**2)))
                        for offset in reversed(groove_y[1:-1])
                    ],
                    (-groove_half, shoulder),
                    (-post["depth"] / 2, shoulder),
                ]
                self.add(
                    "interiorPost",
                    f"interior-post:{x_index}:{index - 1}",
                    _profile_prism(profile, post["width"], "x"),
                    ["purlin-saddle"],
                )
                self.entity_by_key[f"interior-post:{x_index}:{index - 1}"].mesh.apply_translation([x, center[1], 0])

        rafter_half_range = float(assembly.get("rafterXHalfRange", 2400))
        rafter_x_positions = [float(value) for value in np.arange(-rafter_half_range, rafter_half_range + 0.1, rafter["spacing"])]
        self.rafter_count = len(rafter_x_positions)
        for side_name, sign in (("south", -1), ("north", 1)):
            for index, x in enumerate(rafter_x_positions):
                joint_start = sign * (curve["halfSpan"] - rafter["jointLength"])
                eave_y = sign * curve["halfSpan"]
                main_offset = -(board["thickness"] / 2 + rafter["height"] / 2)
                side_purlins = [value for value in y_positions if (value <= 0 if sign < 0 else value >= 0)]
                notch_half = rafter["purlinSeatWidth"] / 2
                interval_start, interval_end = sorted((0.0, joint_start))
                stations = {
                    float(value)
                    for value in np.arange(interval_start, interval_end + 0.001, min(20.0, curve["sampleStepMm"]))
                }
                stations.update((interval_start, interval_end))
                for purlin_y in side_purlins:
                    seat_start = max(interval_start, purlin_y - notch_half)
                    seat_end = min(interval_end, purlin_y + notch_half)
                    if seat_end > seat_start:
                        stations.update(float(value) for value in np.linspace(seat_start, seat_end, int(math.ceil((seat_end - seat_start) / 5.0)) + 1))

                top_profile: list[tuple[float, float]] = []
                bottom_profile: list[tuple[float, float]] = []
                purlin_radius = float(purlin["diameter"]) / 2
                for station in sorted(stations):
                    top_point = _roof_point(curve, station, 0.0, -board["thickness"] / 2, sign)
                    bottom_point = _roof_point(
                        curve,
                        station,
                        0.0,
                        -(board["thickness"] / 2 + rafter["height"]),
                        sign,
                    )
                    for purlin_y in side_purlins:
                        purlin_index = y_positions.index(purlin_y)
                        center = self.purlin_centers[purlin_index]
                        transverse_offset = float(bottom_point[1] - center[1])
                        if abs(transverse_offset) > notch_half + 1e-6:
                            continue
                        cylinder_top = float(center[2] + math.sqrt(max(0.0, purlin_radius**2 - transverse_offset**2)))
                        required_bottom = cylinder_top + float(rafter["purlinSeatClearance"])
                        bottom_point[2] = max(float(bottom_point[2]), required_bottom)
                    top_profile.append((float(top_point[1]), float(top_point[2])))
                    bottom_profile.append((float(bottom_point[1]), float(bottom_point[2])))

                main_profile = Polygon([*top_profile, *reversed(bottom_profile)])
                if not main_profile.is_valid:
                    raise ValueError(f"rafter seat profile is invalid for {side_name}:{index}")
                main_body = _profile_prism(list(main_profile.exterior.coords)[:-1], rafter["width"], "x")
                main_body.apply_translation([x, 0.0, 0.0])
                lower_joint_offset = -(board["thickness"] / 2 + rafter["height"] - rafter["jointDepth"] / 2)
                joint_path = _roof_path(curve, joint_start, eave_y, x, lower_joint_offset)
                main_mesh = trimesh.util.concatenate(
                    [
                        main_body,
                        _path_prism(joint_path, rafter["width"], rafter["jointDepth"]),
                    ]
                )
                seat_features = [f"purlin-bearing-seat:{y_positions.index(value)}" for value in side_purlins]
                self.add("rafter", f"rafter:{side_name}:{index}", main_mesh, ["fly-rafter-half-lap", *seat_features])

                upper_joint_offset = -(board["thickness"] / 2 + rafter["height"] - rafter["jointDepth"] - fly["jointDepth"] / 2)
                fly_joint_path = _roof_path(curve, joint_start, eave_y, x, upper_joint_offset)
                _, tangent, _ = _roof_frame(curve, eave_y, sign)
                fly_center_offset = -(board["thickness"] / 2 + fly["height"] / 2)
                fly_start = _roof_point(curve, eave_y, x, fly_center_offset, sign)
                fly_end = fly_start + tangent * fly["length"] * sign
                fly_mesh = trimesh.util.concatenate(
                    [
                        _path_prism(fly_joint_path, fly["width"], fly["jointDepth"]),
                        _path_prism([fly_start, fly_end], fly["width"], fly["height"]),
                    ]
                )
                self.add("flyRafter", f"fly-rafter:{side_name}:{index}", fly_mesh, ["rafter-half-lap", "eave-termination"])

            finished_half_span = _finished_half_span(curve, fly)
            panel_half_range = float(assembly.get("boardPanXHalfRange", 2250))
            panel_centers = [float(value) for value in np.arange(-panel_half_range, panel_half_range + 0.1, board["panelWidth"])]
            self.board_count = len(panel_centers)
            # 望板浮升：消除与椽顶的共面退化（默认 0 保持旧版输出）
            board_lift = float(assembly.get("roofBoardLiftMm", 0.0))
            for index, x in enumerate(panel_centers):
                path = _roof_path(curve, 0.0, sign * finished_half_span, x, board_lift - board["thickness"] / 2)
                self.add("roofBoard", f"roof-board:{side_name}:{index}", _path_prism(path, board["panelWidth"], board["thickness"]))

        closure = self.templates["eaveClosure"]["parameters"]
        finished_half_span = _finished_half_span(curve, fly)
        for side_name, sign in (("south", -1), ("north", 1)):
            y = sign * finished_half_span
            roof_z = _roof_curve_value(curve, y) + board_lift
            board_seat = _roof_point(curve, y, 0.0, board_lift - board["thickness"], sign)
            seat_y = float(board_seat[1])
            seat_z = float(board_seat[2])
            outer_y = seat_y + sign * closure["width"] / 2
            inner_y = seat_y - sign * closure["width"] / 2
            profile = Polygon(
                [
                    (inner_y, roof_z - board["thickness"] - closure["height"]),
                    (outer_y, roof_z - board["thickness"] - closure["height"]),
                    (outer_y, roof_z - closure["tileClearance"]),
                    (seat_y, seat_z),
                    (inner_y, seat_z),
                ]
            )
            self.add(
                "eaveClosure",
                f"eave-closure:{side_name}",
                _extrude_polygon(profile, closure["length"], "x"),
                ["tile-drainage-clearance"],
            )

    @staticmethod
    def _arm_profile(parameters: dict, *, top_notch: bool) -> list[tuple[float, float]]:
        length = parameters["length"]
        height = parameters["height"]
        notch = parameters["halfLapLength"] / 2
        end_rise = parameters["endRise"]
        if top_notch:
            return [
                (-length / 2, 0),
                (length / 2, 0),
                (length / 2, end_rise),
                (length / 2 - 120, height),
                (notch, height),
                (notch, parameters["halfLapDepth"]),
                (-notch, parameters["halfLapDepth"]),
                (-notch, height),
                (-length / 2 + 120, height),
                (-length / 2, end_rise),
            ]
        return [
            (-length / 2, 0),
            (-notch, 0),
            (-notch, parameters["halfLapDepth"]),
            (notch, parameters["halfLapDepth"]),
            (notch, 0),
            (length / 2, 0),
            (length / 2, end_rise),
            (length / 2 - 120, height),
            (-length / 2 + 120, height),
            (-length / 2, end_rise),
        ]

    def _build_eave_supports(self) -> None:
        assembly = self.fixture["assembly"]
        levels = assembly["levels"]
        seat = self.templates["bracketSeat"]["parameters"]
        arm = self.templates["bracketArm"]["parameters"]
        bearing = self.templates["bearingBlock"]["parameters"]
        purlin = self.templates["purlin"]["parameters"]
        seat_base_height = seat["height"] - seat["socketDepth"]
        arm_base = levels["eaveBeamTop"] + seat_base_height
        for x_index, x in enumerate(assembly["axisX"]):
            for y_index, y in enumerate(assembly["axisY"]):
                base = _box(
                    (x, y, levels["eaveBeamTop"] + seat_base_height / 2),
                    (seat["width"], seat["depth"], seat_base_height),
                )
                corner_parts = [base]
                corner_width = (seat["width"] - seat["socketWidth"]) / 2
                corner_depth = (seat["depth"] - seat["socketWidth"]) / 2
                for sx in (-1, 1):
                    for sy in (-1, 1):
                        corner_parts.append(
                            _box(
                                (
                                    x + sx * (seat["socketWidth"] / 2 + corner_width / 2),
                                    y + sy * (seat["socketWidth"] / 2 + corner_depth / 2),
                                    levels["eaveBeamTop"] + seat_base_height + seat["socketDepth"] / 2,
                                ),
                                (corner_width, corner_depth, seat["socketDepth"]),
                            )
                        )
                self.add(
                    "bracketSeat",
                    f"bracket-seat:{x_index}:{y_index}",
                    trimesh.util.concatenate(corner_parts),
                    ["seat-x-recess", "seat-y-recess"],
                )

                arm_x = _profile_prism(self._arm_profile(arm, top_notch=True), arm["width"], "y")
                arm_x.apply_translation([x, y, arm_base])
                self.add(
                    "bracketArm",
                    f"bracket-arm-x:{x_index}:{y_index}",
                    arm_x,
                    ["direction-x", "arm-x-half-lap-top"],
                )
                arm_y = _profile_prism(self._arm_profile(arm, top_notch=False), arm["width"], "x")
                arm_y.apply_translation([x, y, arm_base])
                self.add(
                    "bracketArm",
                    f"bracket-arm-y:{x_index}:{y_index}",
                    arm_y,
                    ["direction-y", "arm-y-half-lap-bottom"],
                )

                purlin_center = self.purlin_centers[0 if y < 0 else 6]
                radius = purlin["diameter"] / 2
                bearing_base = arm_base + arm["height"]
                shoulder_z = float(purlin_center[2]) - (radius - bearing["socketDepth"])
                body_height = shoulder_z - bearing_base
                if body_height < bearing["minimumBodyHeight"]:
                    raise ValueError("bearing block cannot reach the eave purlin")
                groove_half = math.sqrt(2 * radius * bearing["socketDepth"] - bearing["socketDepth"] ** 2)
                groove_y = np.linspace(-groove_half, groove_half, 13)
                groove = [
                    (float(offset), float(purlin_center[2] - math.sqrt(radius**2 - offset**2) - bearing_base))
                    for offset in groove_y
                ]
                profile = [
                    (-bearing["depth"] / 2, 0),
                    (bearing["depth"] / 2, 0),
                    (bearing["depth"] / 2, body_height),
                    (groove_half, body_height),
                    *list(reversed(groove[1:-1])),
                    (-groove_half, body_height),
                    (-bearing["depth"] / 2, body_height),
                ]
                block = _profile_prism(profile, bearing["width"], "x")
                block.apply_translation([x, purlin_center[1], bearing_base])
                self.add(
                    "bearingBlock",
                    f"bearing-block:{x_index}:{y_index}",
                    block,
                    ["bearing-saddle", "bearing-block-bottom"],
                )

    def _build_roof_finish(self) -> None:
        assembly = self.fixture["assembly"]
        curve = assembly["roofCurve"]
        pan = self.templates["panTile"]["parameters"]
        cover = self.templates["coverTile"]["parameters"]
        board = self.templates["roofBoard"]["parameters"]
        fly = self.templates["flyRafter"]["parameters"]
        finished_half_span = _finished_half_span(curve, fly)
        for side_name, sign in (("south", -1), ("north", 1)):
            row_count = int(math.floor((finished_half_span - pan["length"]) / pan["rowPitch"])) + 1
            pan_half_range = float(assembly.get("boardPanXHalfRange", 2250))
            cover_half_range = float(assembly.get("coverXHalfRange", 2400))
            finish_lift = float(assembly.get("roofBoardLiftMm", 0.0))
            pan_x = [float(value) for value in np.arange(-pan_half_range, pan_half_range + 0.1, pan["columnPitch"])]
            cover_x = [float(value) for value in np.arange(-cover_half_range, cover_half_range + 0.1, cover["columnPitch"])]
            self.tile_rows = row_count
            self.pan_columns = len(pan_x)
            self.cover_columns = len(cover_x)
            for x_index, x in enumerate(pan_x):
                for row in range(row_count):
                    distance = finished_half_span - pan["length"] / 2 - row * pan["rowPitch"]
                    mesh = _curved_roof_tile(
                        width=pan["width"],
                        rise=pan["rise"],
                        thickness=pan["thickness"],
                        length=pan["length"],
                        overlap=pan["overlap"],
                        convex=False,
                        curve=curve,
                        x=x,
                        y=sign * distance,
                        normal_offset=pan["thickness"] + finish_lift,
                        longitudinal_sections=int(pan["longitudinalSegments"]),
                        raised_overlap=row > 0,
                        lap_clearance=float(pan["lapClearance"]),
                    )
                    self.add("panTile", f"pan-tile:{side_name}:{x_index}:{row}", mesh, [f"lap-row-{row}"])
            for x_index, x in enumerate(cover_x):
                for row in range(row_count):
                    distance = finished_half_span - cover["length"] / 2 - row * cover["rowPitch"]
                    bearing_offset = (
                        pan["thickness"]
                        + pan["rise"] * ((pan["columnPitch"] / 2 - cover["width"] / 2) / (pan["width"] / 2)) ** 2
                        + cover["thickness"]
                    )
                    mesh = _curved_roof_tile(
                        width=cover["width"],
                        rise=cover["rise"],
                        thickness=cover["thickness"],
                        length=cover["length"],
                        overlap=cover["overlap"],
                        convex=True,
                        curve=curve,
                        x=x,
                        y=sign * distance,
                        normal_offset=bearing_offset + finish_lift,
                        longitudinal_sections=int(cover["longitudinalSegments"]),
                        raised_overlap=row > 0,
                        lap_clearance=float(cover["lapClearance"]),
                    )
                    self.add("coverTile", f"cover-tile:{side_name}:{x_index}:{row}", mesh, [f"lap-row-{row}"])

        ridge = self.templates["ridgeTile"]["parameters"]
        count = int(math.ceil(assembly["roofWidth"] / ridge["segmentLength"]))
        segment = assembly["roofWidth"] / count
        for index in range(count):
            x = -assembly["roofWidth"] / 2 + segment * (index + 0.5)
            half_width = float(ridge["baseWidth"]) / 2
            segment_min_x = x - segment / 2
            segment_max_x = x + segment / 2
            finish_witnesses: list[tuple[SemanticEntity, np.ndarray]] = []
            for entity in self.entities:
                if entity.component_type not in {"panTile", "coverTile"}:
                    continue
                vertices = np.asarray(entity.mesh.vertices, dtype=float)
                mask = (
                    (vertices[:, 0] >= segment_min_x - 1e-6)
                    & (vertices[:, 0] <= segment_max_x + 1e-6)
                    & (np.abs(vertices[:, 1]) <= half_width + 1e-6)
                )
                if np.any(mask):
                    finish_witnesses.append((entity, vertices[mask]))
            if not finish_witnesses:
                raise ValueError(f"ridge segment {index} has no roof-finish saddle witnesses")
            finish_vertices = np.vstack([vertices for _, vertices in finish_witnesses])
            central_bottom = float(curve["ridgeHeight"] - ridge["seatDepth"])
            body_bottom = max(
                central_bottom,
                float(np.max(finish_vertices[:, 2])) + float(ridge["roofFinishClearance"]),
            )
            finish_inner_edge = float(np.min(np.abs(finish_vertices[:, 1])))
            tongue_half = max(0.0, min(half_width - 5.0, finish_inner_edge - 5.0))
            ridge_roll_base_z = body_bottom + float(ridge["baseHeight"])
            base = _box(
                (x, 0.0, body_bottom + float(ridge["baseHeight"]) / 2),
                (segment, float(ridge["baseWidth"]), float(ridge["baseHeight"])),
            )
            support_parts = [base]
            tongue_height = body_bottom - central_bottom
            if tongue_height > 1e-6 and tongue_half > 1e-6:
                support_parts.append(
                    _box(
                        (x, 0.0, central_bottom + tongue_height / 2),
                        (segment, tongue_half * 2, tongue_height),
                    )
                )
            support_width = float(ridge["ridgeSupportPadWidth"])
            for _, vertices in finish_witnesses:
                witness = vertices[int(np.argmax(vertices[:, 2]))]
                pad_bottom = float(witness[2] + ridge["roofFinishClearance"])
                pad_height = body_bottom - pad_bottom
                if pad_height <= 1e-6:
                    continue
                support_parts.append(
                    _box(
                        (float(witness[0]), float(witness[1]), pad_bottom + pad_height / 2),
                        (support_width, support_width, pad_height),
                    )
                )
            roll = trimesh.creation.cylinder(
                radius=ridge["rollRadius"],
                segment=[[x - segment / 2, 0, ridge_roll_base_z + ridge["rollRadius"]], [x + segment / 2, 0, ridge_roll_base_z + ridge["rollRadius"]]],
                sections=24,
            )
            cap = _profile_prism(
                [(-ridge["baseWidth"] / 4, 0), (ridge["baseWidth"] / 4, 0), (0, ridge["capHeight"])],
                segment,
                "x",
            )
            cap.apply_translation([x, 0, ridge_roll_base_z + ridge["rollRadius"] * 2])
            self.add(
                "ridgeTile",
                f"ridge-tile:{index}",
                trimesh.util.concatenate([*support_parts, roll, cap]),
                ["roof-finish-saddle", "roof-finish-support-pads"],
            )

        # 可选形制补全件：山面封板与山边脊件（模板存在时才构建）
        if "gableBoard" in self.templates:
            board_parameters = self.templates["gableBoard"]["parameters"]
            fly = self.templates["flyRafter"]["parameters"]
            finished_half_span = _finished_half_span(curve, fly)
            for gable_name, gable_sign in (("west", -1), ("east", 1)):
                for side_name, sign in (("south", -1), ("north", 1)):
                    x_center = gable_sign * (assembly["roofWidth"] / 2 + board_parameters["width"] / 2)
                    path = _roof_path(
                        curve, 0.0, sign * finished_half_span, x_center,
                        90.0 - board_parameters["depth"] / 2,
                    )
                    self.add(
                        "gableBoard",
                        f"gable-board:{gable_name}:{side_name}",
                        _path_prism(path, board_parameters["width"], board_parameters["depth"]),
                        ["gable-edge-closure"],
                    )
        if "gableRidgeCap" in self.templates:
            cap_parameters = self.templates["gableRidgeCap"]["parameters"]
            fly = self.templates["flyRafter"]["parameters"]
            finished_half_span = _finished_half_span(curve, fly)
            ridge_clear = float(self.templates["ridgeTile"]["parameters"]["baseWidth"]) / 2 + 20.0
            for gable_name, gable_sign in (("west", -1), ("east", 1)):
                for side_name, sign in (("south", -1), ("north", 1)):
                    x_center = gable_sign * (assembly["roofWidth"] / 2 - cap_parameters["width"] / 2)
                    path = _roof_path(
                        curve, sign * ridge_clear, sign * (finished_half_span - 30.0), x_center,
                        80.0 + cap_parameters["height"] / 2,
                    )
                    self.add(
                        "gableRidgeCap",
                        f"gable-ridge:{gable_name}:{side_name}",
                        _path_prism(path, cap_parameters["width"], cap_parameters["height"]),
                        ["gable-edge-finish"],
                    )

    @staticmethod
    def _notched_stile(
        *,
        center_x: float,
        width: float,
        depth: float,
        z0: float,
        z1: float,
        inner_side: int,
        notches: list[tuple[float, float, float]],
    ) -> trimesh.Trimesh:
        polygon = polygon_box(center_x - width / 2, z0, center_x + width / 2, z1)
        for center_z, notch_height, notch_depth in notches:
            if inner_side > 0:
                cutter = polygon_box(center_x + width / 2 - notch_depth, center_z - notch_height / 2, center_x + width / 2 + 1, center_z + notch_height / 2)
            else:
                cutter = polygon_box(center_x - width / 2 - 1, center_z - notch_height / 2, center_x - width / 2 + notch_depth, center_z + notch_height / 2)
            polygon = polygon.difference(cutter)
        return _extrude_polygon(polygon, depth, "y")

    @staticmethod
    def _tenoned_horizontal_member(
        *,
        x0: float,
        x1: float,
        center_z: float,
        body_height: float,
        depth: float,
        tenon_length: float,
        tenon_height: float,
    ) -> trimesh.Trimesh:
        body = polygon_box(x0, center_z - body_height / 2, x1, center_z + body_height / 2)
        tenons = unary_union(
            [
                polygon_box(x0 - tenon_length, center_z - tenon_height / 2, x0, center_z + tenon_height / 2),
                polygon_box(x1, center_z - tenon_height / 2, x1 + tenon_length, center_z + tenon_height / 2),
            ]
        )
        return _extrude_polygon(body.union(tenons), depth, "y")

    @staticmethod
    def _single_solid_grooved_housed_horizontal_member(
        *,
        x0: float,
        x1: float,
        center_z: float,
        body_height: float,
        depth: float,
        housing_depth: float,
        groove_depth: float,
        groove_width: float,
    ) -> trimesh.Trimesh:
        if groove_depth * 2 >= body_height or groove_width >= depth:
            raise ValueError("door rail groove exceeds the rail section")
        section = polygon_box(-depth / 2, center_z - body_height / 2, depth / 2, center_z + body_height / 2)
        grooves = unary_union(
            [
                polygon_box(-groove_width / 2, center_z - body_height / 2 - 1, groove_width / 2, center_z - body_height / 2 + groove_depth),
                polygon_box(-groove_width / 2, center_z + body_height / 2 - groove_depth, groove_width / 2, center_z + body_height / 2 + 1),
            ]
        )
        mesh = _extrude_polygon(section.difference(grooves), x1 - x0 + housing_depth * 2, "x")
        mesh.apply_translation([(x0 + x1) / 2, 0.0, 0.0])
        return mesh

    @staticmethod
    def _tongued_panel(
        *,
        x0: float,
        x1: float,
        center_y: float,
        z0: float,
        z1: float,
        body_depth: float,
        tongue_length: float,
        tongue_thickness: float,
    ) -> trimesh.Trimesh:
        if abs(tongue_thickness - body_depth) > 1e-6:
            raise ValueError("a single-solid panel requires edge tongues to retain the panel depth")
        body = polygon_box(x0, z0, x1, z1)
        tongues = unary_union(
            [
                polygon_box(x0 - tongue_length, z0, x0, z1),
                polygon_box(x1, z0, x1 + tongue_length, z1),
                polygon_box(x0, z0 - tongue_length, x1, z0),
                polygon_box(x0, z1, x1, z1 + tongue_length),
            ]
        )
        mesh = _extrude_polygon(body.union(tongues), body_depth, "y")
        mesh.apply_translation([0.0, center_y, 0.0])
        return mesh

    @staticmethod
    def _segmented_lattice_bar(
        *,
        axis: str,
        fixed: float,
        start: float,
        end: float,
        crossings: list[float],
        bar_width: float,
        depth: float,
        center_y: float,
        half_lap_depth: float,
        front_half: bool,
    ) -> trimesh.Trimesh:
        parts: list[trimesh.Trimesh] = []
        intervals = [start, *(value - bar_width / 2 for value in crossings), *(value + bar_width / 2 for value in crossings), end]
        intervals = sorted(set(intervals))
        for a, b in zip(intervals[:-1], intervals[1:]):
            midpoint = (a + b) / 2
            at_crossing = any(abs(midpoint - value) <= bar_width / 2 + 1e-6 for value in crossings)
            local_depth = half_lap_depth if at_crossing else depth
            if at_crossing:
                y = center_y - (depth - half_lap_depth) / 2 if not front_half else center_y + (depth - half_lap_depth) / 2
            else:
                y = center_y
            if axis == "vertical":
                parts.append(_box((fixed, y, midpoint), (bar_width, local_depth, b - a)))
            else:
                parts.append(_box((midpoint, y, fixed), (b - a, local_depth, bar_width)))
        return trimesh.util.concatenate(parts)

    def _build_enclosure(self) -> None:
        assembly = self.fixture["assembly"]
        levels = assembly["levels"]
        wall = self.templates["wall"]["parameters"]
        frame = self.templates["doorFrameMember"]["parameters"]
        y = float(assembly["axisY"][0])
        z0 = levels["terraceTop"]
        z1 = z0 + wall["baseHeight"] + wall["panelHeight"]
        outer = polygon_box(assembly["axisX"][0], z0, assembly["axisX"][1], z1)
        door_rough_width = frame["openingWidth"] + frame["stileWidth"] * 2
        door_rough_height = frame["thresholdHeight"] + frame["openingHeight"] + frame["headHeight"]
        door_opening = polygon_box(-door_rough_width / 2, z0, door_rough_width / 2, z0 + door_rough_height)
        window_openings = [
            polygon_box(
                center_x - wall["windowWidth"] / 2,
                z0 + wall["windowSill"],
                center_x + wall["windowWidth"] / 2,
                z0 + wall["windowSill"] + wall["windowHeight"],
            )
            for center_x in (-float(assembly.get("windowCenterX", 1300)), float(assembly.get("windowCenterX", 1300)))
        ]
        openings = [door_opening, *window_openings]
        core_depth = wall["thickness"] - wall["finishThickness"] * 2
        core = _rectangular_opening_solid(outer, openings, core_depth, "y")
        core.apply_translation([0, y, 0])
        front = _rectangular_opening_solid(outer, openings, wall["finishThickness"], "y")
        front.apply_translation([0, y - core_depth / 2 - wall["finishThickness"] / 2, 0])
        back = _rectangular_opening_solid(outer, openings, wall["finishThickness"], "y")
        back.apply_translation([0, y + core_depth / 2 + wall["finishThickness"] / 2, 0])
        self.add("wall", "wall:south:left", trimesh.util.concatenate([core, front, back]), ["door-opening", "window-opening-left", "window-opening-right", "opening-reveals"])

        frame_y = y - wall["thickness"] / 2 + frame["memberDepth"] / 2
        left_center = -frame["openingWidth"] / 2 - frame["stileWidth"] / 2
        right_center = frame["openingWidth"] / 2 + frame["stileWidth"] / 2
        stile_z0 = z0
        stile_z1 = z0 + frame["thresholdHeight"] + frame["openingHeight"] + frame["headHeight"]
        head_center_z = z0 + frame["thresholdHeight"] + frame["openingHeight"] + frame["headHeight"] / 2
        threshold_center_z = z0 + frame["thresholdHeight"] / 2
        frame_notches = [
            (head_center_z, frame["tenonHeight"], frame["tenonLength"]),
            (threshold_center_z, frame["tenonHeight"], frame["tenonLength"]),
        ]
        left_stile = self._notched_stile(
            center_x=left_center,
            width=frame["stileWidth"],
            depth=frame["memberDepth"],
            z0=stile_z0,
            z1=stile_z1,
            inner_side=1,
            notches=frame_notches,
        )
        left_stile.apply_translation([0, frame_y, 0])
        self.add("doorFrameMember", "door-frame:left-stile", left_stile, ["left-stile-head-mortise", "left-stile-threshold-mortise"])
        right_stile = self._notched_stile(
            center_x=right_center,
            width=frame["stileWidth"],
            depth=frame["memberDepth"],
            z0=stile_z0,
            z1=stile_z1,
            inner_side=-1,
            notches=frame_notches,
        )
        right_stile.apply_translation([0, frame_y, 0])
        self.add("doorFrameMember", "door-frame:right-stile", right_stile, ["right-stile-head-mortise", "right-stile-threshold-mortise"])
        head = self._tenoned_horizontal_member(
            x0=-frame["openingWidth"] / 2,
            x1=frame["openingWidth"] / 2,
            center_z=head_center_z,
            body_height=frame["headHeight"],
            depth=frame["memberDepth"],
            tenon_length=frame["tenonLength"],
            tenon_height=frame["tenonHeight"],
        )
        head.apply_translation([0, frame_y, 0])
        self.add("doorFrameMember", "door-frame:head", head, ["head-left-tenon", "head-right-tenon"])
        threshold = self._tenoned_horizontal_member(
            x0=-frame["openingWidth"] / 2,
            x1=frame["openingWidth"] / 2,
            center_z=threshold_center_z,
            body_height=frame["thresholdHeight"],
            depth=frame["memberDepth"],
            tenon_length=frame["tenonLength"],
            tenon_height=frame["tenonHeight"],
        )
        threshold.apply_translation([0, frame_y, 0])
        self.add("doorFrameMember", "door-frame:threshold", threshold, ["threshold-left-tenon", "threshold-right-tenon"])

        stile = self.templates["doorLeafStile"]["parameters"]
        rail = self.templates["doorLeafRail"]["parameters"]
        panel = self.templates["doorLeafPanel"]["parameters"]
        center_gap = 8
        side_clearance = 8
        leaf_width = (frame["openingWidth"] - center_gap - side_clearance * 2) / 2
        leaf_bottom = z0 + frame["thresholdHeight"] + 30
        leaf_top = leaf_bottom + stile["height"]
        rail_centers = [float(value) for value in np.linspace(leaf_bottom + rail["height"] / 2, leaf_top - rail["height"] / 2, int(rail["countPerLeaf"]))]
        leaf_y = frame_y - 15
        for leaf_index, center_x in enumerate((-(center_gap / 2 + leaf_width / 2), center_gap / 2 + leaf_width / 2)):
            left_x = center_x - leaf_width / 2 + stile["width"] / 2
            right_x = center_x + leaf_width / 2 - stile["width"] / 2
            panel_intervals = [
                (rail_centers[index] + rail["height"] / 2, rail_centers[index + 1] - rail["height"] / 2)
                for index in range(len(rail_centers) - 1)
            ]
            notches = [(value, rail["height"], rail["housingDepth"]) for value in rail_centers]
            notches.extend(((a + b) / 2, b - a, stile["panelGrooveDepth"]) for a, b in panel_intervals)
            left_mesh = self._notched_stile(
                center_x=left_x,
                width=stile["width"],
                depth=stile["depth"],
                z0=leaf_bottom,
                z1=leaf_top,
                inner_side=1,
                notches=notches,
            )
            left_mesh.apply_translation([0, leaf_y, 0])
            self.add("doorLeafStile", f"door-leaf:{leaf_index}:stile:left", left_mesh, ["stile-panel-groove", *[f"stile-rail-mortise-{index}" for index in range(len(rail_centers))]])
            right_mesh = self._notched_stile(
                center_x=right_x,
                width=stile["width"],
                depth=stile["depth"],
                z0=leaf_bottom,
                z1=leaf_top,
                inner_side=-1,
                notches=notches,
            )
            right_mesh.apply_translation([0, leaf_y, 0])
            self.add("doorLeafStile", f"door-leaf:{leaf_index}:stile:right", right_mesh, ["stile-panel-groove", *[f"stile-rail-mortise-{index}" for index in range(len(rail_centers))]])
            inner_x0 = left_x + stile["width"] / 2
            inner_x1 = right_x - stile["width"] / 2
            for rail_index, center_z in enumerate(rail_centers):
                rail_mesh = self._single_solid_grooved_housed_horizontal_member(
                    x0=inner_x0,
                    x1=inner_x1,
                    center_z=center_z,
                    body_height=rail["height"],
                    depth=rail["depth"],
                    housing_depth=rail["housingDepth"],
                    groove_depth=rail["panelGrooveDepth"],
                    groove_width=rail["panelGrooveWidth"],
                )
                rail_mesh.apply_translation([0, leaf_y, 0])
                self.add("doorLeafRail", f"door-leaf:{leaf_index}:rail:{rail_index}", rail_mesh, ["rail-left-housed-projection", "rail-right-housed-projection", "rail-panel-through-grooves"])
            for panel_index, (panel_z0, panel_z1) in enumerate(panel_intervals):
                panel_mesh = self._tongued_panel(
                    x0=inner_x0,
                    x1=inner_x1,
                    center_y=leaf_y,
                    z0=panel_z0,
                    z1=panel_z1,
                    body_depth=panel["depth"],
                    tongue_length=panel["edgeTongue"],
                    tongue_thickness=panel["edgeTongueThickness"],
                )
                self.add(
                    "doorLeafPanel",
                    f"door-leaf:{leaf_index}:panel:{panel_index}",
                    panel_mesh,
                    ["panel-left-tongue", "panel-right-tongue", "panel-top-tongue", "panel-bottom-tongue"],
                )

        lattice_frame = self.templates["latticeFrameMember"]["parameters"]
        lattice = self.templates["latticeBar"]["parameters"]
        sill = z0 + wall["windowSill"]
        window_center_x = float(assembly.get("windowCenterX", 1300))
        for side, center_x in (("left", -window_center_x), ("right", window_center_x)):
            window_y = y - wall["thickness"] / 2 + lattice_frame["depth"] / 2
            left = center_x - lattice_frame["width"] / 2
            right = center_x + lattice_frame["width"] / 2
            bottom = sill
            top = sill + lattice_frame["height"]
            frame_members = {
                "left": _box((left + lattice_frame["memberWidth"] / 2, window_y, (bottom + top) / 2), (lattice_frame["memberWidth"], lattice_frame["depth"], top - bottom)),
                "right": _box((right - lattice_frame["memberWidth"] / 2, window_y, (bottom + top) / 2), (lattice_frame["memberWidth"], lattice_frame["depth"], top - bottom)),
                "bottom": _box((center_x, window_y, bottom + lattice_frame["memberWidth"] / 2), (right - left - lattice_frame["memberWidth"] * 2, lattice_frame["depth"], lattice_frame["memberWidth"])),
                "top": _box((center_x, window_y, top - lattice_frame["memberWidth"] / 2), (right - left - lattice_frame["memberWidth"] * 2, lattice_frame["depth"], lattice_frame["memberWidth"])),
            }
            for name, mesh in frame_members.items():
                self.add("latticeFrameMember", f"lattice:{side}:frame:{name}", mesh, [f"frame-{name}", "wall-opening-closure"])
            inner_left = left + lattice_frame["memberWidth"]
            inner_right = right - lattice_frame["memberWidth"]
            inner_bottom = bottom + lattice_frame["memberWidth"]
            inner_top = top - lattice_frame["memberWidth"]
            vertical_positions = [
                inner_left + index * (inner_right - inner_left) / lattice["columns"]
                for index in range(1, int(lattice["columns"]))
            ]
            horizontal_positions = [
                inner_bottom + index * (inner_top - inner_bottom) / lattice["rows"]
                for index in range(1, int(lattice["rows"]))
            ]
            for index, x in enumerate(vertical_positions, 1):
                mesh = self._segmented_lattice_bar(
                    axis="vertical", fixed=x, start=inner_bottom, end=inner_top, crossings=horizontal_positions,
                    bar_width=lattice["barWidth"], depth=lattice["depth"], center_y=window_y,
                    half_lap_depth=lattice["halfLapDepth"], front_half=False,
                )
                self.add("latticeBar", f"lattice:{side}:vbar:{index}", mesh, ["vertical-bar", *[f"half-lap-{row}" for row in range(1, int(lattice["rows"]))]])
            for index, z in enumerate(horizontal_positions, 1):
                mesh = self._segmented_lattice_bar(
                    axis="horizontal", fixed=z, start=inner_left, end=inner_right, crossings=vertical_positions,
                    bar_width=lattice["barWidth"], depth=lattice["depth"], center_y=window_y,
                    half_lap_depth=lattice["halfLapDepth"], front_half=True,
                )
                self.add("latticeBar", f"lattice:{side}:hbar:{index}", mesh, ["horizontal-bar", *[f"half-lap-{column}" for column in range(1, int(lattice["columns"]))]])

    def _resolve_interfaces(self) -> list[dict]:
        template_by_role = {item["role"]: item for item in self.fixture["interfaceTemplates"]}
        bindings: list[dict] = []

        def bind(
            role: str,
            source_key: str,
            target_key: str,
            suffix: str,
            *,
            from_surface: str | None = None,
            to_surface: str | None = None,
        ) -> None:
            template = dict(template_by_role[role])
            template["interfaceId"] = f"IF-{role.upper()}-{suffix.upper()}".replace(":", "-")
            template["fromEntityKey"] = source_key
            template["toEntityKey"] = target_key
            if from_surface is not None:
                template["fromSurfaceRef"] = from_surface
            if to_surface is not None:
                template["toSurfaceRef"] = to_surface
            bindings.append(template)

        for course in (1, 2):
            ground_key = f"ground:ring:foundation-course:{course}"
            for x_index in range(2):
                for y_index in range(2):
                    bind(
                        "foundation-ground",
                        f"foundation:{x_index}:{y_index}:course:{course}",
                        ground_key,
                        f"{x_index}-{y_index}-c{course}",
                    )
        for x_index in range(2):
            for y_index in range(2):
                bind(
                    "foundation-bearing-ground",
                    f"foundation:{x_index}:{y_index}:course:0",
                    f"ground:bearing:{x_index}:{y_index}",
                    f"{x_index}-{y_index}",
                )
                for course in (1, 2):
                    bind(
                        "foundation-course-stack",
                        f"foundation:{x_index}:{y_index}:course:{course}",
                        f"foundation:{x_index}:{y_index}:course:{course - 1}",
                        f"{x_index}-{y_index}-c{course}",
                    )
                bind("terrace-foundation", "terrace:course:0", f"foundation:{x_index}:{y_index}:course:2", f"{x_index}-{y_index}")
                bind("column-base", f"column:{x_index}:{y_index}", f"column-base:{x_index}:{y_index}", f"{x_index}-{y_index}")
                bind("base-terrace", f"column-base:{x_index}:{y_index}", "terrace:course:2", f"{x_index}-{y_index}")
                bind("column-eave-beam", f"eave-beam:{y_index}", f"column:{x_index}:{y_index}", f"{x_index}-{y_index}")
                bind("column-tie-beam", f"tie-beam:{x_index}", f"column:{x_index}:{y_index}", f"{x_index}-{y_index}")
                bind("eave-beam-seat", f"bracket-seat:{x_index}:{y_index}", f"eave-beam:{y_index}", f"{x_index}-{y_index}")
                bind("seat-arm-x", f"bracket-arm-x:{x_index}:{y_index}", f"bracket-seat:{x_index}:{y_index}", f"{x_index}-{y_index}")
                bind("seat-arm-y", f"bracket-arm-y:{x_index}:{y_index}", f"bracket-seat:{x_index}:{y_index}", f"{x_index}-{y_index}")
                bind("arm-cross-half-lap", f"bracket-arm-y:{x_index}:{y_index}", f"bracket-arm-x:{x_index}:{y_index}", f"{x_index}-{y_index}")
                for arm_axis in ("x", "y"):
                    bind(
                        "arm-bearing-block",
                        f"bearing-block:{x_index}:{y_index}",
                        f"bracket-arm-{arm_axis}:{x_index}:{y_index}",
                        f"{x_index}-{y_index}-{arm_axis}",
                    )
                bind(
                    "bearing-block-purlin",
                    f"purlin:{0 if y_index == 0 else len(self.purlin_y_positions) - 1}",
                    f"bearing-block:{x_index}:{y_index}",
                    f"{x_index}-{y_index}",
                )

        for course in (1, 2):
            bind("terrace-course-stack", f"terrace:course:{course}", f"terrace:course:{course - 1}", f"c{course}")
            bind("step-course-stack", f"step:south:{course}", f"step:south:{course - 1}", f"c{course}")
        bind("ground-step", "step:south:0", "ground:ring:foundation-course:2", "south")
        bind("step-terrace", "step:south:2", "terrace:course:2", "south")

        for x_index in range(2):
            for post_index, purlin_index in enumerate(range(1, len(self.purlin_y_positions) - 1)):
                bind("tie-beam-interior-post", f"interior-post:{x_index}:{post_index}", f"tie-beam:{x_index}", f"{x_index}-{post_index}")
                bind("interior-post-purlin", f"purlin:{purlin_index}", f"interior-post:{x_index}:{post_index}", f"{x_index}-{post_index}")

        purlin_total = len(self.purlin_y_positions)
        for side in ("south", "north"):
            purlin_indices = range(0, (purlin_total + 1) // 2) if side == "south" else range(purlin_total // 2, purlin_total)
            for rafter_index in range(self.rafter_count):
                for purlin_index in purlin_indices:
                    bind("rafter-purlin", f"rafter:{side}:{rafter_index}", f"purlin:{purlin_index}", f"{side}-{rafter_index}-p{purlin_index}")
                bind("fly-rafter-rafter", f"fly-rafter:{side}:{rafter_index}", f"rafter:{side}:{rafter_index}", f"{side}-{rafter_index}")
            for board_index in range(self.board_count):
                for rafter_index in (board_index, board_index + 1):
                    bind("roof-board-rafter", f"roof-board:{side}:{board_index}", f"rafter:{side}:{rafter_index}", f"{side}-{board_index}-r{rafter_index}")
                for row in range(self.tile_rows):
                    bind("pan-tile-roof-board", f"pan-tile:{side}:{board_index}:{row}", f"roof-board:{side}:{board_index}", f"{side}-{board_index}-{row}")
            for cover_index in range(self.cover_columns):
                for pan_index in (cover_index - 1, cover_index):
                    if 0 <= pan_index < self.pan_columns:
                        for row in range(self.tile_rows):
                            bind("cover-tile-pan-tile", f"cover-tile:{side}:{cover_index}:{row}", f"pan-tile:{side}:{pan_index}:{row}", f"{side}-c{cover_index}-p{pan_index}-r{row}")
            for tile_type, column_count in (("pan-tile", self.pan_columns), ("cover-tile", self.cover_columns)):
                for column in range(column_count):
                    for row in range(1, self.tile_rows):
                        bind(
                            "tile-longitudinal-lap",
                            f"{tile_type}:{side}:{column}:{row}",
                            f"{tile_type}:{side}:{column}:{row - 1}",
                            f"{tile_type}-{side}-{column}-{row}",
                        )
            for board_index in range(self.board_count):
                bind("eave-closure", f"eave-closure:{side}", f"roof-board:{side}:{board_index}", f"{side}-{board_index}")

        ridge_entities = [item for item in self.entities if item.component_type == "ridgeTile"]
        ridge_finish = [
            item
            for item in self.entities
            if item.component_type in {"panTile", "coverTile"} and item.key.endswith(f":{self.tile_rows - 1}")
        ]
        for ridge in ridge_entities:
            ridge_bounds = np.asarray(ridge.mesh.bounds, dtype=float)
            for finish in ridge_finish:
                finish_bounds = np.asarray(finish.mesh.bounds, dtype=float)
                if min(ridge_bounds[1, 0], finish_bounds[1, 0]) - max(ridge_bounds[0, 0], finish_bounds[0, 0]) > 0:
                    bind("ridge-roof-finish", ridge.key, finish.key, f"{ridge.key}-{finish.key}")

        if "gableBoard" in self.templates:
            last_purlin = len(self.purlin_y_positions) - 1
            for gable_name in ("west", "east"):
                for side_name, purlin_index in (("south", 0), ("north", last_purlin)):
                    bind(
                        "gable-board-purlin",
                        f"gable-board:{gable_name}:{side_name}",
                        f"purlin:{purlin_index}",
                        f"{gable_name}-{side_name}",
                    )
                    if "gableRidgeCap" in self.templates:
                        bind(
                            "gable-ridge-board",
                            f"gable-ridge:{gable_name}:{side_name}",
                            f"gable-board:{gable_name}:{side_name}",
                            f"{gable_name}-{side_name}",
                        )

        bind("wall-terrace", "wall:south:left", "terrace:course:2", "south")
        bind("door-frame-terrace", "door-frame:threshold", "terrace:course:2", "south")
        for horizontal in ("head", "threshold"):
            for vertical in ("left-stile", "right-stile"):
                bind("frame-corner-joint", f"door-frame:{horizontal}", f"door-frame:{vertical}", f"{horizontal}-{vertical}")
        for frame_member in ("left-stile", "right-stile", "head"):
            bind("opening-closure", f"door-frame:{frame_member}", "wall:south:left", f"door-{frame_member}")

        for leaf in range(2):
            for rail in range(5):
                for stile_side in ("left", "right"):
                    bind("door-leaf-rail-stile", f"door-leaf:{leaf}:rail:{rail}", f"door-leaf:{leaf}:stile:{stile_side}", f"{leaf}-{rail}-{stile_side}")
            for panel in range(4):
                for stile_side in ("left", "right"):
                    bind("door-panel-groove", f"door-leaf:{leaf}:panel:{panel}", f"door-leaf:{leaf}:stile:{stile_side}", f"{leaf}-p{panel}-{stile_side}")
                for rail in (panel, panel + 1):
                    bind("door-panel-groove", f"door-leaf:{leaf}:panel:{panel}", f"door-leaf:{leaf}:rail:{rail}", f"{leaf}-p{panel}-r{rail}")
        bind("door-leaf-clearance", "door-leaf:0:stile:right", "door-leaf:1:stile:left", "center")
        bind("door-leaf-clearance", "door-leaf:0:stile:left", "door-frame:left-stile", "left-jamb")
        bind("door-leaf-clearance", "door-leaf:1:stile:right", "door-frame:right-stile", "right-jamb")

        for side in ("left", "right"):
            for horizontal in ("top", "bottom"):
                for vertical in ("left", "right"):
                    bind("lattice-frame-corner", f"lattice:{side}:frame:{horizontal}", f"lattice:{side}:frame:{vertical}", f"{side}-{horizontal}-{vertical}")
            for member in ("left", "right", "top", "bottom"):
                bind("opening-closure", f"lattice:{side}:frame:{member}", "wall:south:left", f"window-{side}-{member}")
            for vertical in range(1, 3):
                for horizontal in range(1, 4):
                    bind("lattice-cross-joint", f"lattice:{side}:hbar:{horizontal}", f"lattice:{side}:vbar:{vertical}", f"{side}-h{horizontal}-v{vertical}")
            for vertical in range(1, 3):
                for frame_member in ("top", "bottom"):
                    bind("lattice-bar-frame", f"lattice:{side}:vbar:{vertical}", f"lattice:{side}:frame:{frame_member}", f"{side}-v{vertical}-{frame_member}")
            for horizontal in range(1, 4):
                for frame_member in ("left", "right"):
                    bind("lattice-bar-frame", f"lattice:{side}:hbar:{horizontal}", f"lattice:{side}:frame:{frame_member}", f"{side}-h{horizontal}-{frame_member}")

        surface_cache: dict[str, dict] = {}

        def surface_data(entity: SemanticEntity) -> dict:
            cached = surface_cache.get(entity.entity_id)
            if cached is not None:
                return cached
            vertices = np.asarray(entity.mesh.vertices, dtype=float)
            centers = np.asarray(entity.mesh.triangles_center, dtype=float)
            samples = np.vstack([vertices, centers])
            cached = {
                "vertices": vertices,
                "faceCenters": centers,
                "samples": samples,
                "vertexFaces": np.asarray(entity.mesh.vertex_faces, dtype=int),
                "bounds": np.asarray(entity.mesh.bounds, dtype=float),
            }
            surface_cache[entity.entity_id] = cached
            return cached

        def patch_faces(data: dict, sample_indices: np.ndarray) -> set[int]:
            face_ids: set[int] = set()
            vertex_count = len(data["vertices"])
            for sample_index in sample_indices.tolist():
                if sample_index < vertex_count:
                    face_ids.update(int(item) for item in data["vertexFaces"][sample_index] if int(item) >= 0)
                else:
                    face_ids.add(int(sample_index - vertex_count))
            return face_ids

        def patch_descriptor(entity: SemanticEntity, face_ids: set[int]) -> dict:
            ordered = np.asarray(sorted(face_ids), dtype=int)
            areas = np.asarray(entity.mesh.area_faces, dtype=float)[ordered]
            centers = np.asarray(entity.mesh.triangles_center, dtype=float)[ordered]
            normals = np.asarray(entity.mesh.face_normals, dtype=float)[ordered]
            area = float(np.sum(areas))
            centroid = np.average(centers, axis=0, weights=areas) if area > 0 else np.mean(centers, axis=0)
            normal = np.sum(normals * areas[:, None], axis=0)
            magnitude = float(np.linalg.norm(normal))
            if magnitude > 0:
                normal /= magnitude
            triangle_payload = [
                _canonical_triangle(np.asarray(entity.mesh.vertices, dtype=float)[face])
                for face in np.asarray(entity.mesh.faces, dtype=int)[ordered]
            ]
            return {
                "faceCount": int(len(ordered)),
                "areaMm2": round(area, 6),
                "centroidMm": np.round(centroid, 6).tolist(),
                "areaWeightedNormal": np.round(normal, 9).tolist(),
                "patchHash": sha256(_canonical(sorted(triangle_payload)).encode("utf-8")).hexdigest(),
            }

        def surface_witness(source: SemanticEntity, target: SemanticEntity, tolerance: float) -> dict:
            source_data = surface_data(source)
            target_data = surface_data(target)
            padding = max(float(tolerance), 0.5) + 1.0
            source_mask = np.all(
                (source_data["samples"] >= target_data["bounds"][0] - padding)
                & (source_data["samples"] <= target_data["bounds"][1] + padding),
                axis=1,
            )
            target_mask = np.all(
                (target_data["samples"] >= source_data["bounds"][0] - padding)
                & (target_data["samples"] <= source_data["bounds"][1] + padding),
                axis=1,
            )
            source_sample_indices = np.flatnonzero(source_mask)
            target_sample_indices = np.flatnonzero(target_mask)
            if not len(source_sample_indices):
                source_sample_indices = np.arange(len(source_data["samples"]))
            if not len(target_sample_indices):
                target_sample_indices = np.arange(len(target_data["samples"]))
            _, distance_to_target, target_faces_for_source = trimesh.proximity.closest_point_naive(
                target.mesh, source_data["samples"][source_sample_indices]
            )
            _, distance_to_source, source_faces_for_target = trimesh.proximity.closest_point_naive(
                source.mesh, target_data["samples"][target_sample_indices]
            )
            minimum = min(float(np.min(distance_to_target)), float(np.min(distance_to_source)))
            threshold = max(float(tolerance), minimum) + 1e-6
            source_near = source_sample_indices[np.flatnonzero(distance_to_target <= threshold)]
            target_near = target_sample_indices[np.flatnonzero(distance_to_source <= threshold)]
            source_faces = patch_faces(source_data, source_near)
            source_faces.update(int(item) for item in source_faces_for_target[distance_to_source <= threshold])
            target_faces = patch_faces(target_data, target_near)
            target_faces.update(int(item) for item in target_faces_for_source[distance_to_target <= threshold])
            return {
                "method": "generator-surface-sample-exact-triangle-v1",
                "minimumSampledSurfaceDistanceMm": round(minimum, 6),
                "fromFaceIndices": sorted(source_faces),
                "toFaceIndices": sorted(target_faces),
                "fromSampleCount": int(len(source_data["samples"])),
                "toSampleCount": int(len(target_data["samples"])),
                "fromPatch": patch_descriptor(source, source_faces),
                "toPatch": patch_descriptor(target, target_faces),
            }

        records: list[dict] = []
        metric_failures: list[str] = []
        for template in bindings:
            source = self.entity_by_key.get(template["fromEntityKey"])
            target = self.entity_by_key.get(template["toEntityKey"])
            if source is None or target is None:
                raise ValueError(f"interface {template['interfaceId']} references a missing entity")
            source_bounds = np.asarray(source.mesh.bounds, dtype=float)
            target_bounds = np.asarray(target.mesh.bounds, dtype=float)
            separation = np.maximum(np.maximum(source_bounds[0] - target_bounds[1], target_bounds[0] - source_bounds[1]), 0)
            overlap = np.maximum(np.minimum(source_bounds[1], target_bounds[1]) - np.maximum(source_bounds[0], target_bounds[0]), 0)
            positive_overlap = sorted((float(value) for value in overlap if value > 0), reverse=True)
            contact_area = positive_overlap[0] * positive_overlap[1] if len(positive_overlap) >= 2 else 0.0
            record = dict(template)
            record["fromEntityId"] = source.entity_id
            record["toEntityId"] = target.entity_id
            record["dimensionFactIds"] = [
                _stable_id(DIMENSION_NAMESPACE, self.fixture["fixtureId"], stable_key)
                for stable_key in record.pop("dimensionRefs")
            ]
            surface = surface_witness(source, target, float(template["maximumGapMm"] or 0.0))
            surface["surfaceRefResolution"] = {
                "fromSurfaceRef": template["fromSurfaceRef"],
                "toSurfaceRef": template["toSurfaceRef"],
                "selectionBasis": "nearest-mesh-surface-patch",
                "claimBoundary": "demo-geometric-witness-only",
            }
            record["surfaceWitness"] = surface
            record["derivedMetrics"] = {
                "aabbGapMm": round(float(np.linalg.norm(separation)), 6),
                "aabbOverlapMm3": round(float(np.prod(overlap)), 6),
                "candidateContactAreaMm2": round(contact_area, 6),
                "metricStatus": "generation-diagnostic-only",
            }
            measured_gap = surface["minimumSampledSurfaceDistanceMm"]
            if template["contactMode"] == "clearance":
                allowed_error = float(self.fixture["geometryValidation"]["clearanceToleranceMm"])
                if abs(measured_gap - float(template["expectedGapMm"])) > allowed_error:
                    metric_failures.append(
                        f"{template['interfaceId']}: clearance {measured_gap} mm differs from "
                        f"{template['expectedGapMm']} mm"
                    )
            elif measured_gap > float(template["maximumGapMm"]) + 1e-6:
                metric_failures.append(
                    f"interface {template['interfaceId']} surface gap {measured_gap} mm exceeds "
                    f"its {template['maximumGapMm']} mm contract"
                )
            if not surface["fromFaceIndices"] or not surface["toFaceIndices"]:
                metric_failures.append(f"{template['interfaceId']}: mesh-bound surface patch is empty")
            records.append(record)
        if metric_failures:
            preview = "; ".join(metric_failures[:25])
            remainder = len(metric_failures) - min(len(metric_failures), 25)
            if remainder:
                preview += f"; ... and {remainder} more"
            raise ValueError(f"interface surface validation failed: {preview}")
        return records


def _support_path_exists(model: GeometryModel) -> bool:
    support_roles = {
        "ridge-roof-finish",
        "cover-tile-pan-tile",
        "pan-tile-roof-board",
        "roof-board-rafter",
        "rafter-purlin",
        "bearing-block-purlin",
        "arm-bearing-block",
        "seat-arm-x",
        "seat-arm-y",
        "eave-beam-seat",
        "column-eave-beam",
        "interior-post-purlin",
        "tie-beam-interior-post",
        "column-tie-beam",
        "column-base",
        "base-terrace",
        "terrace-course-stack",
        "terrace-foundation",
        "foundation-course-stack",
        "foundation-bearing-ground",
    }
    adjacency: dict[str, set[str]] = {}
    for item in model.interfaces:
        if item["role"] not in support_roles:
            continue
        adjacency.setdefault(item["fromEntityId"], set()).add(item["toEntityId"])
    targets = {
        item.entity_id
        for item in model.entities
        if item.component_type == "groundLayer" and item.key.startswith("ground:bearing:")
    }
    starts = [item.entity_id for item in model.entities if item.component_type in {"panTile", "coverTile", "ridgeTile"}]
    for start in starts:
        pending = [start]
        visited = {start}
        while pending:
            current = pending.pop()
            if current in targets:
                break
            for neighbor in adjacency.get(current, set()) - visited:
                visited.add(neighbor)
                pending.append(neighbor)
        else:
            return False
    return True


def validate_model(model: GeometryModel) -> None:
    fixture = model.fixture
    keys = [item.key for item in model.entities]
    if len(keys) != len(set(keys)):
        raise ValueError("entity keys must be unique")
    present_types = {item.component_type for item in model.entities}
    missing = sorted(set(fixture["requiredComponentTypes"]) - present_types)
    if missing:
        raise ValueError(f"missing component types: {', '.join(missing)}")
    for entity in model.entities:
        if not np.isfinite(entity.mesh.vertices).all():
            raise ValueError(f"{entity.key} contains non-finite geometry")
        if len(entity.mesh.faces) == 0 or abs(float(entity.mesh.volume)) <= 0:
            raise ValueError(f"{entity.key} has no solid geometry")
        if not entity.mesh.is_watertight:
            raise ValueError(f"{entity.key} is not watertight")
        if not entity.mesh.is_winding_consistent:
            raise ValueError(f"{entity.key} has inconsistent face winding")
        if entity.template["resolution"]["geometric"] != "resolved":
            raise ValueError(f"{entity.key} is not geometrically resolved")
        if entity.source_refs != fixture["sourceRefs"] or any(not ref.startswith("demo:") for ref in entity.source_refs):
            raise ValueError(f"{entity.key} is not isolated to the demo fixture")
    dependency_payload = json.loads(_canonical(fixture))
    dependency_payload.get("geometryValidation", {}).pop("forbiddenExternalTokens", None)
    serialized = _canonical(dependency_payload).lower()
    for token in fixture["geometryValidation"]["forbiddenExternalTokens"]:
        if token.lower() in serialized:
            raise ValueError(f"external reference token entered generation input: {token}")
    interface_ids = [item["interfaceId"] for item in model.interfaces]
    if len(interface_ids) != len(set(interface_ids)):
        raise ValueError("interface IDs must be unique")
    valid_ids = {item.entity_id for item in model.entities}
    if any(item["fromEntityId"] not in valid_ids or item["toEntityId"] not in valid_ids for item in model.interfaces):
        raise ValueError("interface references an unknown entity")
    connected_ids = {
        entity_id
        for item in model.interfaces
        for entity_id in (item["fromEntityId"], item["toEntityId"])
    }
    disconnected = sorted(valid_ids - connected_ids)
    if disconnected:
        raise ValueError(f"entities missing from the interface graph: {', '.join(disconnected)}")
    if not _support_path_exists(model):
        raise ValueError("one or more roof-finish entities lack a path to the ground")
    arm_cross = next(item for item in model.interfaces if item["role"] == "arm-cross-half-lap")
    if arm_cross["interfaceKind"] != "halfLap" or arm_cross["interfaceStatus"] != "demoDefined":
        raise ValueError("orthogonal support arms require a demo-defined half-lap")
    observation_keys = {item["targetEntityKey"] for item in fixture["observationCandidates"]}
    if not observation_keys <= set(keys):
        raise ValueError("observation candidate target is missing")


def build_geometry(fixture: dict) -> GeometryModel:
    return GeometryBuilder(fixture).build()


def export_glb(model: GeometryModel, path: str) -> None:
    scene = trimesh.Scene()
    transform = np.asarray(
        [
            [0.001, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.001, 0.0],
            [0.0, -0.001, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    for entity in sorted(model.entities, key=lambda item: item.entity_id):
        mesh = entity.mesh.copy()
        mesh.apply_transform(transform)
        scene.add_geometry(mesh, node_name=entity.entity_id, geom_name=entity.entity_id)
    scene.export(path, file_type="glb")
