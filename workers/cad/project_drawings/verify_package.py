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
import numpy as np
import trimesh
from PIL import Image
from fontTools.ttLib import TTFont
from pypdf import PdfReader
from shapely.geometry import LineString
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


def _independently_visible(segment: np.ndarray, segment_depth: np.ndarray, triangles: list[tuple[np.ndarray, np.ndarray]]) -> bool:
    for fraction in (0.12, 0.28, 0.5, 0.72, 0.88):
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
        if nearest < depth - 0.5:
            return False
    return True


def _independent_view_line_sets(matrix: dict[str, Any], manifest: dict[str, Any], geometry_dir: Path) -> dict[str, set[tuple[str, tuple[float, float], tuple[float, float]]]]:
    component_type = {item["id"]: item["componentType"] for item in manifest["entities"]}
    meshes = _load_geometry_meshes(geometry_dir, manifest)
    output: dict[str, set[tuple[str, tuple[float, float], tuple[float, float]]]] = {}
    for view in matrix["views"]:
        direction = np.asarray(view["direction"], dtype=float)
        right = np.asarray(view["right"], dtype=float)
        up = np.asarray(view["up"], dtype=float)
        selected = {
            entity_id: value
            for entity_id, value in meshes.items()
            if not view.get("sourceTypes") or component_type[entity_id] in view["sourceTypes"]
        }
        expected: set[tuple[str, tuple[float, float], tuple[float, float]]] = set()
        if view.get("sectionPlane"):
            plane = view["sectionPlane"]
            normal = np.asarray(plane["normal"], dtype=float)
            origin = normal * float(plane["offsetMm"])
            for entity_id, (vertices, faces) in selected.items():
                mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
                for segment in trimesh.intersections.mesh_plane(mesh, plane_normal=normal, plane_origin=origin):
                    projected = np.column_stack((segment @ right, segment @ up))
                    expected.add(_segment_key(entity_id, projected))
        else:
            projected_triangles: list[tuple[np.ndarray, np.ndarray]] = []
            for vertices, faces in selected.values():
                for triangle in vertices[faces]:
                    projected_triangles.append((np.column_stack((triangle @ right, triangle @ up)), triangle @ direction))
            for entity_id, (vertices, faces) in selected.items():
                for start, end in _independent_candidate_edges(vertices, faces, direction):
                    segment_3d = np.vstack((start, end))
                    segment_2d = np.column_stack((segment_3d @ right, segment_3d @ up))
                    if np.linalg.norm(segment_2d[1] - segment_2d[0]) < 0.05:
                        continue
                    if _independently_visible(segment_2d, segment_3d @ direction, projected_triangles):
                        expected.add(_segment_key(entity_id, segment_2d))
        output[view["id"]] = expected
    return output


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
        source_path = output_dir / "view-geometry" / f"{view['drawingRef']}.json.gz"
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
    model_types = {entity.dxftype() for entity in doc.modelspace()}
    layout_names = [name for name in doc.layouts.names() if name != "Model"]
    expected_layouts = [sheet["drawingNumber"] for sheet in matrix["sheets"]]
    user_viewports = [entity for name in layout_names for entity in doc.layouts.get(name).query("VIEWPORT") if entity.dxf.id > 1]
    _check(not audit.errors and doc.header["$INSUNITS"] == 4 and doc.dxfversion == "AC1032", "native-dxf-baseline", "DXF 为 R2018、毫米、ezdxf 审计零错误", checks)
    _check({"LINE", "HATCH", "DIMENSION", "MTEXT", "INSERT"}.issubset(model_types), "native-dxf-types", "原生结构线、填充、尺寸、文字和块均存在", checks)
    _check(layout_names == expected_layouts and len(user_viewports) == len(matrix["views"]) and all(item.dxf.flags & 0x4000 for item in user_viewports), "native-layouts", "动态图纸布局和全部锁定视口与任务矩阵一致", checks)
    _check("GJ-CONDITION" in doc.layers and len(doc.modelspace().query('*[layer=="GJ-CONDITION"]')) > 0, "condition-layer", "演示现状候选图层非空", checks)

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
    dimension_texts = [f"总宽 {view['boundsMm'][1][0] - view['boundsMm'][0][0]:.0f} mm" for view in ir["views"]]
    _check(cross_format_text and all(value in svg_text and value in pdf_text for value in dimension_texts), "cross-format-text", "图名、图号、资格状态和同源尺寸跨格式一致", checks)

    font_manifest = json.loads((font_path.parent / "font-manifest.json").read_text(encoding="utf-8"))
    bound_font_ok = _hash(font_path) == font_manifest["sha256"] and font_manifest["instance"]["usWeightClass"] == 400
    _check(bound_font_ok, "font-license-closure", "派生字体、字重和官方许可清单闭合", checks)

    autocad_summary_hash = None
    if autocad_summary_path is not None:
        autocad_summary = json.loads(autocad_summary_path.read_text(encoding="utf-8"))
        dxf_hash = _hash(output_dir / "drawings.dxf")
        autocad_ok = (
            autocad_summary["status"] == "passed-native-dxf-audit"
            and autocad_summary["sourceDxfSha256"] == dxf_hash
            and autocad_summary["temporaryCopyPreAuditSha256"] == dxf_hash
            and autocad_summary["temporaryCopyPostAuditSha256"] == dxf_hash
            and autocad_summary["exitCode"] == 0
            and autocad_summary["errorsFound"] == 0
            and autocad_summary["objectsRepaired"] == 0
            and autocad_summary["objectsDeleted"] == 0
            and autocad_summary["boundFontSubstituted"] is False
            and autocad_summary["l1Eligible"] is False
        )
        _check(autocad_ok, "autocad-native-audit", "AutoCAD 2024 对隔离副本审计零错误、零修复、零删除、项目字体未替换", checks)
        autocad_summary_hash = _hash(autocad_summary_path)

    qcad_summary_hash = None
    if qcad_summary_path is not None:
        qcad_summary = json.loads(qcad_summary_path.read_text(encoding="utf-8"))
        dxf_hash = _hash(output_dir / "drawings.dxf")
        qcad_ok = (
            qcad_summary["status"] == "passed-open-view-print-only"
            and qcad_summary["sourceDxfSha256"] == dxf_hash
            and qcad_summary["sourceDxfPostCheckSha256"] == dxf_hash
            and qcad_summary["openExitCode"] == 0
            and qcad_summary["printExitCode"] == 0
            and qcad_summary["printedLayoutNames"] == [sheet["drawingNumber"] for sheet in matrix["sheets"]]
            and qcad_summary["printedPageCount"] == len(matrix["sheets"])
            and qcad_summary["normativeDxfOverwritten"] is False
            and qcad_summary["saveRoundtripAttempted"] is False
            and qcad_summary["l1Eligible"] is False
        )
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
