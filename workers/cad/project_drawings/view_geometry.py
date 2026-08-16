from __future__ import annotations

import math
import os
import uuid
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh
import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
from shapely.geometry import LineString, box
from shapely.ops import polygonize

from .contracts import canonical_bytes, sha256_value


LINE_NAMESPACE = uuid.UUID("a63b0356-5f49-5f60-a192-9aa374ec3246")


@dataclass(frozen=True)
class SourceMesh:
    entity_id: str
    component_type: str
    vertices: np.ndarray
    faces: np.ndarray
    shape: cq.Shape


def load_source_meshes(glb_path, manifest: dict[str, Any]) -> list[SourceMesh]:
    scene = trimesh.load(glb_path, force="scene", process=False)
    component_by_id = {item["id"]: item["componentType"] for item in manifest["entities"]}
    if set(scene.geometry) != set(component_by_id):
        raise ValueError("GLB entity closure differs from geometry manifest")
    result: list[SourceMesh] = []
    for entity_id in sorted(scene.geometry):
        mesh = scene.geometry[entity_id]
        value = np.asarray(mesh.vertices, dtype=float)
        # glTF Y-up/metre -> project Z-up/millimetre.
        vertices = np.column_stack((value[:, 0], -value[:, 2], value[:, 1])) * 1000.0
        brep_path = glb_path.parent / "brep" / f"{entity_id}.brep"
        if not brep_path.is_file():
            raise ValueError(f"exact BRep is missing for {entity_id}")
        brep_sha = __import__("hashlib").sha256(brep_path.read_bytes()).hexdigest()
        manifest_entity = next(item for item in manifest["entities"] if item["id"] == entity_id)
        if brep_sha != manifest_entity.get("brepSha256"):
            raise ValueError(f"BRep hash differs from geometry manifest for {entity_id}")
        result.append(SourceMesh(entity_id, component_by_id[entity_id], vertices, np.asarray(mesh.faces, dtype=np.int64), cq.Shape.importBrep(str(brep_path))))
    return result


def _ocp_section_segments(shape: cq.Shape, normal: np.ndarray, offset: float, tolerance_mm: float) -> list[np.ndarray]:
    origin = normal * offset
    section = BRepAlgoAPI_Section(
        shape.wrapped,
        gp_Pln(gp_Pnt(*origin.tolist()), gp_Dir(*normal.tolist())),
        True,
    ).Shape()
    segments: list[np.ndarray] = []
    for edge in cq.Shape.cast(section).Edges():
        # Preserve exact linear section edges as one CAD segment. Sampling a
        # straight edge at the curve tolerance creates thousands of collinear
        # fragments without adding geometric information.
        sample_count = 2 if edge.geomType() == "LINE" else max(
            2,
            int(math.ceil(edge.Length() / max(tolerance_mm, 0.05))) + 1,
        )
        points, _ = edge.sample(sample_count)
        for left, right in zip(points, points[1:], strict=False):
            segments.append(np.asarray([left.toTuple(), right.toTuple()], dtype=float))
    return segments


def _project(points: np.ndarray, right: np.ndarray, up: np.ndarray, direction: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return np.column_stack((points @ right, points @ up)), points @ direction


def _candidate_edges(mesh: SourceMesh, direction: np.ndarray) -> list[tuple[np.ndarray, np.ndarray, str]]:
    triangles = mesh.vertices[mesh.faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    normals[lengths > 0] /= lengths[lengths > 0, None]
    edges: dict[tuple[int, int], list[int]] = {}
    for face_index, face in enumerate(mesh.faces):
        for left, right in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            key = tuple(sorted((int(left), int(right))))
            edges.setdefault(key, []).append(face_index)
    output: list[tuple[np.ndarray, np.ndarray, str]] = []
    for (left, right), faces in sorted(edges.items()):
        if len(faces) == 1:
            line_class = "silhouette"
        elif len(faces) == 2:
            facing = [float(np.dot(normals[index], direction)) for index in faces]
            angle_dot = float(np.dot(normals[faces[0]], normals[faces[1]]))
            if facing[0] * facing[1] <= 0 and max(abs(facing[0]), abs(facing[1])) > 1e-5:
                line_class = "silhouette"
            elif angle_dot < math.cos(math.radians(15.0)) and min(facing) <= 1e-5:
                line_class = "feature"
            else:
                continue
        else:
            continue
        output.append((mesh.vertices[left], mesh.vertices[right], line_class))
    return output


def _triangle_depth(point: np.ndarray, triangle_2d: np.ndarray, depths: np.ndarray) -> float | None:
    a, b, c = triangle_2d
    denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(float(denominator)) < 1e-9:
        return None
    w1 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator
    w2 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator
    w3 = 1.0 - w1 - w2
    if min(w1, w2, w3) < -1e-7:
        return None
    return float(w1 * depths[0] + w2 * depths[1] + w3 * depths[2])


class _TrianglePool:
    """把视图内全部投影三角形堆叠为 numpy 数组并缓存包围盒与均匀网格索引，供逐边可见性计算做向量化预筛。"""

    __slots__ = ("triangles", "depths", "bounds_min", "bounds_max", "count", "grid", "grid_origin", "grid_cell", "grid_shape")

    def __init__(self, projected_triangles: list[tuple[np.ndarray, np.ndarray]]) -> None:
        items = list(projected_triangles)
        self.count = len(items)
        if not items:
            self.triangles = np.zeros((0, 3, 2), dtype=float)
            self.depths = np.zeros((0, 3), dtype=float)
            self.bounds_min = np.zeros((0, 2), dtype=float)
            self.bounds_max = np.zeros((0, 2), dtype=float)
            self.grid = None
            return
        self.triangles = np.stack([np.asarray(triangle, dtype=float) for triangle, _ in items])
        self.depths = np.stack([np.asarray(depths, dtype=float) for _, depths in items])
        self.bounds_min = self.triangles.min(axis=1)
        self.bounds_max = self.triangles.max(axis=1)
        self._build_grid()

    def _build_grid(self) -> None:
        # 单元尺寸取三角形包围盒中位跨度的 4 倍，网格规模限制在 64×64 以内
        extents = self.bounds_max - self.bounds_min
        cell = max(float(np.median(extents)) * 4.0, 1.0)
        origin = self.bounds_min.min(axis=0)
        span = self.bounds_max.max(axis=0) - origin
        shape = np.maximum(1, np.minimum(64, np.ceil(span / cell + 1))).astype(int)
        cell_size = np.maximum(span / shape, 1e-6)
        low = np.clip(((self.bounds_min - origin) / cell_size).astype(int), 0, shape - 1)
        high = np.clip(((self.bounds_max - origin) / cell_size).astype(int), 0, shape - 1)
        buckets: dict[tuple[int, int], list[int]] = {}
        for index in range(self.count):
            for ix in range(low[index, 0], high[index, 0] + 1):
                for iy in range(low[index, 1], high[index, 1] + 1):
                    buckets.setdefault((ix, iy), []).append(index)
        self.grid = {key: np.asarray(value, dtype=int) for key, value in buckets.items()}
        self.grid_origin = origin
        self.grid_cell = cell_size
        self.grid_shape = shape

    def candidates(self, segment_min: np.ndarray, segment_max: np.ndarray) -> np.ndarray:
        if self.grid is None:
            return np.zeros(0, dtype=int)
        low = np.clip(((segment_min - self.grid_origin) / self.grid_cell).astype(int), 0, self.grid_shape - 1)
        high = np.clip(((segment_max - self.grid_origin) / self.grid_cell).astype(int), 0, self.grid_shape - 1)
        gathered = [
            self.grid[(ix, iy)]
            for ix in range(low[0], high[0] + 1)
            for iy in range(low[1], high[1] + 1)
            if (ix, iy) in self.grid
        ]
        if not gathered:
            return np.zeros(0, dtype=int)
        return np.unique(np.concatenate(gathered))


def _visibility_intervals(
    segment: np.ndarray,
    segment_depth: np.ndarray,
    projected_triangles: "list[tuple[np.ndarray, np.ndarray]] | _TrianglePool",
    tolerance_mm: float,
) -> list[tuple[float, float]]:
    pool = projected_triangles if isinstance(projected_triangles, _TrianglePool) else _TrianglePool(projected_triangles)
    events = {0.0, 1.0}
    start = np.asarray(segment[0], dtype=float)
    end = np.asarray(segment[1], dtype=float)
    if pool.count:
        segment_min = np.minimum(start, end) - 1e-7
        segment_max = np.maximum(start, end) + 1e-7
        scope = pool.candidates(segment_min, segment_max)
        subset_min = pool.bounds_min[scope]
        subset_max = pool.bounds_max[scope]
        overlap = scope[
            (subset_min[:, 0] <= segment_max[0]) & (subset_max[:, 0] >= segment_min[0])
            & (subset_min[:, 1] <= segment_max[1]) & (subset_max[:, 1] >= segment_min[1])
        ]
    else:
        overlap = np.zeros(0, dtype=int)
    if len(overlap):
        triangles = pool.triangles[overlap]
        edge_start = triangles
        edge_end = np.roll(triangles, -1, axis=1)
        edge_vector = edge_end - edge_start
        direction = end - start
        denominator = direction[0] * edge_vector[..., 1] - direction[1] * edge_vector[..., 0]
        difference = edge_start - start
        valid = np.abs(denominator) > 1e-12
        safe = np.where(valid, denominator, 1.0)
        t_parameter = (difference[..., 0] * edge_vector[..., 1] - difference[..., 1] * edge_vector[..., 0]) / safe
        u_parameter = (difference[..., 0] * direction[1] - difference[..., 1] * direction[0]) / safe
        hit = valid & (t_parameter >= -1e-12) & (t_parameter <= 1 + 1e-12) & (u_parameter >= -1e-12) & (u_parameter <= 1 + 1e-12)
        for value in np.clip(t_parameter[hit], 0.0, 1.0).tolist():
            events.add(value)
    ordered = sorted(events)
    visible: list[tuple[float, float]] = []
    if len(ordered) < 2:
        return visible
    fractions = (np.asarray(ordered[:-1]) + np.asarray(ordered[1:])) / 2
    depths_mid = float(segment_depth[0]) * (1 - fractions) + float(segment_depth[1]) * fractions
    if len(overlap):
        points = start[None, :] * (1 - fractions[:, None]) + end[None, :] * fractions[:, None]
        bounds_min = pool.bounds_min[overlap]
        bounds_max = pool.bounds_max[overlap]
        inside_bbox = (
            (points[:, None, 0] >= bounds_min[None, :, 0] - 1e-7) & (points[:, None, 0] <= bounds_max[None, :, 0] + 1e-7)
            & (points[:, None, 1] >= bounds_min[None, :, 1] - 1e-7) & (points[:, None, 1] <= bounds_max[None, :, 1] + 1e-7)
        )
        triangles = pool.triangles[overlap]
        triangle_depths = pool.depths[overlap]
        ax, ay = triangles[:, 0, 0], triangles[:, 0, 1]
        bx, by = triangles[:, 1, 0], triangles[:, 1, 1]
        cx, cy = triangles[:, 2, 0], triangles[:, 2, 1]
        denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        usable = np.abs(denominator) >= 1e-9
        safe = np.where(usable, denominator, 1.0)
        px = points[:, 0][:, None]
        py = points[:, 1][:, None]
        w1 = ((by - cy)[None, :] * (px - cx[None, :]) + (cx - bx)[None, :] * (py - cy[None, :])) / safe[None, :]
        w2 = ((cy - ay)[None, :] * (px - cx[None, :]) + (ax - cx)[None, :] * (py - cy[None, :])) / safe[None, :]
        w3 = 1.0 - w1 - w2
        inside = inside_bbox & usable[None, :] & (np.minimum(np.minimum(w1, w2), w3) >= -1e-7)
        depth_grid = w1 * triangle_depths[None, :, 0] + w2 * triangle_depths[None, :, 1] + w3 * triangle_depths[None, :, 2]
        depth_grid = np.where(inside, depth_grid, np.inf)
        nearest_all = depth_grid.min(axis=1)
    else:
        nearest_all = np.full(len(fractions), np.inf)
    for index, (left, right) in enumerate(zip(ordered, ordered[1:], strict=False)):
        if nearest_all[index] >= depths_mid[index] - tolerance_mm and right - left > 1e-9:
            if visible and abs(visible[-1][1] - left) < 1e-9:
                visible[-1] = (visible[-1][0], right)
            else:
                visible.append((left, right))
    return visible


# 多进程工作区：每个子进程持有一份三角形池，避免逐任务重复序列化
_WORKER_POOL: dict[str, _TrianglePool] = {}


def _init_visibility_worker(triangles: np.ndarray, depths: np.ndarray) -> None:
    pool = _TrianglePool.__new__(_TrianglePool)
    pool.count = len(triangles)
    pool.triangles = triangles
    pool.depths = depths
    pool.bounds_min = triangles.min(axis=1) if len(triangles) else np.zeros((0, 2), dtype=float)
    pool.bounds_max = triangles.max(axis=1) if len(triangles) else np.zeros((0, 2), dtype=float)
    if pool.count:
        pool._build_grid()
    else:
        pool.grid = None
    _WORKER_POOL["pool"] = pool


def _visibility_chunk(jobs: list[tuple[list[list[float]], list[float]]]) -> list[list[tuple[float, float]]]:
    pool = _WORKER_POOL["pool"]
    return [
        _visibility_intervals(np.asarray(segment, dtype=float), np.asarray(depths, dtype=float), pool, 0.5)
        for segment, depths in jobs
    ]


def _parallel_visibility(edge_jobs: list[tuple[np.ndarray, np.ndarray]], pool: _TrianglePool) -> list[list[tuple[float, float]]]:
    """按边分块并行计算可见区间；小规模任务保持单进程以避免进程启动开销。"""
    workers = max(1, min((os.cpu_count() or 2) - 1, 12))
    if workers < 2 or len(edge_jobs) * max(pool.count, 1) < 50_000_000:
        return [_visibility_intervals(segment, depths, pool, 0.5) for segment, depths in edge_jobs]
    payload = [(segment.tolist(), depths.tolist()) for segment, depths in edge_jobs]
    chunk_size = max(64, len(payload) // (workers * 4))
    chunks = [payload[index:index + chunk_size] for index in range(0, len(payload), chunk_size)]
    results: list[list[tuple[float, float]]] = []
    with ProcessPoolExecutor(max_workers=workers, initializer=_init_visibility_worker, initargs=(pool.triangles, pool.depths)) as executor:
        for chunk_result in executor.map(_visibility_chunk, chunks):
            results.extend(chunk_result)
    return results


def _clip_to_view(segment: np.ndarray, crop_bounds: list[float] | None) -> list[np.ndarray]:
    if crop_bounds is None:
        return [segment]
    intersection = LineString(segment).intersection(box(*crop_bounds))
    geometries = list(intersection.geoms) if hasattr(intersection, "geoms") else [intersection]
    return [np.asarray(geometry.coords, dtype=float) for geometry in geometries if geometry.geom_type == "LineString" and geometry.length >= 0.05]


def _line_record(view: dict[str, Any], manifest: dict[str, Any], entity: SourceMesh, points: np.ndarray, line_class: str, derivation: str, index: int) -> dict[str, Any]:
    normalized = [[round(float(value), 6) for value in point] for point in points]
    line_id = str(uuid.uuid5(LINE_NAMESPACE, f"{manifest['geometryRevisionId']}:{view['id']}:{entity.entity_id}:{derivation}:{index}:{normalized}"))
    return {
        "lineId": line_id,
        "viewId": view["id"],
        "geometryRevisionId": manifest["geometryRevisionId"],
        "sourceEntityId": entity.entity_id,
        "sourceComponentType": entity.component_type,
        "lineClass": line_class,
        "visibility": "visible",
        "derivation": derivation,
        "pointsMm": normalized,
    }


def generate_view_geometry(view: dict[str, Any], manifest: dict[str, Any], meshes: list[SourceMesh]) -> dict[str, Any]:
    direction = np.asarray(view["direction"], dtype=float)
    right = np.asarray(view["right"], dtype=float)
    up = np.asarray(view["up"], dtype=float)
    source_entity_ids = set(view.get("sourceEntityIds", []))
    selected = [
        mesh for mesh in meshes
        if (not source_entity_ids or mesh.entity_id in source_entity_ids)
        and (not view.get("sourceTypes") or mesh.component_type in view["sourceTypes"])
    ]
    crop_bounds = view.get("cropBoundsMm")
    projected_triangles: list[tuple[np.ndarray, np.ndarray]] = []
    for mesh in selected:
        triangles = mesh.vertices[mesh.faces]
        for triangle in triangles:
            projected, depths = _project(triangle, right, up, direction)
            projected_triangles.append((projected, depths))
    triangle_pool = _TrianglePool(projected_triangles)
    lines: list[dict[str, Any]] = []
    material_regions: list[dict[str, Any]] = []
    if view.get("sectionPlane"):
        plane = view["sectionPlane"]
        normal = np.asarray(plane["normal"], dtype=float)
        origin = normal * float(plane["offsetMm"])
        for mesh in selected:
            segments = _ocp_section_segments(mesh.shape, normal, float(plane["offsetMm"]), float(manifest.get("drawingToleranceMm", 0.5)))
            projected_segments: list[np.ndarray] = []
            cut_line_index = 0
            for segment in segments:
                projected, _ = _project(segment, right, up, direction)
                projected_segments.append(projected)
                for clipped in _clip_to_view(projected, crop_bounds):
                    lines.append(_line_record(view, manifest, mesh, clipped, "cut", "planeIntersection", cut_line_index))
                    cut_line_index += 1
            for region_index, polygon in enumerate(polygonize([LineString(segment) for segment in projected_segments])):
                clipped_region = polygon.intersection(box(*crop_bounds)) if crop_bounds is not None else polygon
                region_geometries = list(clipped_region.geoms) if hasattr(clipped_region, "geoms") else [clipped_region]
                for crop_index, region in enumerate(region_geometries):
                    if region.geom_type != "Polygon" or region.area <= 0.01:
                        continue
                    coordinates = [[round(float(x), 6), round(float(y), 6)] for x, y in list(region.exterior.coords)]
                    if len(coordinates) < 4:
                        continue
                    material_regions.append({
                        "regionId": str(uuid.uuid5(LINE_NAMESPACE, f"{manifest['geometryRevisionId']}:{view['id']}:{mesh.entity_id}:region:{region_index}:{crop_index}:{coordinates}")),
                        "viewId": view["id"], "geometryRevisionId": manifest["geometryRevisionId"],
                        "sourceEntityId": mesh.entity_id, "sourceComponentType": mesh.component_type,
                        "materialCode": next(item["materialCode"] for item in manifest["entities"] if item["id"] == mesh.entity_id),
                        "derivation": "planeIntersection", "boundaryMm": coordinates,
                    })
    else:
        edge_meta: list[tuple[SourceMesh, str, np.ndarray]] = []
        edge_jobs: list[tuple[np.ndarray, np.ndarray]] = []
        for mesh in selected:
            for start, end, line_class in _candidate_edges(mesh, direction):
                projected, depths = _project(np.vstack((start, end)), right, up, direction)
                if np.linalg.norm(projected[1] - projected[0]) < 0.05:
                    continue
                edge_meta.append((mesh, line_class, projected))
                edge_jobs.append((projected, depths))
        interval_results = _parallel_visibility(edge_jobs, triangle_pool)
        line_index = 0
        for (mesh, line_class, projected), intervals in zip(edge_meta, interval_results, strict=True):
            for interval_start, interval_end in intervals:
                clipped = np.vstack((
                    projected[0] * (1 - interval_start) + projected[1] * interval_start,
                    projected[0] * (1 - interval_end) + projected[1] * interval_end,
                ))
                if np.linalg.norm(clipped[1] - clipped[0]) < 0.05:
                    continue
                for view_clipped in _clip_to_view(clipped, crop_bounds):
                    lines.append(_line_record(view, manifest, mesh, view_clipped, line_class, "occlusionProjection", line_index))
                    line_index += 1
    if not lines:
        raise ValueError(f"view {view['key']} generated no source-bound lines")
    all_points = np.asarray([point for line in lines for point in line["pointsMm"]], dtype=float)
    bounds = [[round(float(value), 6) for value in all_points.min(axis=0)], [round(float(value), 6) for value in all_points.max(axis=0)]]
    payload = {
        "schemaVersion": "1.0",
        "status": "generated-not-qualified",
        "qualification": "not-drawing-output",
        "l1Eligible": False,
        "viewId": view["id"],
        "viewKey": view["key"],
        "displayLabelZh": view["displayLabelZh"],
        "drawingRef": view["drawingRef"],
        "kind": view["kind"],
        "scaleDenominator": view["scaleDenominator"],
        "geometryRevisionId": manifest["geometryRevisionId"],
        "viewFrame": {"direction": view["direction"], "right": view["right"], "up": view["up"]},
        "sectionPlane": view.get("sectionPlane"),
        "cropBoundsMm": crop_bounds,
        "boundsMm": bounds,
        "lines": sorted(lines, key=lambda item: item["lineId"]),
        "materialRegions": sorted(material_regions, key=lambda item: item["regionId"]),
    }
    payload["viewGeometrySha256"] = sha256_value(payload)
    return payload


def build_drawing_ir(matrix: dict[str, Any], manifest: dict[str, Any], views: list[dict[str, Any]]) -> dict[str, Any]:
    view_by_id = {item["viewId"]: item for item in views}
    annotations: list[dict[str, Any]] = []
    for view in matrix["views"]:
        bounds = view_by_id[view["id"]]["boundsMm"]
        annotations.extend([
            {"requirementId": f"title:{view['id']}", "kind": "viewTitle", "viewId": view["id"], "text": f"{view['displayLabelZh']}  1:{view['scaleDenominator']}", "sourceRefs": [view["id"]]},
            {"requirementId": f"dimension:{view['id']}", "kind": "overallDimension", "viewId": view["id"], "valueMm": round(bounds[1][0] - bounds[0][0], 3), "sourceRefs": [manifest["geometryRevisionId"]]},
        ])
    for observation in matrix.get("observationCandidates", []):
        annotations.append({
            "requirementId": f"condition:{observation['id']}", "kind": "conditionCandidate", "viewId": matrix["views"][0]["id"],
            "text": f"演示观察候选：{observation['displayLabelZh']}（未确认）", "sourceRefs": [observation["targetEntityId"]],
        })
    ir = {
        "schemaVersion": "1.0",
        "status": "generated-not-qualified",
        "qualification": "proxy-unissued",
        "l1Eligible": False,
        "formalEligibility": False,
        "projectId": matrix["projectId"],
        "projectRevisionId": matrix["projectRevisionId"],
        "geometryRevisionId": manifest["geometryRevisionId"],
        "artifactRequirementMatrixId": matrix["id"],
        "titleZh": matrix["titleZh"],
        "buildingDisplayNameZh": matrix["buildingDisplayNameZh"],
        "issueState": matrix["issueState"],
        "issueDate": matrix["issueDate"],
        "revisionLabel": matrix["revisionLabel"],
        "views": views,
        "sheets": matrix["sheets"],
        "viewRequirements": matrix["views"],
        "annotations": annotations,
        "layerPolicy": {
            "cut": "GJ-CUT", "silhouette": "GJ-OUTLINE", "feature": "GJ-PROJECTION",
            "componentBoundary": "GJ-PROJECTION", "dimension": "GJ-DIMENSION", "text": "GJ-TEXT",
            "hatch": "GJ-HATCH", "condition": "GJ-CONDITION", "frame": "GJ-FRAME",
        },
    }
    ir["drawingIrSha256"] = sha256_value(ir)
    return ir
