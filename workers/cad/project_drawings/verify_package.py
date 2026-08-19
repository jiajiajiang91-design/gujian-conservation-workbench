from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import ezdxf
import cadquery as cq
import numpy as np
import trimesh
from PIL import Image
from fontTools.ttLib import TTFont
from pypdf import PdfReader
from shapely.geometry import LineString, Point, Polygon, box
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
from shapely.ops import unary_union


STATUS = "passed-task-driven-drawing-artifacts"
QUALIFICATION = "generated-not-qualified"
SVG_NS = "{http://www.w3.org/2000/svg}"


def _segment_key(entity_id: str, points: Any, precision: int = 5) -> tuple[str, tuple[float, float], tuple[float, float]]:
    normalized = [tuple(round(float(value), precision) for value in point) for point in points]
    left, right = sorted(normalized)
    return entity_id, left, right


def _load_geometry_meshes(geometry_dir: Path, manifest: dict[str, Any]) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    scene = trimesh.load(geometry_dir / "model.glb", force="scene", process=False)
    if set(scene.geometry) != {item["id"] for item in manifest["entities"]}:
        raise ValueError("GLB entity closure differs from manifest")
    meshes: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for entity_id, mesh in scene.geometry.items():
        vertices = np.asarray(mesh.vertices, dtype=float)
        project_vertices = np.column_stack((vertices[:, 0], -vertices[:, 2], vertices[:, 1])) * 1000.0
        meshes[entity_id] = project_vertices, np.asarray(mesh.faces, dtype=np.int64)
    return meshes


def _load_geometry_shapes(geometry_dir: Path, manifest: dict[str, Any]) -> dict[str, cq.Shape]:
    shapes: dict[str, cq.Shape] = {}
    for item in manifest["entities"]:
        path = geometry_dir / "brep" / f"{item['id']}.brep"
        if not path.is_file() or _hash(path) != item.get("brepSha256"):
            raise ValueError(f"exact BRep closure failed for {item['id']}")
        shapes[item["id"]] = cq.Shape.importBrep(str(path))
    return shapes


def _independent_ocp_section(shape: cq.Shape, normal: np.ndarray, offset: float) -> list[np.ndarray]:
    origin = normal * offset
    result = BRepAlgoAPI_Section(shape.wrapped, gp_Pln(gp_Pnt(*origin.tolist()), gp_Dir(*normal.tolist())), True).Shape()
    segments: list[np.ndarray] = []
    for edge in cq.Shape.cast(result).Edges():
        # 容差是弦高不是步长：直线边一段，曲线边按弦高 0.5 mm 采样。
        # 按弧长采样会把一个圆切面拆成上千段，与制图侧对不上，
        # 两侧偏差也会超过 Hausdorff 判定阈值。
        if edge.geomType() == "LINE":
            points, _ = edge.sample(2)
            coordinates = [point.toTuple() for point in points]
        else:
            sampler = GCPnts_QuasiUniformDeflection(BRepAdaptor_Curve(edge.wrapped), 0.5)
            if not sampler.IsDone() or sampler.NbPoints() < 2:
                points, _ = edge.sample(2)
                coordinates = [point.toTuple() for point in points]
            else:
                coordinates = [
                    (sampler.Value(index).X(), sampler.Value(index).Y(), sampler.Value(index).Z())
                    for index in range(1, sampler.NbPoints() + 1)
                ]
        for left, right in zip(coordinates, coordinates[1:], strict=False):
            segments.append(np.asarray([left, right], dtype=float))
    return segments


def _independent_candidate_edges(vertices: np.ndarray, faces: np.ndarray, direction: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    triangles = vertices[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    normals[lengths > 0] /= lengths[lengths > 0, None]
    adjacency: dict[tuple[int, int], list[int]] = {}
    for face_index, face in enumerate(faces):
        for start, end in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            adjacency.setdefault(tuple(sorted((int(start), int(end)))), []).append(face_index)
    result: list[tuple[np.ndarray, np.ndarray]] = []
    for (start, end), attached in adjacency.items():
        keep = len(attached) == 1
        if len(attached) == 2:
            facing = [float(np.dot(normals[index], direction)) for index in attached]
            normal_dot = float(np.dot(normals[attached[0]], normals[attached[1]]))
            keep = facing[0] * facing[1] <= 0 and max(abs(facing[0]), abs(facing[1])) > 1e-5
            keep = keep or (normal_dot < math.cos(math.radians(15.0)) and min(facing) <= 1e-5)
        if keep:
            result.append((vertices[start], vertices[end]))
    return result


def _independent_triangle_depth(point: np.ndarray, triangle: np.ndarray, depths: np.ndarray) -> float | None:
    left, middle, right = triangle
    denominator = (middle[1] - right[1]) * (left[0] - right[0]) + (right[0] - middle[0]) * (left[1] - right[1])
    if abs(float(denominator)) < 1e-9:
        return None
    a = ((middle[1] - right[1]) * (point[0] - right[0]) + (right[0] - middle[0]) * (point[1] - right[1])) / denominator
    b = ((right[1] - left[1]) * (point[0] - right[0]) + (left[0] - right[0]) * (point[1] - right[1])) / denominator
    c = 1.0 - a - b
    if min(a, b, c) < -1e-7:
        return None
    return float(a * depths[0] + b * depths[1] + c * depths[2])


def _independent_visibility_intervals(segment: np.ndarray, segment_depth: np.ndarray, triangles: list[tuple[np.ndarray, np.ndarray]]) -> list[tuple[float, float]]:
    line = LineString(segment)
    events = {0.0, 1.0}
    for triangle, _ in triangles:
        overlap = line.intersection(Polygon(triangle))
        geometries = list(overlap.geoms) if hasattr(overlap, "geoms") else [overlap]
        for geometry in geometries:
            if geometry.is_empty:
                continue
            if geometry.geom_type == "LineString":
                for coordinate in (geometry.coords[0], geometry.coords[-1]):
                    events.add(max(0.0, min(1.0, float(line.project(Point(coordinate)) / max(line.length, 1e-12)))))
            elif geometry.geom_type == "Point":
                events.add(max(0.0, min(1.0, float(line.project(geometry) / max(line.length, 1e-12)))))
    ordered = sorted(events)
    visible: list[tuple[float, float]] = []
    for left, right in zip(ordered, ordered[1:], strict=False):
        fraction = (left + right) / 2
        point = segment[0] * (1 - fraction) + segment[1] * fraction
        depth = float(segment_depth[0] * (1 - fraction) + segment_depth[1] * fraction)
        nearest = math.inf
        for triangle, depths in triangles:
            if point[0] < triangle[:, 0].min() - 1e-7 or point[0] > triangle[:, 0].max() + 1e-7:
                continue
            if point[1] < triangle[:, 1].min() - 1e-7 or point[1] > triangle[:, 1].max() + 1e-7:
                continue
            candidate = _independent_triangle_depth(point, triangle, depths)
            if candidate is not None:
                nearest = min(nearest, candidate)
        if nearest >= depth - 0.5 and right - left > 1e-9:
            if visible and abs(visible[-1][1] - left) < 1e-9:
                visible[-1] = (visible[-1][0], right)
            else:
                visible.append((left, right))
    return visible


def _independent_crop(segment: np.ndarray, crop_bounds: list[float] | None) -> list[np.ndarray]:
    if crop_bounds is None:
        return [segment]
    intersection = LineString(segment).intersection(box(*crop_bounds))
    geometries = list(intersection.geoms) if hasattr(intersection, "geoms") else [intersection]
    return [np.asarray(geometry.coords, dtype=float) for geometry in geometries if geometry.geom_type == "LineString" and geometry.length >= 0.05]


def _independent_view_line_sets(matrix: dict[str, Any], manifest: dict[str, Any], geometry_dir: Path) -> dict[str, set[tuple[str, tuple[float, float], tuple[float, float]]]]:
    component_type = {item["id"]: item["componentType"] for item in manifest["entities"]}
    meshes = _load_geometry_meshes(geometry_dir, manifest)
    shapes = _load_geometry_shapes(geometry_dir, manifest)
    output: dict[str, set[tuple[str, tuple[float, float], tuple[float, float]]]] = {}
    for view in matrix["views"]:
        direction = np.asarray(view["direction"], dtype=float)
        right_vector = np.asarray(view["right"], dtype=float)
        up_vector = np.asarray(view["up"], dtype=float)
        source_entity_ids = set(view.get("sourceEntityIds", []))
        selected = {
            entity_id: value
            for entity_id, value in meshes.items()
            if (not source_entity_ids or entity_id in source_entity_ids)
            and (not view.get("sourceTypes") or component_type[entity_id] in view["sourceTypes"])
        }
        crop_bounds = view.get("cropBoundsMm")
        expected: set[tuple[str, tuple[float, float], tuple[float, float]]] = set()

        # 遮挡投影对全模型判可见，投影集合本身可以另选一部分构件。
        # 剖面与平面只投影剖切面之外的部分，剖切面与观察者之间的构件被移除。
        def add_projection(projection_ids: set[str]) -> None:
            projected_triangles: list[tuple[np.ndarray, np.ndarray]] = []
            for vertices, faces in selected.values():
                for triangle in vertices[faces]:
                    projected_triangles.append((np.column_stack((triangle @ right_vector, triangle @ up_vector)), triangle @ direction))
            for entity_id, (vertices, faces) in selected.items():
                if entity_id not in projection_ids:
                    continue
                for start, end in _independent_candidate_edges(vertices, faces, direction):
                    segment_3d = np.vstack((start, end))
                    segment_2d = np.column_stack((segment_3d @ right_vector, segment_3d @ up_vector))
                    if np.linalg.norm(segment_2d[1] - segment_2d[0]) < 0.05:
                        continue
                    depths = segment_3d @ direction
                    for left, right in _independent_visibility_intervals(segment_2d, depths, projected_triangles):
                        clipped = np.vstack((
                            segment_2d[0] * (1 - left) + segment_2d[1] * left,
                            segment_2d[0] * (1 - right) + segment_2d[1] * right,
                        ))
                        if np.linalg.norm(clipped[1] - clipped[0]) >= 0.05:
                            for view_clipped in _independent_crop(clipped, crop_bounds):
                                expected.add(_segment_key(entity_id, view_clipped))

        if view.get("sectionPlane"):
            plane = view["sectionPlane"]
            normal = np.asarray(plane["normal"], dtype=float)
            origin = normal * float(plane["offsetMm"])
            for entity_id, (vertices, faces) in selected.items():
                for segment in _independent_ocp_section(shapes[entity_id], normal, float(plane["offsetMm"])):
                    projected = np.column_stack((segment @ right_vector, segment @ up_vector))
                    for clipped in _independent_crop(projected, crop_bounds):
                        expected.add(_segment_key(entity_id, clipped))
            toward = float(np.dot(direction, normal))
            beyond_ids = set()
            for entity_id, (vertices, faces) in selected.items():
                offsets = (vertices - origin) @ normal
                if (offsets.max() > 1e-6) if toward >= 0 else (offsets.min() < -1e-6):
                    beyond_ids.add(entity_id)
            add_projection(beyond_ids)
        else:
            add_projection(set(selected))
        output[view["id"]] = expected
    return output


# 与 sheet_writer._horizontal_label 同一条规则：横轴沿 X 是面阔，沿 Y 是进深。
# 这里按视图自己的 right 向量独立算一遍，不引用制图侧的实现。
def _horizontal_label_for(matrix: dict[str, Any], view_id: str) -> str:
    right = next(item["right"] for item in matrix["views"] if item["id"] == view_id)
    dominant = max(range(3), key=lambda index: abs(float(right[index])))
    return {0: "总面阔", 1: "总进深", 2: "总高"}[dominant]


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _without_hash(value: dict[str, Any], key: str) -> dict[str, Any]:
    result = dict(value)
    result.pop(key, None)
    return result


def _check(condition: bool, check_id: str, message: str, checks: list[dict[str, Any]]) -> None:
    checks.append({"id": check_id, "passed": bool(condition), "message": message})


def _autocad_summary_matches(summary: dict[str, Any], dxf_hash: str) -> bool:
    audit_copy = summary.get("auditCopy")
    font = summary.get("font")
    result = summary.get("result")
    tool = summary.get("tool")
    if not all(isinstance(item, dict) for item in (audit_copy, font, result, tool)):
        return False
    return (
        summary.get("schemaVersion") == "milestone-two-autocad-audit-summary-1"
        and summary.get("status") == "passed"
        and tool.get("product") == "AutoCAD Core Console 2024"
        and "AUDIT" in summary.get("commandCategories", [])
        and summary.get("canonicalDxfSha256") == dxf_hash
        and audit_copy.get("preAuditSha256") == dxf_hash
        and audit_copy.get("postAuditSha256") == dxf_hash
        and audit_copy.get("byteIdenticalToCanonicalBefore") is True
        and audit_copy.get("byteIdenticalToCanonicalAfter") is True
        and font.get("substitutionDetected") is False
        and result.get("exitCode") == 0
        and result.get("errorsFound") == 0
        and result.get("errorsFixed") == 0
        and result.get("objectsDeleted") == 0
        and result.get("canonicalDxfModified") is False
        and summary.get("qualification") == QUALIFICATION
        and summary.get("l1Eligible") is False
        and summary.get("formalEligibility") is False
    )


def _qcad_summary_matches(summary: dict[str, Any], dxf_hash: str, drawing_numbers: list[str]) -> bool:
    input_summary = summary.get("input")
    open_and_view = summary.get("openAndView")
    print_summary = summary.get("print")
    tool = summary.get("tool")
    if not all(isinstance(item, dict) for item in (input_summary, open_and_view, print_summary, tool)):
        return False
    return (
        summary.get("schemaVersion") == "milestone-two-qcad-compatibility-1"
        and summary.get("status") == "passed-open-view-print-only"
        and str(tool.get("product", "")).startswith("QCAD")
        and input_summary.get("canonicalDxfSha256") == dxf_hash
        and input_summary.get("temporaryCopySha256AfterCheck") == dxf_hash
        and open_and_view.get("exitCode") == 0
        and open_and_view.get("importSucceeded") is True
        and print_summary.get("exitCode") == 0
        and print_summary.get("layouts") == drawing_numbers
        and print_summary.get("pageCount") == len(drawing_numbers)
        and summary.get("saveBackPerformed") is False
        and summary.get("canonicalDxfModified") is False
        and summary.get("qualification") == QUALIFICATION
        and summary.get("l1Eligible") is False
        and summary.get("formalEligibility") is False
    )


def _visible_dxf_text(doc) -> list[str]:
    values: list[str] = []
    for layout in doc.layouts:
        for entity in layout:
            if entity.dxftype() in {"TEXT", "MTEXT", "ATTRIB"}:
                values.append(entity.plain_text() if entity.dxftype() == "MTEXT" else entity.dxf.text)
            if entity.dxftype() == "INSERT":
                values.extend(attribute.dxf.text for attribute in entity.attribs)
    return values


def _font_programs(reader: PdfReader) -> list[dict[str, Any]]:
    fonts: list[dict[str, Any]] = []
    for page in reader.pages:
        resources = page.get("/Resources") or {}
        for name, reference in (resources.get("/Font") or {}).items():
            font = reference.get_object()
            descriptor_ref = font.get("/FontDescriptor")
            descriptor = descriptor_ref.get_object() if descriptor_ref else {}
            embedded = descriptor.get("/FontFile2")
            fonts.append({
                "resource": str(name),
                "baseFont": str(font.get("/BaseFont", "")),
                "hasToUnicode": font.get("/ToUnicode") is not None,
                "embeddedBytes": embedded.get_object().get_data() if embedded else None,
            })
    return fonts


def verify(
    matrix_path: Path,
    geometry_dir: Path,
    output_dir: Path,
    font_path: Path,
    autocad_summary_path: Path | None = None,
    qcad_summary_path: Path | None = None,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    manifest = json.loads((geometry_dir / "manifest.json").read_text(encoding="utf-8"))
    record = json.loads((output_dir / "drawing-build-record.json").read_text(encoding="utf-8"))
    ir = json.loads((output_dir / "drawing-ir.json").read_text(encoding="utf-8"))
    assets = {item["fileName"]: item for item in record["assets"]}

    _check(record["artifactRequirementMatrixSha256"] == _canonical_hash(matrix), "contract-hash", "成果要求矩阵哈希与当前输入一致", checks)
    _check(record["geometryRevisionId"] == manifest["geometryRevisionId"] == ir["geometryRevisionId"], "geometry-revision", "全部成果绑定同一个 GeometryRevision", checks)
    _check(ir["drawingIrSha256"] == _canonical_hash(_without_hash(ir, "drawingIrSha256")), "drawing-ir-hash", "Drawing IR 可独立复算", checks)
    _check(record["status"] == ir["status"] == QUALIFICATION and not record["l1Eligible"] and not record["formalEligibility"], "qualification-boundary", "成果保持未核定、L1=false、不可正式使用", checks)
    _check(record["viewCount"] == len(matrix["views"]) == len(ir["views"]) and record["sheetCount"] == len(matrix["sheets"]) == len(ir["sheets"]), "dynamic-matrix", "视图和图纸数量来自当前任务矩阵", checks)

    asset_hashes_ok = True
    for name, asset in assets.items():
        path = output_dir / name
        asset_hashes_ok = asset_hashes_ok and path.is_file() and _hash(path) == asset["sha256"] and path.stat().st_size == asset["byteLength"]
    _check(asset_hashes_ok, "asset-closure", "构建记录中的全部资产哈希和字节数闭合", checks)

    entity_ids = {item["id"] for item in manifest["entities"]}
    view_lines = 0
    view_regions = 0
    view_ok = True
    allowed_classes = {"cut", "silhouette", "feature", "componentBoundary"}
    for view in ir["views"]:
        source_path = output_dir / "view-geometry" / f"{view['viewKey']}.json.gz"
        with gzip.open(source_path, "rt", encoding="utf-8") as stream:
            exported = json.load(stream)
        view_ok = view_ok and exported == view
        view_ok = view_ok and view["viewGeometrySha256"] == _canonical_hash(_without_hash(view, "viewGeometrySha256"))
        ids = [line["lineId"] for line in view["lines"]]
        view_ok = view_ok and len(ids) == len(set(ids))
        for line in view["lines"]:
            view_ok = view_ok and line["sourceEntityId"] in entity_ids and line["geometryRevisionId"] == manifest["geometryRevisionId"]
            view_ok = view_ok and line["lineClass"] in allowed_classes and line["visibility"] == "visible"
            view_ok = view_ok and len(line["pointsMm"]) == 2 and math.dist(*line["pointsMm"]) > 0.01
        for region in view["materialRegions"]:
            view_ok = view_ok and region["sourceEntityId"] in entity_ids and region["geometryRevisionId"] == manifest["geometryRevisionId"]
            view_ok = view_ok and len(region["boundaryMm"]) >= 4 and region["boundaryMm"][0] == region["boundaryMm"][-1]
        view_lines += len(view["lines"])
        view_regions += len(view["materialRegions"])
    _check(view_ok and view_lines > 0, "view-geometry-closure", "全部 ViewGeometry 的来源、修订、类别和哈希闭合", checks)

    independently_recomputed = _independent_view_line_sets(matrix, manifest, geometry_dir)
    recompute_ok = True
    for view in ir["views"]:
        actual = {_segment_key(line["sourceEntityId"], line["pointsMm"]) for line in view["lines"]}
        expected = independently_recomputed[view["viewId"]]
        entity_set = {item[0] for item in actual | expected}
        recompute_ok = recompute_ok and {item[0] for item in actual} == {item[0] for item in expected}
        for entity_id in entity_set:
            actual_union = unary_union([LineString([item[1], item[2]]) for item in actual if item[0] == entity_id])
            expected_union = unary_union([LineString([item[1], item[2]]) for item in expected if item[0] == entity_id])
            recompute_ok = recompute_ok and actual_union.hausdorff_distance(expected_union) <= 0.001
            recompute_ok = recompute_ok and abs(actual_union.length - expected_union.length) <= 0.001
    _check(recompute_ok, "source-geometry-recompute", "独立从 GLB 重算真实剖切、候选边和遮挡可见线，完整集合一致", checks)

    doc = ezdxf.readfile(output_dir / "drawings.dxf")
    audit = doc.audit()
    native_types = {entity.dxftype() for layout in doc.layouts for entity in layout}
    layout_names = [name for name in doc.layouts.names() if name != "Model"]
    expected_layouts = [sheet["drawingNumber"] for sheet in matrix["sheets"]]
    user_viewports = [entity for name in layout_names for entity in doc.layouts.get(name).query("VIEWPORT") if entity.dxf.id > 1]
    _check(not audit.errors and doc.header["$INSUNITS"] == 4 and doc.dxfversion == "AC1032", "native-dxf-baseline", "DXF 为 R2018、毫米、ezdxf 审计零错误", checks)
    requires_hatch = any(view.get("materialRegions") for view in ir["views"])
    native_types_ok = {"LINE", "DIMENSION", "TEXT", "MTEXT", "INSERT"}.issubset(native_types)
    native_types_ok = native_types_ok and (not requires_hatch or "HATCH" in native_types)
    _check(native_types_ok, "native-dxf-types", "原生结构线、按需填充、单行/多行文字和块均存在", checks)
    business_linetypes = {item.dxf.name for item in doc.linetypes}
    business_layers_ok = doc.layers.get("GJ-CONDITION").dxf.linetype == "GJ-DASHED" and doc.layers.get("GJ-AXIS").dxf.linetype == "GJ-CENTER"
    _check({"GJ-DASHED", "GJ-CENTER"}.issubset(business_linetypes) and business_layers_ok, "native-business-linetypes", "虚线与轴线为原生业务线型并绑定对应图层", checks)
    _check(layout_names == expected_layouts and len(user_viewports) == len(matrix["views"]) and all(item.dxf.flags & 0x4000 for item in user_viewports), "native-layouts", "动态图纸布局和全部锁定视口与任务矩阵一致", checks)
    condition_count = len(doc.modelspace().query('*[layer=="GJ-CONDITION"]'))
    expects_conditions = bool(matrix.get("observationCandidates"))
    _check(
        "GJ-CONDITION" in doc.layers and ((condition_count > 0) == expects_conditions),
        "condition-layer",
        "现状候选图层仅在当前任务存在观察候选时包含对象",
        checks,
    )

    sidecar_rows = [json.loads(line) for line in (output_dir / "drawing-source-map.ndjson").read_text(encoding="utf-8").splitlines() if line]
    handles = {entity.dxf.handle: entity for layout in doc.layouts for entity in layout if entity.dxf.handle}
    sidecar_ok = len(sidecar_rows) == record["trackedCadObjectCount"] and len({row["cadObjectId"] for row in sidecar_rows}) == len(sidecar_rows)
    for row in sidecar_rows:
        entity = handles.get(row["handle"])
        sidecar_ok = sidecar_ok and entity is not None and entity.dxftype() == row["dxftype"] and entity.has_xdata("GJ_PROV")
        if row["objectClass"] == "structure":
            sidecar_ok = sidecar_ok and row["sourceEntityId"] in entity_ids and row["geometryRevisionId"] == manifest["geometryRevisionId"]
    _check(sidecar_ok, "cad-provenance", "CAD XDATA 与来源映射逐对象闭合", checks)

    visible_text = "\n".join(_visible_dxf_text(doc))
    forbidden_visible = ["targetViewId", "generated-not-qualified", "proxy-unissued", "2000-01-01"]
    _check(not any(value in visible_text for value in forbidden_visible) and not re.search(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", visible_text, re.I), "visible-labels", "图面不显示内部 ID、英文状态、假日期或完整 UUID", checks)
    _check("代理成果·未签发" in visible_text and visible_text.count("未签发") >= len(matrix["sheets"]) * 2, "titleblock-boundary", "图签明确代理、未签发和未签发日期", checks)

    svg_structure_count = 0
    svg_region_count = 0
    svg_text = ""
    svg_ok = True
    for sheet in matrix["sheets"]:
        root = ET.parse(output_dir / f"{sheet['drawingNumber']}.svg").getroot()
        svg_ok = svg_ok and root.attrib.get("width") == f"{sheet['pageMm'][0]}mm" and root.attrib.get("height") == f"{sheet['pageMm'][1]}mm"
        svg_ok = svg_ok and not list(root.iter(f"{SVG_NS}image"))
        svg_structure_count += sum(1 for item in root.iter(f"{SVG_NS}line") if item.attrib.get("data-source-entity"))
        svg_region_count += sum(1 for item in root.iter(f"{SVG_NS}polygon") if item.attrib.get("data-source-entity"))
        svg_text += "\n".join("".join(item.itertext()) for item in root.iter(f"{SVG_NS}text"))
        serialized = (output_dir / f"{sheet['drawingNumber']}.svg").read_text(encoding="utf-8")
        svg_ok = svg_ok and not re.search(r"(?:href|src)=[\"'](?:https?://|file:/)", serialized, re.I)
    _check(svg_ok and svg_structure_count == view_lines and svg_region_count == view_regions, "svg-closure", "SVG 页面、结构线、材料区和字体依赖闭合", checks)

    reader = PdfReader(output_dir / "drawings.pdf")
    pdf_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    pages_ok = len(reader.pages) == len(matrix["sheets"])
    for page, sheet in zip(reader.pages, matrix["sheets"], strict=True):
        width = float(page.mediabox.width) * 25.4 / 72
        height = float(page.mediabox.height) * 25.4 / 72
        pages_ok = pages_ok and abs(width - sheet["pageMm"][0]) < 0.05 and abs(height - sheet["pageMm"][1]) < 0.05
        pages_ok = pages_ok and "/XObject" not in (page.get("/Resources") or {})
    fonts = _font_programs(reader)
    embedded_fonts = [item for item in fonts if item["embeddedBytes"]]
    font_ok = len(embedded_fonts) == len(matrix["sheets"]) and all(item["hasToUnicode"] for item in embedded_fonts)
    for item in fonts:
        if item["embeddedBytes"]:
            parsed = TTFont(__import__("io").BytesIO(item["embeddedBytes"]))
            font_ok = font_ok and parsed["OS/2"].usWeightClass == 400 and parsed["OS/2"].fsType == 0
    required_text = ["代理成果·未签发", *[view["displayLabelZh"] for view in matrix["views"]], *[view["drawingRef"] for view in matrix["views"]]]
    _check(pages_ok and font_ok and all(value in pdf_text for value in required_text) and "?" not in pdf_text and "�" not in pdf_text, "pdf-closure", "PDF 页幅、嵌入字重 400、ToUnicode 和可检索中文闭合", checks)

    png_ok = True
    for sheet in matrix["sheets"]:
        with Image.open(output_dir / f"{sheet['drawingNumber']}.png") as image:
            expected = (round(sheet["pageMm"][0] * 300 / 25.4), round(sheet["pageMm"][1] * 300 / 25.4))
            dpi = image.info.get("dpi", (0, 0))
            png_ok = png_ok and image.size == expected and abs(dpi[0] - 300) < 0.1 and abs(dpi[1] - 300) < 0.1
            extrema = image.convert("L").getextrema()
            png_ok = png_ok and extrema[0] < 250 and extrema[1] == 255
    _check(png_ok, "png-closure", "全部预览尺寸、300 dpi 元数据和非空内容闭合", checks)

    cross_format_text = all(value in svg_text and value in pdf_text and value in visible_text for value in required_text)
    # 尺寸名称随视图横轴在模型里的方向定，与 sheet_writer 的规则一致
    dimension_texts = [
        f"{_horizontal_label_for(matrix, view['viewId'])} {view['boundsMm'][1][0] - view['boundsMm'][0][0]:.0f} mm"
        for view in ir["views"]
    ]
    _check(cross_format_text and all(value in svg_text and value in pdf_text for value in dimension_texts), "cross-format-text", "图名、图号、资格状态和同源尺寸跨格式一致", checks)

    font_manifest = json.loads((font_path.parent / "font-manifest.json").read_text(encoding="utf-8"))
    bound_font_ok = _hash(font_path) == font_manifest["sha256"] and font_manifest["instance"]["usWeightClass"] == 400
    _check(bound_font_ok, "font-license-closure", "派生字体、字重和官方许可清单闭合", checks)

    autocad_summary_hash = None
    if autocad_summary_path is not None:
        autocad_summary = json.loads(autocad_summary_path.read_text(encoding="utf-8"))
        dxf_hash = _hash(output_dir / "drawings.dxf")
        autocad_ok = _autocad_summary_matches(autocad_summary, dxf_hash)
        _check(autocad_ok, "autocad-native-audit", "AutoCAD 2024 对隔离副本审计零错误、零修复、零删除、项目字体未替换", checks)
        autocad_summary_hash = _hash(autocad_summary_path)

    qcad_summary_hash = None
    if qcad_summary_path is not None:
        qcad_summary = json.loads(qcad_summary_path.read_text(encoding="utf-8"))
        dxf_hash = _hash(output_dir / "drawings.dxf")
        qcad_ok = _qcad_summary_matches(qcad_summary, dxf_hash, [sheet["drawingNumber"] for sheet in matrix["sheets"]])
        _check(qcad_ok, "qcad-view-print-compatibility", "QCAD 仅完成打开、查看和两布局打印，未另存或覆盖规范 DXF", checks)
        qcad_summary_hash = _hash(qcad_summary_path)

    failed = [item for item in checks if not item["passed"]]
    return {
        "schemaVersion": "1.0",
        "status": STATUS if not failed else "failed-task-driven-drawing-artifacts",
        "qualification": QUALIFICATION,
        "l1Eligible": False,
        "formalEligibility": False,
        "geometryRevisionId": manifest["geometryRevisionId"],
        "artifactRequirementMatrixSha256": _hash(matrix_path),
        "drawingBuildRecordSha256": _hash(output_dir / "drawing-build-record.json"),
        "fontSha256": _hash(font_path),
        "autocadAuditSummarySha256": autocad_summary_hash,
        "qcadCompatibilitySummarySha256": qcad_summary_hash,
        "checkCount": len(checks),
        "failedCheckCount": len(failed),
        "checks": checks,
        "blockers": ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"],
    }


def write_report(
    matrix_path: Path,
    geometry_dir: Path,
    output_dir: Path,
    font_path: Path,
    report_path: Path,
    autocad_summary_path: Path | None = None,
    qcad_summary_path: Path | None = None,
) -> dict[str, Any]:
    result = verify(matrix_path, geometry_dir, output_dir, font_path, autocad_summary_path, qcad_summary_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_bytes(_canonical(result) + b"\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify task-driven drawing artifacts.")
    parser.add_argument("--matrix", required=True, type=Path)
    parser.add_argument("--geometry-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--font", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--autocad-summary", type=Path)
    parser.add_argument("--qcad-summary", type=Path)
    args = parser.parse_args()
    result = write_report(args.matrix, args.geometry_dir, args.output, args.font, args.report, args.autocad_summary, args.qcad_summary)
    print(json.dumps({"status": result["status"], "checkCount": result["checkCount"], "failedCheckCount": result["failedCheckCount"]}, ensure_ascii=False, sort_keys=True))
    return 0 if result["failedCheckCount"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
