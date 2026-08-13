from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh
from shapely.geometry import LineString
from shapely.ops import polygonize

from .contracts import canonical_bytes, sha256_value


LINE_NAMESPACE = uuid.UUID("a63b0356-5f49-5f60-a192-9aa374ec3246")


@dataclass(frozen=True)
class SourceMesh:
    entity_id: str
    component_type: str
    vertices: np.ndarray
    faces: np.ndarray


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
        result.append(SourceMesh(entity_id, component_by_id[entity_id], vertices, np.asarray(mesh.faces, dtype=np.int64)))
    return result


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


def _visible(segment: np.ndarray, segment_depth: np.ndarray, projected_triangles: list[tuple[np.ndarray, np.ndarray]], tolerance_mm: float) -> bool:
    for fraction in (0.12, 0.28, 0.5, 0.72, 0.88):
        point = segment[0] * (1 - fraction) + segment[1] * fraction
        depth = float(segment_depth[0] * (1 - fraction) + segment_depth[1] * fraction)
        nearest = math.inf
        for triangle, depths in projected_triangles:
            if point[0] < triangle[:, 0].min() - 1e-7 or point[0] > triangle[:, 0].max() + 1e-7 or point[1] < triangle[:, 1].min() - 1e-7 or point[1] > triangle[:, 1].max() + 1e-7:
                continue
            candidate = _triangle_depth(point, triangle, depths)
            if candidate is not None:
                nearest = min(nearest, candidate)
        if nearest < depth - tolerance_mm:
            return False
    return True


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
    selected = [mesh for mesh in meshes if not view.get("sourceTypes") or mesh.component_type in view["sourceTypes"]]
    projected_triangles: list[tuple[np.ndarray, np.ndarray]] = []
    for mesh in selected:
        triangles = mesh.vertices[mesh.faces]
        for triangle in triangles:
            projected, depths = _project(triangle, right, up, direction)
            projected_triangles.append((projected, depths))
    lines: list[dict[str, Any]] = []
    material_regions: list[dict[str, Any]] = []
    if view.get("sectionPlane"):
        plane = view["sectionPlane"]
        normal = np.asarray(plane["normal"], dtype=float)
        origin = normal * float(plane["offsetMm"])
        for mesh in selected:
            source = trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False)
            segments = trimesh.intersections.mesh_plane(source, plane_normal=normal, plane_origin=origin)
            projected_segments: list[np.ndarray] = []
            for index, segment in enumerate(segments):
                projected, _ = _project(segment, right, up, direction)
                projected_segments.append(projected)
                lines.append(_line_record(view, manifest, mesh, projected, "cut", "planeIntersection", index))
            for region_index, polygon in enumerate(polygonize([LineString(segment) for segment in projected_segments])):
                coordinates = [[round(float(x), 6), round(float(y), 6)] for x, y in list(polygon.exterior.coords)]
                if len(coordinates) >= 4 and polygon.area > 0.01:
                    material_regions.append({
                        "regionId": str(uuid.uuid5(LINE_NAMESPACE, f"{manifest['geometryRevisionId']}:{view['id']}:{mesh.entity_id}:region:{region_index}:{coordinates}")),
                        "viewId": view["id"], "geometryRevisionId": manifest["geometryRevisionId"],
                        "sourceEntityId": mesh.entity_id, "sourceComponentType": mesh.component_type,
                        "materialCode": next(item["materialCode"] for item in manifest["entities"] if item["id"] == mesh.entity_id),
                        "derivation": "planeIntersection", "boundaryMm": coordinates,
                    })
    else:
        line_index = 0
        for mesh in selected:
            for start, end, line_class in _candidate_edges(mesh, direction):
                projected, depths = _project(np.vstack((start, end)), right, up, direction)
                if np.linalg.norm(projected[1] - projected[0]) < 0.05:
                    continue
                if not _visible(projected, depths, projected_triangles, 0.5):
                    continue
                lines.append(_line_record(view, manifest, mesh, projected, line_class, "occlusionProjection", line_index))
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
