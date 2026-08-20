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
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
from shapely.geometry import LineString, MultiPoint, Point, box
from shapely.ops import polygonize, unary_union

from .contracts import canonical_bytes, sha256_value


LINE_NAMESPACE = uuid.UUID("a63b0356-5f49-5f60-a192-9aa374ec3246")

# 消隐分块的目标元素数。每块会同时存在若干同形状的中间矩阵，
# 四百万元素对应单块约 32 MB，乘中间量后峰值仍在数百 MB 内。
_VISIBILITY_BLOCK_ELEMENTS = 4_000_000


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


# 构件是否在剖切面之外（沿观察方向更远的一侧）。整块都在观察者与剖切面
# 之间的构件被剖切规则移除，不参与投影；跨过剖切面的构件保留，它露在
# 剖切面之外的部分正是要画的可见投影。
def _is_beyond_plane(mesh: SourceMesh, normal: np.ndarray, origin: np.ndarray, direction: np.ndarray) -> bool:
    offsets = (mesh.vertices - origin) @ normal
    # 观察方向与法向同号时，剖切面之外是法向的正侧，反之为负侧
    toward = float(np.dot(direction, normal))
    if toward >= 0:
        return bool(offsets.max() > 1e-6)
    return bool(offsets.min() < -1e-6)


# 质量基准 4.3 图面细节层级。规则由矩阵下发（domain 的 drawing-detail-policy），
# 这里只按规则执行，不含任何构件名清单，也不判断比例。
def _detail_treatment(view: dict[str, Any], component_type: str) -> tuple[str, dict[str, Any] | None]:
    for rule in view.get("detailRules", []):
        if component_type in rule["componentTypes"]:
            return rule["treatment"], rule
    return "full", None


# 构件表面在某个投影点的深度。外轮廓线要按自己的位置取深度，
# 否则遮挡判定会把长构件的远端整段判掉。
def _surface_depth(point: np.ndarray, triangles: list[tuple[np.ndarray, np.ndarray]], fallback: float) -> float:
    nearest = None
    for triangle_2d, depths in triangles:
        value = _triangle_depth(point, triangle_2d, depths)
        if value is not None and (nearest is None or value < nearest):
            nearest = value
    return fallback if nearest is None else float(nearest)


# 重复构件的分组：瓦垄、斗栱攒、椽都是沿某一轴重复排布的。
# 取质心取值更分散的那一轴作为重复轴，按相邻间隔的中位数一半切分，
# 每一段就是一垄或一攒。不解析构件键，两个项目的命名规则不同，
# 按几何分组才对两边都成立。
def _repetition_clusters(hulls: list[tuple[SourceMesh, Any]]) -> list[list[int]]:
    if len(hulls) < 2:
        return [[index] for index in range(len(hulls))]
    centroids = np.array([[hull.centroid.x, hull.centroid.y] for _mesh, hull in hulls], dtype=float)
    spread = [len(set(np.round(centroids[:, axis], 1))) for axis in (0, 1)]
    axis = 0 if spread[0] >= spread[1] else 1
    order = list(np.argsort(centroids[:, axis]))
    values = centroids[order, axis]
    gaps = np.diff(values)
    positive = gaps[gaps > 1e-6]
    threshold = float(np.median(positive)) * 0.5 if positive.size else 0.0
    clusters: list[list[int]] = [[int(order[0])]]
    for position in range(1, len(order)):
        if values[position] - values[position - 1] > threshold:
            clusters.append([])
        clusters[-1].append(int(order[position]))
    return clusters


# 同族构件在视图坐标下各取投影凸包，并集后只画外边界。
# 相邻瓦件并成一垄，垄间分界保留，单块瓦的轮廓消失；一攒斗栱并成外轮廓。
# 每条边界线按中点落在哪个构件的凸包内归属源构件，sourceEntityId 不丢。
#
# 凸包对瓦件、斗栱这类近凸构件够用。它是简化表示，视图产物里标明处置方式，
# 不冒充真实断面（质量基准 3.5）。
def _group_outline_lines(
    view: dict[str, Any],
    manifest: dict[str, Any],
    meshes: list[SourceMesh],
    right: np.ndarray,
    up: np.ndarray,
    direction: np.ndarray,
    triangle_pool: "_TrianglePool",
    crop_bounds: tuple[float, float, float, float] | None,
    minimum_spacing_mm: float,
    scale_denominator: float,
    dropped: list[str],
    all_triangles: dict[str, list[tuple[np.ndarray, np.ndarray]]] | None = None,
) -> list[dict[str, Any]]:
    hulls: list[tuple[SourceMesh, Any]] = []
    # 每个构件自己的投影三角形，用来给外轮廓线按位置插值真实深度。
    # 取构件最近点当整条线的深度会让长瓦垄的远端被误判成遮挡，图上成虚线。
    own_triangles: dict[str, list[tuple[np.ndarray, np.ndarray]]] = {}
    for mesh in meshes:
        projected = np.column_stack((mesh.vertices @ right, mesh.vertices @ up))
        hull = MultiPoint([tuple(point) for point in projected]).convex_hull
        if hull.geom_type != "Polygon" or hull.area <= 1e-9:
            continue
        hulls.append((mesh, hull))
        own_triangles[mesh.entity_id] = [
            (np.column_stack((triangle @ right, triangle @ up)), triangle @ direction)
            for triangle in mesh.vertices[mesh.faces]
        ]
    if not hulls:
        return []

    # 先按重复轴把同族构件分成一垄一组，再在组内取并集。
    # 直接对全族取并集会把相邻两垄也并成一片，垄分界随之消失，
    # 而 4.3 在 1:50 要的正是"单垄只画分界"。
    groups = []
    for cluster in _repetition_clusters(hulls):
        merged = unary_union([hulls[index][1] for index in cluster])
        parts = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
        groups.extend(part for part in parts if part.geom_type == "Polygon")

    # 可辨间距守卫：并组之后若相邻组的排布间距在成图上仍小于阈值，
    # 按间隔整组丢弃。丢弃数量写进视图产物，不做静默截断。
    #
    # 量的是重复图元的排布间距（质心间距），不是两组边界的间隙。
    # 相邻瓦垄本来就贴合，边界间隙恒为零，按间隙判会把整片瓦垄丢光。
    threshold_mm = minimum_spacing_mm * scale_denominator
    groups.sort(key=lambda polygon: (polygon.centroid.x, polygon.centroid.y))
    kept: list[Any] = []
    for group in groups:
        if kept and kept[-1].centroid.distance(group.centroid) < threshold_mm:
            dropped.append(f"{len(dropped)}")
            continue
        kept.append(group)

    segments: list[tuple[SourceMesh, np.ndarray, np.ndarray]] = []
    for group in kept:
        coordinates = list(group.exterior.coords)
        for first, second in zip(coordinates, coordinates[1:]):
            middle = ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
            owner = next(
                (mesh for mesh, hull in hulls if hull.buffer(1e-6).contains(Point(middle))),
                None,
            )
            if owner is None:
                continue
            projected = np.asarray([first, second], dtype=float)
            fallback = float(np.min(owner.vertices @ direction))
            depths = np.asarray([
                _surface_depth(np.asarray(point, dtype=float), own_triangles[owner.entity_id], fallback)
                for point in (first, second)
            ], dtype=float)
            segments.append((owner, projected, depths))

    # 垄分界线正落在相邻两垄的交界上，两侧深度几乎相同，若拿同族瓦件当遮挡物
    # 判定会在容差内反复翻转，图上成虚线。同族构件不参与本族外轮廓的遮挡判定。
    own_ids = {mesh.entity_id for mesh in meshes}
    outside_pool = _TrianglePool([
        item for entity_id, items in all_triangles.items() if entity_id not in own_ids for item in items
    ]) if all_triangles else triangle_pool
    interval_results = _parallel_visibility([(item[1], item[2]) for item in segments], outside_pool)
    lines: list[dict[str, Any]] = []
    index = 0
    for (owner, projected, _depths), intervals in zip(segments, interval_results, strict=True):
        for interval_start, interval_end in intervals:
            clipped = np.vstack((
                projected[0] * (1 - interval_start) + projected[1] * interval_start,
                projected[0] * (1 - interval_end) + projected[1] * interval_end,
            ))
            if np.linalg.norm(clipped[1] - clipped[0]) < 0.05:
                continue
            for view_clipped in _clip_to_view(clipped, crop_bounds):
                lines.append(_line_record(view, manifest, owner, view_clipped, "componentBoundary", "detailGroupOutline", index))
                index += 1
    return lines


def _projected_lines(
    view: dict[str, Any],
    manifest: dict[str, Any],
    meshes: list[SourceMesh],
    right: np.ndarray,
    up: np.ndarray,
    direction: np.ndarray,
    triangle_pool: "_TrianglePool",
    crop_bounds: tuple[float, float, float, float] | None,
    dropped: list[str] | None = None,
) -> list[dict[str, Any]]:
    # 先按图面细节层级分流（质量基准 4.3）：
    # omit 不出线，groupOutline 走并集外边界，noJointLines 去掉分缝线，
    # full 走逐构件出线。规则来自矩阵，这里不认识任何构件名。
    dropped_groups: list[str] = dropped if dropped is not None else []
    scale = float(view.get("scaleDenominator", 1))
    outline_families: dict[str, tuple[list[SourceMesh], float]] = {}
    direct: list[SourceMesh] = []
    joint_lines_off: set[str] = set()
    for mesh in meshes:
        treatment, rule = _detail_treatment(view, mesh.component_type)
        if treatment == "omit":
            continue
        if treatment == "groupOutline":
            key = rule["familyZh"] if rule else mesh.component_type
            bucket = outline_families.setdefault(key, ([], float(rule["minimumOnPaperSpacingMm"]) if rule else 0.5))
            bucket[0].append(mesh)
            continue
        if treatment == "noJointLines":
            joint_lines_off.add(mesh.entity_id)
        direct.append(mesh)

    lines: list[dict[str, Any]] = []
    if outline_families:
        all_triangles = {
            mesh.entity_id: [
                (np.column_stack((triangle @ right, triangle @ up)), triangle @ direction)
                for triangle in mesh.vertices[mesh.faces]
            ]
            for mesh in meshes
        }
        for family_meshes, spacing in outline_families.values():
            lines.extend(_group_outline_lines(
                view, manifest, family_meshes, right, up, direction,
                triangle_pool, crop_bounds, spacing, scale, dropped_groups, all_triangles,
            ))

    edge_meta: list[tuple[SourceMesh, str, np.ndarray]] = []
    edge_jobs: list[tuple[np.ndarray, np.ndarray]] = []
    for mesh in direct:
        for start, end, line_class in _candidate_edges(mesh, direction):
            if line_class == "feature" and mesh.entity_id in joint_lines_off:
                continue
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
    return lines


def _ocp_section_segments(shape: cq.Shape, normal: np.ndarray, offset: float, tolerance_mm: float) -> list[np.ndarray]:
    origin = normal * offset
    section = BRepAlgoAPI_Section(
        shape.wrapped,
        gp_Pln(gp_Pnt(*origin.tolist()), gp_Dir(*normal.tolist())),
        True,
    ).Shape()
    segments: list[np.ndarray] = []
    deflection = max(tolerance_mm, 0.05)
    for edge in cq.Shape.cast(section).Edges():
        # Preserve exact linear section edges as one CAD segment. Sampling a
        # straight edge at the curve tolerance creates thousands of collinear
        # fragments without adding geometric information.
        if edge.geomType() == "LINE":
            points, _ = edge.sample(2)
            coordinates = [point.toTuple() for point in points]
        else:
            # 容差是弦高，不是步长。按弧长每 0.5 mm 取一点会把半径 130 mm 的
            # 檩切面拆成一千六百多段，图线数与文件体积随之失控，而弦高
            # 采样只要三十七段就达到同样精度。
            sampler = GCPnts_QuasiUniformDeflection(BRepAdaptor_Curve(edge.wrapped), deflection)
            if not sampler.IsDone() or sampler.NbPoints() < 2:
                points, _ = edge.sample(2)
                coordinates = [point.toTuple() for point in points]
            else:
                coordinates = [
                    (lambda value: (value.X(), value.Y(), value.Z()))(sampler.Value(index))
                    for index in range(1, sampler.NbPoints() + 1)
                ]
        for left, right in zip(coordinates, coordinates[1:], strict=False):
            segments.append(np.asarray([left, right], dtype=float))
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
        triangles = pool.triangles[overlap]
        triangle_depths = pool.depths[overlap]
        ax, ay = triangles[:, 0, 0], triangles[:, 0, 1]
        bx, by = triangles[:, 1, 0], triangles[:, 1, 1]
        cx, cy = triangles[:, 2, 0], triangles[:, 2, 1]
        denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        usable = np.abs(denominator) >= 1e-9
        safe = np.where(usable, denominator, 1.0)
        # 采样点乘三角形的稠密矩阵按行分块算。构件密集的项目里这个乘积能到
        # 数千乘数万，一次成型要几 GiB，直接内存不足。分块只改内存策略，
        # 每块仍对全部候选三角形取最近深度，结果与整块计算一致。
        nearest_all = np.empty(len(fractions), dtype=float)
        block = max(1, _VISIBILITY_BLOCK_ELEMENTS // max(len(overlap), 1))
        for offset in range(0, len(fractions), block):
            chunk = points[offset:offset + block]
            px = chunk[:, 0][:, None]
            py = chunk[:, 1][:, None]
            inside_bbox = (
                (px >= bounds_min[None, :, 0] - 1e-7) & (px <= bounds_max[None, :, 0] + 1e-7)
                & (py >= bounds_min[None, :, 1] - 1e-7) & (py <= bounds_max[None, :, 1] + 1e-7)
            )
            w1 = ((by - cy)[None, :] * (px - cx[None, :]) + (cx - bx)[None, :] * (py - cy[None, :])) / safe[None, :]
            w2 = ((cy - ay)[None, :] * (px - cx[None, :]) + (ax - cx)[None, :] * (py - cy[None, :])) / safe[None, :]
            w3 = 1.0 - w1 - w2
            inside = inside_bbox & usable[None, :] & (np.minimum(np.minimum(w1, w2), w3) >= -1e-7)
            depth_grid = w1 * triangle_depths[None, :, 0] + w2 * triangle_depths[None, :, 1] + w3 * triangle_depths[None, :, 2]
            nearest_all[offset:offset + len(chunk)] = np.where(inside, depth_grid, np.inf).min(axis=1)
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
    # 可辨间距守卫丢掉的组数随视图产物记录，不做静默截断
    dropped_groups: list[str] = []
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
        # 剖面与平面还要画剖切面之外的可见投影。只画剖切线的话，平面上
        # 只剩几个柱截面，剖面上看不到后面那一榀的梁架，都不成图。
        # 剖切面与观察者之间的构件按剖切规则移除，其余按可见轮廓投影。
        beyond = [mesh for mesh in selected if _is_beyond_plane(mesh, normal, origin, direction)]
        lines.extend(_projected_lines(view, manifest, beyond, right, up, direction, triangle_pool, crop_bounds, dropped_groups))
    else:
        lines.extend(_projected_lines(view, manifest, selected, right, up, direction, triangle_pool, crop_bounds, dropped_groups))
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
        # 本视图实际执行的图面细节层级与按可辨间距丢弃的组数（质量基准 4.3）
        "detailRules": view.get("detailRules", []),
        "detailDroppedGroupCount": len(dropped_groups),
        "boundsMm": bounds,
        "lines": sorted(lines, key=lambda item: item["lineId"]),
        "materialRegions": sorted(material_regions, key=lambda item: item["regionId"]),
    }
    payload["viewGeometrySha256"] = sha256_value(payload)
    return payload


# 标注名称按视图横轴在模型里的方向定：沿 X 是宽，沿 Y 是长。
#
# 这条尺寸量的是图上画出来的全部内容，不只是建筑本体。项目带场地构件时
# （覆盖步道、巷道顶棚一类），它比建筑的面阔大，因此不能叫总面阔：
# 面阔在术语上指建筑本体的开间总宽，用来标图形外廓是标注错误。
def _overall_dimension_label(requirement: dict[str, Any]) -> str:
    right = requirement.get("right") or [1, 0, 0]
    dominant = max(range(3), key=lambda index: abs(float(right[index])))
    return {0: "图形总宽", 1: "图形总长", 2: "图形总高"}[dominant]



# 把矩阵下发的标注请求解析成带模型坐标锚点的标注。规划在 TypeScript 侧
# 完成（哪条轴、取自哪个构件、位置多少），这里只负责给出画在哪。
#
# 轴线沿 u 的竖着画、沿 v 的横着画。轴号圈与尺寸链都排在图形下沿或左沿
# 之外的标注带里，纸面偏移由写出器按比例换算，这里只给锚点。
# 构件引线标注的落位。文字放在锚点周围八个方向里第一个不与已放标注相碰的
# 位置；八个方向都放不下就丢弃并计数，不缩字也不压别的标注。
#
# 落位在这里一次决定，DXF 与纸面成果用同一结果。放在各写出器里各算一遍，
# 同一张图的两种成果会把同一个标注放在不同位置。
_LABEL_DIRECTIONS = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))
_LABEL_LEADER_PAPER_MM = 6.0
_LABEL_TEXT_HEIGHT_PAPER_MM = 3.0
_SECTION_MARK_RUN_PAPER_MM = 8.0


def _text_width_mm(text: str, height_mm: float) -> float:
    # 中日韩字符按一个字宽，其余按 0.55 估。用于避让，不用于排版精度。
    units = sum(1.0 if ord(character) > 0x2E80 else 0.55 for character in text)
    return units * height_mm


def _boxes_overlap(first, second) -> bool:
    return not (
        first[2] <= second[0] or second[2] <= first[0]
        or first[3] <= second[1] or second[3] <= first[1]
    )


def _place_labels(view: dict[str, Any], plan: dict[str, Any], bounds: list[list[float]]) -> tuple[list[dict[str, Any]], int]:
    scale = float(view["scaleDenominator"])
    height = _LABEL_TEXT_HEIGHT_PAPER_MM * scale
    leader = _LABEL_LEADER_PAPER_MM * scale
    (u0, v0), (u1, v1) = bounds
    # 剖切符号先占位：它画在图内两端，构件标注不能压上去
    run = _SECTION_MARK_RUN_PAPER_MM * scale
    placed: list[tuple[float, float, float, float]] = []
    for mark in plan.get("sectionMarks", []):
        column = mark["fromMm"][0]
        for edge, sign in ((v0, 1.0), (v1, -1.0)):
            # 图号写在剖切段左侧，右对齐，按字数估宽；估窄了构件标注会压上来
            placed.append((
                column - height * 10, min(edge, edge + sign * run) - height,
                column + height, max(edge, edge + sign * run) + height,
            ))
    out: list[dict[str, Any]] = []
    dropped = 0
    for index, label in enumerate(plan.get("labels", [])):
        anchor = label["anchorMm"]
        width = _text_width_mm(label["text"], height)
        chosen = None
        for dx, dy in _LABEL_DIRECTIONS:
            x = anchor[0] + dx * leader
            y = anchor[1] + dy * leader
            box = (
                x if dx >= 0 else x - width,
                y - height / 2,
                (x + width) if dx >= 0 else x,
                y + height / 2,
            )
            if box[0] < u0 - leader or box[2] > u1 + leader or box[1] < v0 or box[3] > v1:
                continue
            if any(_boxes_overlap(box, other) for other in placed):
                continue
            chosen = (x, y, box, "start" if dx >= 0 else "end")
            break
        if chosen is None:
            dropped += 1
            continue
        placed.append(chosen[2])
        out.append({
            "requirementId": f"label:{view['id']}:{index}",
            "kind": "componentLabel", "viewId": view["id"],
            "space": "view", "layerKey": "text", "paperTextHeightMm": _LABEL_TEXT_HEIGHT_PAPER_MM,
            "text": label["text"], "textAlign": chosen[3],
            "anchorMm": [[anchor[0], anchor[1]], [chosen[0], chosen[1]]],
            "sourceRefs": list(label["sourceEntityIds"]),
        })
    return out, dropped


def _plan_annotations(view: dict[str, Any], bounds: list[list[float]]) -> list[dict[str, Any]]:
    plan = view.get("annotationPlan") or {}
    view_id = view["id"]
    out: list[dict[str, Any]] = []
    (u0, v0), (u1, v1) = bounds

    axes = plan.get("axes", [])
    for index, axis in enumerate(axes):
        along = axis["along"]
        position = axis["positionMm"]
        # 轴线从图形另一端画到标注带：沿 u 的从上沿画到下沿之外，
        # 沿 v 的从右沿画到左沿之外，末端放轴号圈。
        anchor = [[position, v1], [position, v0]] if along == "u" else [[u1, position], [u0, position]]
        out.append({
            "requirementId": f"axis:{view_id}:{axis['label']}",
            "kind": "axisGrid", "viewId": view_id,
            "space": "view", "layerKey": "axis", "paperTextHeightMm": 3.0,
            "text": axis["label"], "along": along, "basisZh": axis["basisZh"],
            "anchorMm": anchor,
            "sourceRefs": list(axis["sourceEntityIds"]),
        })

    # 尺寸链按同一族相邻两条轴线之间的净距，逐段标。总尺寸另有一条，
    # 由 overallDimension 承担，这里不重复。
    for along in ("u", "v"):
        family = sorted(
            (item for item in axes if item["along"] == along),
            key=lambda item: item["positionMm"],
        )
        for first, second in zip(family, family[1:]):
            span = round(second["positionMm"] - first["positionMm"], 1)
            if span <= 0:
                continue
            anchor = (
                [[first["positionMm"], v0], [second["positionMm"], v0]] if along == "u"
                else [[u0, first["positionMm"]], [u0, second["positionMm"]]]
            )
            out.append({
                "requirementId": f"chain:{view_id}:{first['label']}-{second['label']}",
                "kind": "axisDimensionChain", "viewId": view_id,
                "space": "view", "layerKey": "dimension", "paperTextHeightMm": 2.5,
                "valueMm": span, "text": f"{span:.0f}", "along": along,
                "anchorMm": anchor,
                "sourceRefs": list(first["sourceEntityIds"]) + list(second["sourceEntityIds"]),
            })

    for mark in plan.get("sectionMarks", []):
        out.append({
            "requirementId": f"section:{view_id}:{mark['label']}",
            "kind": "sectionMark", "viewId": view_id,
            "space": "view", "layerKey": "dimension", "paperTextHeightMm": 3.5,
            "text": mark["label"], "targetViewKey": mark["targetViewKey"],
            "anchorMm": [list(mark["fromMm"]), list(mark["toMm"])],
            "sourceRefs": [view_id],
        })

    for index, item in enumerate(plan.get("detailIndexes", [])):
        # 详图上的回引没有具体位置，放在图形左上角
        at = list(item["atMm"]) if item["direction"] == "parent" else [u0, v1]
        out.append({
            "requirementId": f"detail:{view_id}:{index}",
            "kind": "detailIndex", "viewId": view_id,
            "space": "view", "layerKey": "dimension", "paperTextHeightMm": 3.0,
            "text": item["label"], "direction": item["direction"],
            "anchorMm": [at],
            "sourceRefs": [view_id],
        })

    for level in plan.get("levels", []):
        # 标高符号画在图形右沿之外，指向该标高所在的高度
        out.append({
            "requirementId": f"level:{view_id}:{level['label']}",
            "kind": "levelMark", "viewId": view_id,
            "space": "view", "layerKey": "dimension", "paperTextHeightMm": 2.5,
            "text": f"{level['label']} {level['elevationMm'] / 1000:.3f}",
            "basisZh": level["basisZh"],
            "anchorMm": [[u1, level["elevationMm"]]],
            "sourceRefs": list(level["sourceEntityIds"]),
        })

    labels, dropped = _place_labels(view, plan, bounds)
    out.extend(labels)
    if dropped:
        # 避让不开的丢弃数并入视图的丢弃统计，不静默吞掉
        plan.setdefault("droppedByKind", {})
        plan["droppedByKind"]["componentLabelPlacement"] = dropped

    return out


def build_drawing_ir(matrix: dict[str, Any], manifest: dict[str, Any], views: list[dict[str, Any]]) -> dict[str, Any]:
    view_by_id = {item["viewId"]: item for item in views}
    # 标注的唯一来源。写出器只按 kind 渲染，不再各自从视图 bounds 重新推
    # 该标什么：此前 DXF 与 SVG 各推一遍，同一张图的图名一个画在图上方、
    # 一个画在下方，且加一种标注要改三个地方。
    #
    # 每条标注给出模型坐标锚点（与 lines[].pointsMm 同一坐标系）、图层键、
    # 纸面字高与出处。纸面偏移（尺寸线离图形多远）留在写出器作共用常量，
    # 那是出图表达，不是图纸内容。
    annotations: list[dict[str, Any]] = []
    for view in matrix["views"]:
        bounds = view_by_id[view["id"]]["boundsMm"]
        value = round(bounds[1][0] - bounds[0][0], 3)
        annotations.extend([
            {
                "requirementId": f"dimension:{view['id']}", "kind": "overallDimension", "viewId": view["id"],
                "space": "view", "layerKey": "dimension", "paperTextHeightMm": 3.0,
                "valueMm": value, "text": f"{_overall_dimension_label(view)} {value:.0f} mm",
                # 尺寸的两个端点取图形下沿的左右极值
                "anchorMm": [[bounds[0][0], bounds[0][1]], [bounds[1][0], bounds[0][1]]],
                "sourceRefs": [manifest["geometryRevisionId"]],
            },
            {
                "requirementId": f"title:{view['id']}", "kind": "viewTitle", "viewId": view["id"],
                "space": "view", "layerKey": "text", "paperTextHeightMm": 4.0,
                "text": f"{view['displayLabelZh']}  1:{view['scaleDenominator']}  {view['drawingRef']}",
                "anchorMm": [[bounds[0][0], bounds[0][1]]],
                "sourceRefs": [view["id"]],
            },
            {
                # 模型空间没有图签，单取模型空间的人会丢掉资格声明，因此这一条
                # 只出在模型空间；纸面成果由图签承载同一句话，不重复画。
                "requirementId": f"qualification:{view['id']}", "kind": "qualification", "viewId": view["id"],
                "space": "modelSpaceOnly", "layerKey": "text", "paperTextHeightMm": 2.5,
                "text": "代理成果·未签发\n未经项目责任人员专业复核，不可用于正式交付或施工。",
                "anchorMm": [[bounds[0][0], bounds[1][1]]],
                "sourceRefs": [manifest["geometryRevisionId"]],
            },
        ])
        annotations.extend(_plan_annotations(view, bounds))
    for observation in matrix.get("observationCandidates", []):
        view = matrix["views"][0]
        bounds = view_by_id[view["id"]]["boundsMm"]
        annotations.append({
            "requirementId": f"condition:{observation['id']}", "kind": "conditionCandidate", "viewId": view["id"],
            "space": "view", "layerKey": "condition", "paperTextHeightMm": 3.0,
            "text": f"演示观察候选：{observation['displayLabelZh']}（未确认）",
            "anchorMm": [[(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]],
            "sourceRefs": [observation["targetEntityId"]],
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
            "axis": "GJ-AXIS",
        },
    }
    ir["drawingIrSha256"] = sha256_value(ir)
    return ir
