from __future__ import annotations

from collections import defaultdict
import gzip
from hashlib import sha256
import itertools
import json
import math
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import LineString
from shapely.ops import polygonize_full, unary_union
import trimesh


LINE_NAMESPACE = UUID("f2557e7f-8aec-56df-80de-57873fb48c7e")
REGION_NAMESPACE = UUID("2db3c952-3453-5d69-9efe-e7fda07997d8")


class ViewGeometryError(ValueError):
    pass


def load_source_meshes(path: Path) -> tuple[dict, dict[str, trimesh.Trimesh]]:
    meshes: dict[str, trimesh.Trimesh] = {}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        try:
            header = json.loads(next(stream))
        except StopIteration as error:
            raise ViewGeometryError("source mesh bundle is empty") from error
        if header.get("recordType") != "header" or header.get("schemaVersion") != "t0b-v2-source-meshes-1":
            raise ViewGeometryError("unsupported source mesh schema")
        for line_number, line in enumerate(stream, start=2):
            record = json.loads(line)
            if record.get("recordType") != "mesh":
                raise ViewGeometryError(f"invalid source mesh record at line {line_number}")
            entity_id = record.get("entityId")
            if not isinstance(entity_id, str) or entity_id in meshes:
                raise ViewGeometryError(f"duplicate or invalid source entity at line {line_number}")
            meshes[entity_id] = trimesh.Trimesh(
                vertices=np.asarray(record["vertices"], dtype=float),
                faces=np.asarray(record["faces"], dtype=int),
                process=False,
            )
    return header, meshes


def _canonical_points(points: list[list[float]]) -> list[list[float]]:
    return [[round(float(value), 3) for value in point] for point in points]


def _canonical_pair(start: np.ndarray, end: np.ndarray) -> list[list[float]]:
    points = _canonical_points([start[:2].tolist(), end[:2].tolist()])
    return points if tuple(points[0]) <= tuple(points[1]) else [points[1], points[0]]


def _canonical_segment(start: np.ndarray, end: np.ndarray) -> tuple[list[list[float]], list[list[float]]]:
    first = [round(float(value), 3) for value in start]
    second = [round(float(value), 3) for value in end]
    if tuple(first[:2]) <= tuple(second[:2]):
        return [first[:2], second[:2]], [first, second]
    return [second[:2], first[:2]], [second, first]


def _line_id(view_contract_revision_id: str, view_id: str, source_id: str, derivation: str, line_class: str, points: list[list[float]]) -> str:
    payload = json.dumps(
        [view_contract_revision_id, view_id, source_id, derivation, line_class, points],
        separators=(",", ":"),
    )
    return str(uuid5(LINE_NAMESPACE, payload))


def _region_id(view_contract_revision_id: str, view_id: str, source_id: str, outer: list[list[float]], holes: list[list[list[float]]]) -> str:
    payload = json.dumps([view_contract_revision_id, view_id, source_id, outer, holes], separators=(",", ":"))
    return str(uuid5(REGION_NAMESPACE, payload))


def _selection(view: dict, manifest: dict) -> list[str]:
    frame = view["viewFrame"]
    origin = np.asarray(frame["origin"], dtype=float)
    axes = [np.asarray(frame[name], dtype=float) for name in ("right", "up", "depth")]
    low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], frame["clipDepthMm"][0]], dtype=float)
    high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], frame["clipDepthMm"][1]], dtype=float)
    selected: list[str] = []
    for entity in manifest["entities"]:
        bounds = np.asarray(entity["bounds"], dtype=float)
        corners = np.asarray(list(itertools.product(*[(bounds[0, index], bounds[1, index]) for index in range(3)])))
        view_corners = np.column_stack(tuple((corners - origin) @ axis for axis in axes))
        if np.any(view_corners.max(axis=0) < low) or np.any(view_corners.min(axis=0) > high):
            continue
        selected.append(entity["entityId"])
    return sorted(selected)


def _project(point: np.ndarray, origin: np.ndarray, right: np.ndarray, up: np.ndarray, depth: np.ndarray) -> np.ndarray:
    relative = point - origin
    return np.asarray([relative @ right, relative @ up, relative @ depth], dtype=float)


def _clip_segment(start: np.ndarray, end: np.ndarray, low: np.ndarray, high: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    direction = end - start
    lower_t = 0.0
    upper_t = 1.0
    for index in range(3):
        if abs(direction[index]) <= 1e-12:
            if start[index] < low[index] or start[index] > high[index]:
                return None
            continue
        first = (low[index] - start[index]) / direction[index]
        second = (high[index] - start[index]) / direction[index]
        enter, leave = min(first, second), max(first, second)
        lower_t = max(lower_t, enter)
        upper_t = min(upper_t, leave)
        if lower_t > upper_t:
            return None
    return start + direction * lower_t, start + direction * upper_t


def _clip_polygon_depth(vertices: list[np.ndarray], boundary: float, keep_greater: bool) -> list[np.ndarray]:
    if not vertices:
        return []
    output: list[np.ndarray] = []
    previous = vertices[-1]
    previous_inside = previous[2] >= boundary if keep_greater else previous[2] <= boundary
    for current in vertices:
        current_inside = current[2] >= boundary if keep_greater else current[2] <= boundary
        if current_inside != previous_inside:
            denominator = current[2] - previous[2]
            if abs(denominator) > 1e-12:
                ratio = (boundary - previous[2]) / denominator
                output.append(previous + (current - previous) * ratio)
        if current_inside:
            output.append(current)
        previous = current
        previous_inside = current_inside
    return output


class DepthIndex:
    def __init__(self, triangles: list[np.ndarray], clip_rect: list[float], cell_size: float = 120.0) -> None:
        self.triangles = triangles
        self.clip_rect = clip_rect
        self.cell_size = cell_size
        self.cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, triangle in enumerate(triangles):
            minimum = np.maximum(triangle[:, :2].min(axis=0), np.asarray(clip_rect[:2], dtype=float))
            maximum = np.minimum(triangle[:, :2].max(axis=0), np.asarray(clip_rect[2:], dtype=float))
            if np.any(minimum > maximum):
                continue
            for x_index in range(self._cell_x(minimum[0]), self._cell_x(maximum[0]) + 1):
                for y_index in range(self._cell_y(minimum[1]), self._cell_y(maximum[1]) + 1):
                    self.cells[(x_index, y_index)].append(index)

    def _cell_x(self, value: float) -> int:
        return math.floor((value - self.clip_rect[0]) / self.cell_size)

    def _cell_y(self, value: float) -> int:
        return math.floor((value - self.clip_rect[1]) / self.cell_size)

    @staticmethod
    def _depth_at(triangle: np.ndarray, point: np.ndarray) -> float | None:
        first, second, third = triangle
        vector_a = second[:2] - first[:2]
        vector_b = third[:2] - first[:2]
        offset = point - first[:2]
        denominator = vector_a[0] * vector_b[1] - vector_a[1] * vector_b[0]
        if abs(denominator) <= 1e-9:
            return None
        u = (offset[0] * vector_b[1] - offset[1] * vector_b[0]) / denominator
        v = (vector_a[0] * offset[1] - vector_a[1] * offset[0]) / denominator
        if u < -1e-7 or v < -1e-7 or u + v > 1.0000001:
            return None
        return float(first[2] + u * (second[2] - first[2]) + v * (third[2] - first[2]))

    def nearest_depth(self, point: np.ndarray) -> float | None:
        result: float | None = None
        for triangle_index in self.cells.get((self._cell_x(point[0]), self._cell_y(point[1])), []):
            depth = self._depth_at(self.triangles[triangle_index], point)
            if depth is not None and (result is None or depth < result):
                result = depth
        return result

    def segment_candidates(self, start: np.ndarray, end: np.ndarray) -> list[np.ndarray]:
        minimum = np.maximum(np.minimum(start[:2], end[:2]), np.asarray(self.clip_rect[:2], dtype=float))
        maximum = np.minimum(np.maximum(start[:2], end[:2]), np.asarray(self.clip_rect[2:], dtype=float))
        if np.any(minimum > maximum):
            return []
        indices: set[int] = set()
        for x_index in range(self._cell_x(minimum[0]), self._cell_x(maximum[0]) + 1):
            for y_index in range(self._cell_y(minimum[1]), self._cell_y(maximum[1]) + 1):
                indices.update(self.cells.get((x_index, y_index), []))
        return [self.triangles[index] for index in sorted(indices)]


def _depth_triangles(view: dict, selected: list[str], meshes: dict[str, trimesh.Trimesh]) -> list[np.ndarray]:
    frame = view["viewFrame"]
    origin = np.asarray(frame["origin"], dtype=float)
    right = np.asarray(frame["right"], dtype=float)
    up = np.asarray(frame["up"], dtype=float)
    depth = np.asarray(frame["depth"], dtype=float)
    minimum_depth, maximum_depth = map(float, frame["clipDepthMm"])
    result: list[np.ndarray] = []
    for entity_id in selected:
        mesh = meshes[entity_id]
        view_vertices = np.column_stack(
            (
                (mesh.vertices - origin) @ right,
                (mesh.vertices - origin) @ up,
                (mesh.vertices - origin) @ depth,
            )
        )
        for face in mesh.faces:
            polygon = [view_vertices[index].copy() for index in face]
            polygon = _clip_polygon_depth(polygon, minimum_depth, True)
            polygon = _clip_polygon_depth(polygon, maximum_depth, False)
            if len(polygon) < 3:
                continue
            for index in range(1, len(polygon) - 1):
                result.append(np.asarray([polygon[0], polygon[index], polygon[index + 1]], dtype=float))
    return result


def _candidate_edges(mesh: trimesh.Trimesh, depth: np.ndarray, feature_angle_deg: float) -> list[tuple[np.ndarray, np.ndarray, str]]:
    result: list[tuple[np.ndarray, np.ndarray, str]] = []
    normals = np.asarray(mesh.face_normals, dtype=float)
    threshold = math.radians(feature_angle_deg)
    for adjacency_index, edge in enumerate(mesh.face_adjacency_edges):
        first_face, second_face = mesh.face_adjacency[adjacency_index]
        first_dot = float(normals[first_face] @ depth)
        second_dot = float(normals[second_face] @ depth)
        silhouette = first_dot * second_dot <= 1e-10 and abs(first_dot - second_dot) > 1e-8
        feature = float(mesh.face_adjacency_angles[adjacency_index]) >= threshold
        if not silhouette and not feature:
            continue
        line_class = "silhouette" if silhouette else "feature"
        result.append((mesh.vertices[edge[0]], mesh.vertices[edge[1]], line_class))
    return result


def _occluded_interval(start: np.ndarray, end: np.ndarray, triangle: np.ndarray, tolerance: float) -> tuple[float, float] | None:
    first, second, third = triangle
    vector_a = second[:2] - first[:2]
    vector_b = third[:2] - first[:2]
    denominator = vector_a[0] * vector_b[1] - vector_a[1] * vector_b[0]
    if abs(denominator) <= 1e-9:
        return None

    def barycentric(point: np.ndarray) -> np.ndarray:
        offset = point[:2] - first[:2]
        u = (offset[0] * vector_b[1] - offset[1] * vector_b[0]) / denominator
        v = (vector_a[0] * offset[1] - vector_a[1] * offset[0]) / denominator
        return np.asarray([u, v, 1.0 - u - v], dtype=float)

    start_weights = barycentric(start)
    end_weights = barycentric(end)
    lower = 0.0
    upper = 1.0
    for initial, final in zip(start_weights, end_weights):
        slope = final - initial
        if abs(slope) <= 1e-12:
            if initial < -1e-9:
                return None
            continue
        crossing = (-1e-9 - initial) / slope
        if slope > 0:
            lower = max(lower, crossing)
        else:
            upper = min(upper, crossing)
        if lower >= upper:
            return None

    direction = end - start

    def depth_difference(parameter: float) -> float:
        point = start + direction * parameter
        triangle_depth = DepthIndex._depth_at(triangle, point[:2])
        if triangle_depth is None:
            return -math.inf
        return float(point[2] - triangle_depth - tolerance)

    lower_difference = depth_difference(lower)
    upper_difference = depth_difference(upper)
    if lower_difference <= 0 and upper_difference <= 0:
        return None
    if lower_difference > 0 and upper_difference > 0:
        return lower, upper
    crossing = lower + (upper - lower) * (-lower_difference) / (upper_difference - lower_difference)
    return (lower, crossing) if lower_difference > 0 else (crossing, upper)


def _occluded_intervals(start: np.ndarray, end: np.ndarray, triangles: list[np.ndarray], tolerance: float) -> list[tuple[float, float]]:
    if not triangles:
        return []
    array = np.asarray(triangles, dtype=float)
    first = array[:, 0]
    vector_a = array[:, 1, :2] - first[:, :2]
    vector_b = array[:, 2, :2] - first[:, :2]
    denominator = vector_a[:, 0] * vector_b[:, 1] - vector_a[:, 1] * vector_b[:, 0]
    valid = np.abs(denominator) > 1e-9
    safe_denominator = np.where(valid, denominator, 1.0)

    def barycentric(points: np.ndarray) -> np.ndarray:
        offset = points[:, :2] - first[:, :2]
        u = (offset[:, 0] * vector_b[:, 1] - offset[:, 1] * vector_b[:, 0]) / safe_denominator
        v = (vector_a[:, 0] * offset[:, 1] - vector_a[:, 1] * offset[:, 0]) / safe_denominator
        return np.column_stack((u, v, 1.0 - u - v))

    start_points = np.broadcast_to(start, first.shape)
    end_points = np.broadcast_to(end, first.shape)
    start_weights = barycentric(start_points)
    end_weights = barycentric(end_points)
    lower = np.zeros(len(array), dtype=float)
    upper = np.ones(len(array), dtype=float)
    for index in range(3):
        initial = start_weights[:, index]
        slope = end_weights[:, index] - initial
        flat = np.abs(slope) <= 1e-12
        valid &= ~(flat & (initial < -1e-9))
        crossing = np.divide(-1e-9 - initial, slope, out=np.zeros_like(slope), where=~flat)
        lower = np.where((~flat) & (slope > 0), np.maximum(lower, crossing), lower)
        upper = np.where((~flat) & (slope < 0), np.minimum(upper, crossing), upper)
    valid &= lower < upper

    direction = end - start

    def depth_difference(parameters: np.ndarray) -> np.ndarray:
        weights = start_weights + (end_weights - start_weights) * parameters[:, None]
        triangle_depth = (
            first[:, 2]
            + weights[:, 0] * (array[:, 1, 2] - first[:, 2])
            + weights[:, 1] * (array[:, 2, 2] - first[:, 2])
        )
        line_depth = start[2] + direction[2] * parameters
        return line_depth - triangle_depth - tolerance

    lower_difference = depth_difference(lower)
    upper_difference = depth_difference(upper)
    hidden = valid & ((lower_difference > 0) | (upper_difference > 0))
    mixed = hidden & ((lower_difference > 0) != (upper_difference > 0))
    crossing = lower + np.divide(
        (upper - lower) * (-lower_difference),
        upper_difference - lower_difference,
        out=np.zeros_like(lower),
        where=np.abs(upper_difference - lower_difference) > 1e-12,
    )
    result_lower = np.where(mixed & (lower_difference <= 0), crossing, lower)
    result_upper = np.where(mixed & (lower_difference > 0), crossing, upper)
    return [
        (float(result_lower[index]), float(result_upper[index]))
        for index in np.flatnonzero(hidden & (result_lower < result_upper))
    ]


def _visible_intervals(
    start: np.ndarray,
    end: np.ndarray,
    depth_index: DepthIndex,
    tolerance: float,
    split_tolerance: float,
) -> list[tuple[np.ndarray, np.ndarray]]:
    length = float(np.linalg.norm(end[:2] - start[:2]))
    if length < split_tolerance:
        return []
    occluded = _occluded_intervals(start, end, depth_index.segment_candidates(start, end), tolerance)
    merged: list[list[float]] = []
    for lower, upper in sorted(occluded):
        lower = max(0.0, lower)
        upper = min(1.0, upper)
        if lower >= upper:
            continue
        if merged and lower <= merged[-1][1] + 1e-9:
            merged[-1][1] = max(merged[-1][1], upper)
        else:
            merged.append([lower, upper])
    visible: list[tuple[float, float]] = []
    cursor = 0.0
    for lower, upper in merged:
        if lower > cursor:
            visible.append((cursor, lower))
        cursor = max(cursor, upper)
    if cursor < 1.0:
        visible.append((cursor, 1.0))
    direction = end - start
    return [
        (start + direction * lower, start + direction * upper)
        for lower, upper in visible
        if (upper - lower) * length >= split_tolerance
    ]


def _projection_line_class(
    start: np.ndarray,
    end: np.ndarray,
    source_class: str,
    depth_index: DepthIndex,
    tolerance: float,
    outline_probe: float,
    continuation_tolerance: float,
) -> str:
    if source_class == "feature":
        return "feature"
    direction = end[:2] - start[:2]
    length = float(np.linalg.norm(direction))
    if length <= 1e-9:
        return "componentBoundary"
    perpendicular = np.asarray([-direction[1], direction[0]], dtype=float) / length
    midpoint = (start + end) / 2
    continuation_tolerance = max(continuation_tolerance, tolerance * 4)
    continuations = 0
    for sign in (-1.0, 1.0):
        nearest = depth_index.nearest_depth(midpoint[:2] + perpendicular * outline_probe * sign)
        if nearest is not None and abs(nearest - midpoint[2]) <= continuation_tolerance:
            continuations += 1
    return "silhouette" if continuations == 1 else "componentBoundary"


class SectionViewGenerator:
    def __init__(self, generation_contract: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> None:
        allowed = {"geometryRevisionId", "viewContractRevisionId", "views", "drawingSheets", "drawingRequirements"}
        if set(generation_contract) != allowed:
            raise ViewGeometryError("section generator accepts only the sanitized view-generation contract")
        self.contract = generation_contract
        self.manifest = manifest
        self.meshes = meshes
        self.metadata = {item["entityId"]: item for item in manifest["entities"]}

    def generate(self, view_id: str) -> dict:
        view = next((item for item in self.contract["views"] if item["id"] == view_id), None)
        if view is None or view.get("derivation") != "planeIntersection":
            raise ViewGeometryError(f"{view_id} is not a frozen primary section view")
        selected = _selection(view, self.manifest)
        frame = view["viewFrame"]
        section = view["section"]
        origin = np.asarray(section["planeOrigin"], dtype=float)
        normal = np.asarray(section["planeNormal"], dtype=float)
        right = np.asarray(frame["right"], dtype=float)
        up = np.asarray(frame["up"], dtype=float)
        depth = np.asarray(frame["depth"], dtype=float)
        clip_low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], frame["clipDepthMm"][0]], dtype=float)
        clip_high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], frame["clipDepthMm"][1]], dtype=float)
        cut_clip_low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], -np.inf], dtype=float)
        cut_clip_high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], np.inf], dtype=float)
        cut_lines: list[dict] = []
        cut_regions: list[dict] = []
        cut_sources: set[str] = set()
        open_or_dangle = 0

        for entity_id in selected:
            mesh = self.meshes[entity_id]
            segments = trimesh.intersections.mesh_plane(mesh, normal, origin)
            lines: list[LineString] = []
            for segment in segments:
                start = _project(segment[0], origin, right, up, depth)
                end = _project(segment[1], origin, right, up, depth)
                clipped = _clip_segment(start, end, cut_clip_low, cut_clip_high)
                if clipped is None:
                    continue
                points = _canonical_pair(*clipped)
                if points[0] != points[1]:
                    lines.append(LineString(points))
            if not lines:
                continue
            merged = unary_union(lines)
            polygons, cuts, dangles, invalid = polygonize_full(merged)
            open_or_dangle += len(cuts.geoms) + len(dangles.geoms) + len(invalid.geoms)
            entity = self.metadata[entity_id]
            for polygon in polygons.geoms:
                outer = _canonical_points([list(point) for point in polygon.exterior.coords])
                holes = [_canonical_points([list(point) for point in ring.coords]) for ring in polygon.interiors]
                region_id = _region_id(self.contract["viewContractRevisionId"], view_id, entity_id, outer, holes)
                boundary_ids: list[str] = []
                for boundary_index, points in enumerate([outer, *holes]):
                    line_id = _line_id(self.contract["viewContractRevisionId"], view_id, entity_id, "planeIntersection.cut", "cut", points)
                    boundary_ids.append(line_id)
                    cut_lines.append(
                        {
                            "lineId": line_id,
                            "viewId": view_id,
                            "geometryRevisionId": self.contract["geometryRevisionId"],
                            "viewContractRevisionId": self.contract["viewContractRevisionId"],
                            "sourceEntityId": entity_id,
                            "sourceComponentType": entity["componentType"],
                            "derivation": "planeIntersection.cut",
                            "derivationTransform": frame["modelToView"],
                            "lineClass": "cut",
                            "visibility": "visible",
                            "closed": True,
                            "boundaryRole": "outer" if boundary_index == 0 else "hole",
                            "pointsMm": points,
                        }
                    )
                cut_sources.add(entity_id)
                material_hatch = {"stone-demo": "stone", "timber-demo": "timber", "earth-demo": "earth"}.get(entity["materialCode"])
                cut_regions.append(
                    {
                        "regionId": region_id,
                        "viewId": view_id,
                        "geometryRevisionId": self.contract["geometryRevisionId"],
                        "viewContractRevisionId": self.contract["viewContractRevisionId"],
                        "sourceEntityId": entity_id,
                        "sourceComponentType": entity["componentType"],
                        "materialId": entity["materialId"],
                        "materialCode": entity["materialCode"],
                        "materialHatch": material_hatch,
                        "outerBoundaryLineId": boundary_ids[0],
                        "holeBoundaryLineIds": boundary_ids[1:],
                    }
                )

        if open_or_dangle:
            raise ViewGeometryError(f"{view_id} contains {open_or_dangle} open or dangling cut paths")

        triangles = _depth_triangles(view, selected, self.meshes)
        depth_index = DepthIndex(triangles, frame["clipRectMm"])
        requirements = self.contract["drawingRequirements"]["projectionPolicy"]
        projection_lines: list[dict] = []
        seen: set[tuple] = set()
        depth_projection_types = set(section["depthProjectionTypes"])
        for entity_id in selected:
            entity = self.metadata[entity_id]
            if entity["componentType"] not in depth_projection_types:
                continue
            for model_start, model_end, line_class in _candidate_edges(self.meshes[entity_id], depth, float(requirements["featureAngleDeg"])):
                start = _project(model_start, np.asarray(frame["origin"], dtype=float), right, up, depth)
                end = _project(model_end, np.asarray(frame["origin"], dtype=float), right, up, depth)
                clipped = _clip_segment(start, end, clip_low, clip_high)
                if clipped is None or max(clipped[0][2], clipped[1][2]) <= float(section["cutToleranceMm"]):
                    continue
                for visible_start, visible_end in _visible_intervals(
                    *clipped,
                    depth_index,
                    float(requirements["visibilityProbeToleranceMm"]),
                    float(requirements["occlusionSplitToleranceMm"]),
                ):
                    points, source_points_view = _canonical_segment(visible_start, visible_end)
                    key = (entity_id, line_class, tuple(map(tuple, points)))
                    if key in seen or points[0] == points[1]:
                        continue
                    seen.add(key)
                    line_id = _line_id(self.contract["viewContractRevisionId"], view_id, entity_id, "planeIntersection.depthProjection", line_class, points)
                    projection_lines.append(
                        {
                            "lineId": line_id,
                            "viewId": view_id,
                            "geometryRevisionId": self.contract["geometryRevisionId"],
                            "viewContractRevisionId": self.contract["viewContractRevisionId"],
                            "sourceEntityId": entity_id,
                            "sourceComponentType": entity["componentType"],
                            "derivation": "planeIntersection.depthProjection",
                            "derivationTransform": frame["modelToView"],
                            "lineClass": line_class,
                            "visibility": "visible",
                            "closed": False,
                            "pointsMm": points,
                            "sourcePointsViewMm": source_points_view,
                        }
                    )

        cut_lines.sort(key=lambda item: item["lineId"])
        cut_regions.sort(key=lambda item: item["regionId"])
        projection_lines.sort(key=lambda item: item["lineId"])
        cut_entity_set_hash = sha256("\n".join(sorted(cut_sources)).encode("utf-8")).hexdigest()
        cut_regions_by_type: dict[str, int] = defaultdict(int)
        for region in cut_regions:
            cut_regions_by_type[region["sourceComponentType"]] += 1
        payload = {
            "schemaVersion": "t0b-v2-view-geometry-1",
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "viewId": view_id,
            "geometryRevisionId": self.contract["geometryRevisionId"],
            "viewContractRevisionId": self.contract["viewContractRevisionId"],
            "unit": "mm",
            "viewFrame": frame,
            "section": section,
            "cutLines": cut_lines,
            "cutRegions": cut_regions,
            "projectionLines": projection_lines,
            "statistics": {
                "selectedSourceCount": len(selected),
                "cutSourceCount": len(cut_sources),
                "cutEntitySetSha256": cut_entity_set_hash,
                "cutSourceTypes": sorted({self.metadata[entity_id]["componentType"] for entity_id in cut_sources}),
                "cutRegionCount": len(cut_regions),
                "cutRegionCountByType": dict(sorted(cut_regions_by_type.items())),
                "cutLineCount": len(cut_lines),
                "projectionTriangleCountDiagnostic": len(triangles),
                "visibleProjectionLineCount": len(projection_lines),
                "depthProjectionSourceTypes": sorted({line["sourceComponentType"] for line in projection_lines}),
                "openOrDangleCount": open_or_dangle,
            },
        }
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload["viewGeometrySha256"] = sha256(canonical.encode("utf-8")).hexdigest()
        return payload


class ProjectionViewGenerator:
    def __init__(self, generation_contract: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> None:
        allowed = {"geometryRevisionId", "viewContractRevisionId", "views", "drawingSheets", "drawingRequirements"}
        if set(generation_contract) != allowed:
            raise ViewGeometryError("projection generator accepts only the sanitized view-generation contract")
        self.contract = generation_contract
        self.manifest = manifest
        self.meshes = meshes
        self.metadata = {item["entityId"]: item for item in manifest["entities"]}

    def generate(self, view_id: str) -> dict:
        view = next((item for item in self.contract["views"] if item["id"] == view_id), None)
        if view is None or view.get("derivation") != "visibleLineProjection":
            raise ViewGeometryError(f"{view_id} is not a frozen visible-line projection view")

        selected = _selection(view, self.manifest)
        frame = view["viewFrame"]
        origin = np.asarray(frame["origin"], dtype=float)
        right = np.asarray(frame["right"], dtype=float)
        up = np.asarray(frame["up"], dtype=float)
        depth = np.asarray(frame["depth"], dtype=float)
        clip_low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], frame["clipDepthMm"][0]], dtype=float)
        clip_high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], frame["clipDepthMm"][1]], dtype=float)
        triangles = _depth_triangles(view, selected, self.meshes)
        depth_index = DepthIndex(triangles, frame["clipRectMm"])
        requirements = self.contract["drawingRequirements"]["projectionPolicy"]
        display_types = set(view["projection"]["displayTypes"])

        candidates: list[dict] = []
        for entity_id in selected:
            entity = self.metadata[entity_id]
            if entity["componentType"] not in display_types:
                continue
            for model_start, model_end, line_class in _candidate_edges(
                self.meshes[entity_id],
                depth,
                float(requirements["featureAngleDeg"]),
            ):
                start = _project(model_start, origin, right, up, depth)
                end = _project(model_end, origin, right, up, depth)
                clipped = _clip_segment(start, end, clip_low, clip_high)
                if clipped is None:
                    continue
                for visible_start, visible_end in _visible_intervals(
                    *clipped,
                    depth_index,
                    float(requirements["visibilityProbeToleranceMm"]),
                    float(requirements["occlusionSplitToleranceMm"]),
                ):
                    points, source_points_view = _canonical_segment(visible_start, visible_end)
                    if points[0] == points[1]:
                        continue
                    output_class = _projection_line_class(
                        visible_start,
                        visible_end,
                        line_class,
                        depth_index,
                        float(requirements["visibilityProbeToleranceMm"]),
                        float(requirements["outlineProbeMm"]),
                        float(requirements["continuationDepthToleranceMm"]),
                    )
                    candidates.append(
                        {
                            "sourceEntityId": entity_id,
                            "sourceComponentType": entity["componentType"],
                            "lineClass": output_class,
                            "pointsMm": points,
                            "sourcePointsViewMm": source_points_view,
                            "meanDepthMm": round(float((visible_start[2] + visible_end[2]) / 2), 3),
                        }
                    )

        # Coincident component edges are one visible structural line. Prefer the
        # closest source, then silhouettes, while retaining a deterministic source.
        deduplicated: dict[tuple, dict] = {}
        for candidate in candidates:
            key = tuple(map(tuple, candidate["pointsMm"]))
            current = deduplicated.get(key)
            rank = (
                candidate["meanDepthMm"],
                {"silhouette": 0, "componentBoundary": 1, "feature": 2}[candidate["lineClass"]],
                candidate["sourceEntityId"],
            )
            if current is None:
                deduplicated[key] = candidate
                continue
            current_rank = (
                current["meanDepthMm"],
                {"silhouette": 0, "componentBoundary": 1, "feature": 2}[current["lineClass"]],
                current["sourceEntityId"],
            )
            if rank < current_rank:
                deduplicated[key] = candidate

        projection_lines: list[dict] = []
        for candidate in deduplicated.values():
            line_id = _line_id(
                self.contract["viewContractRevisionId"],
                view_id,
                candidate["sourceEntityId"],
                "visibleLineProjection",
                candidate["lineClass"],
                candidate["pointsMm"],
            )
            projection_lines.append(
                {
                    "lineId": line_id,
                    "viewId": view_id,
                    "geometryRevisionId": self.contract["geometryRevisionId"],
                    "viewContractRevisionId": self.contract["viewContractRevisionId"],
                    "sourceEntityId": candidate["sourceEntityId"],
                    "sourceComponentType": candidate["sourceComponentType"],
                    "derivation": "visibleLineProjection",
                    "derivationTransform": frame["modelToView"],
                    "lineClass": candidate["lineClass"],
                    "visibility": "visible",
                    "closed": False,
                    "pointsMm": candidate["pointsMm"],
                    "sourcePointsViewMm": candidate["sourcePointsViewMm"],
                }
            )
        projection_lines.sort(key=lambda item: item["lineId"])

        projected_sources = sorted({line["sourceEntityId"] for line in projection_lines})
        payload = {
            "schemaVersion": "t0b-v2-view-geometry-1",
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "viewId": view_id,
            "geometryRevisionId": self.contract["geometryRevisionId"],
            "viewContractRevisionId": self.contract["viewContractRevisionId"],
            "unit": "mm",
            "viewFrame": frame,
            "projectionLines": projection_lines,
            "statistics": {
                "selectedSourceCount": len(selected),
                "selectionEntitySetSha256": sha256("\n".join(selected).encode("utf-8")).hexdigest(),
                "projectedSourceCount": len(projected_sources),
                "projectedEntitySetSha256": sha256("\n".join(projected_sources).encode("utf-8")).hexdigest(),
                "projectionTriangleCountDiagnostic": len(triangles),
                "visibleProjectionLineCount": len(projection_lines),
                "projectionSourceTypes": sorted({line["sourceComponentType"] for line in projection_lines}),
            },
        }
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload["viewGeometrySha256"] = sha256(canonical.encode("utf-8")).hexdigest()
        return payload
