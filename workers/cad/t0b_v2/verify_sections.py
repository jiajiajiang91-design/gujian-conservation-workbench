from __future__ import annotations

import argparse
from collections import defaultdict
import gzip
from hashlib import sha256
import itertools
import json
import math
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import LineString, Polygon, box
from shapely.ops import polygonize_full, unary_union
import trimesh


VERIFIER_VERSION = "2.0.0"
LINE_NAMESPACE = UUID("f2557e7f-8aec-56df-80de-57873fb48c7e")
REGION_NAMESPACE = UUID("2db3c952-3453-5d69-9efe-e7fda07997d8")
REQUIRED_RELATION_TYPES = {
    "floorPlan": {"column", "doorFrame", "latticeWindow", "wall", "terrace", "step", "groundLayer"},
    "transverseSection": {
        "panTile",
        "roofBoard",
        "rafter",
        "purlin",
        "bearingBlock",
        "bracketArm",
        "column",
        "columnBase",
        "foundation",
        "groundLayer",
        "terrace",
    },
    "longitudinalSection": {
        "ridgeTile",
        "roofBoard",
        "rafter",
        "purlin",
        "tieBeam",
        "interiorPost",
        "column",
        "eaveBeam",
        "wall",
        "doorFrame",
        "terrace",
        "foundation",
    },
}


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_sources(path: Path) -> tuple[dict, dict[str, trimesh.Trimesh]]:
    meshes: dict[str, trimesh.Trimesh] = {}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        try:
            header = json.loads(next(stream))
        except StopIteration as error:
            raise ValueError("source mesh bundle is empty") from error
        for line_number, line in enumerate(stream, start=2):
            record = json.loads(line)
            entity_id = record.get("entityId")
            if record.get("recordType") != "mesh" or not isinstance(entity_id, str) or entity_id in meshes:
                raise ValueError(f"invalid source mesh record at line {line_number}")
            meshes[entity_id] = trimesh.Trimesh(
                vertices=np.asarray(record["vertices"], dtype=float),
                faces=np.asarray(record["faces"], dtype=int),
                process=False,
            )
    return header, meshes


def _canonical_mesh_hash(mesh: trimesh.Trimesh, precision: int = 3) -> str:
    vertices = np.round(np.asarray(mesh.vertices, dtype=float), precision)
    vertex_records = sorted(tuple(float(value) for value in vertex) for vertex in vertices)
    triangle_records = [sorted(tuple(float(value) for value in vertices[index]) for index in face) for face in np.asarray(mesh.faces, dtype=int)]
    payload = {"vertices": vertex_records, "triangles": sorted(triangle_records)}
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _verify_source_closure(fixture: dict, manifest: dict, header: dict, meshes: dict[str, trimesh.Trimesh]) -> None:
    expected_header = {
        "recordType": "header",
        "schemaVersion": "t0b-v2-source-meshes-1",
        "unit": fixture["unit"],
        "coordinateSystem": fixture["coordinateSystem"],
        "geometryRevisionId": fixture["geometryRevisionId"],
    }
    if header != expected_header:
        raise ValueError("source mesh header differs from the fixture")
    expected_manifest_identity = {
        "schemaVersion": "t0b-v2-geometry-1",
        "projectId": fixture["projectId"],
        "fixtureId": fixture["fixtureId"],
        "geometryRevisionId": fixture["geometryRevisionId"],
        "unit": fixture["unit"],
        "producerType": fixture["producerType"],
        "sourceRefs": fixture["sourceRefs"],
    }
    if any(manifest.get(key) != value for key, value in expected_manifest_identity.items()):
        raise ValueError("manifest identity differs from the fixture")
    entities = manifest.get("entities", [])
    entity_ids = [entity.get("entityId") for entity in entities]
    if len(entity_ids) != len(set(entity_ids)) or set(entity_ids) != set(meshes):
        raise ValueError("manifest and source mesh entity closures differ")
    for entity in entities:
        mesh = meshes[entity["entityId"]]
        if _canonical_mesh_hash(mesh) != entity.get("meshHash"):
            raise ValueError(f"source mesh hash differs for {entity['entityId']}")
        if len(mesh.vertices) != int(entity.get("vertices", -1)) or len(mesh.faces) != int(entity.get("faces", -1)):
            raise ValueError(f"source mesh topology differs for {entity['entityId']}")
    closure_payload = sorted((entity["entityId"], entity.get("exportMeshHash")) for entity in entities)
    closure_hash = sha256(json.dumps(closure_payload, separators=(",", ":")).encode("utf-8")).hexdigest()
    if closure_hash != manifest.get("exportClosureHash"):
        raise ValueError("manifest export closure hash is invalid")
    signature_entities = []
    for entity in sorted(entities, key=lambda item: item["entityId"]):
        record = dict(entity)
        record.pop("exportMeshHash", None)
        signature_entities.append(record)
    signature_relations = sorted(
        manifest.get("relations", []),
        key=lambda item: (item.get("fromEntityId"), item.get("relation"), item.get("toEntityId")),
    )
    geometry_signature = sha256(
        json.dumps(
            {"entities": signature_entities, "relations": signature_relations},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    if geometry_signature != manifest.get("geometrySignature") or geometry_signature != fixture["knownAnswers"]["geometrySignature"]:
        raise ValueError("manifest semantic geometry signature is invalid")


def _load_output(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _record(checks: list[dict], name: str, actual, expected) -> None:
    checks.append({"name": name, "passed": actual == expected, "actual": actual, "expected": expected})


def _stable_hash(value) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _line_id(view_contract_revision_id: str, view_id: str, source_id: str, derivation: str, line_class: str, points: list[list[float]]) -> str:
    payload = json.dumps([view_contract_revision_id, view_id, source_id, derivation, line_class, points], separators=(",", ":"))
    return str(uuid5(LINE_NAMESPACE, payload))


def _region_id(view_contract_revision_id: str, view_id: str, source_id: str, outer: list[list[float]], holes: list[list[list[float]]]) -> str:
    payload = json.dumps([view_contract_revision_id, view_id, source_id, outer, holes], separators=(",", ":"))
    return str(uuid5(REGION_NAMESPACE, payload))


def _verify_cut_region_closure(output: dict) -> bool:
    cut_lines = output.get("cutLines", [])
    cut_regions = output.get("cutRegions", [])
    lines_by_id = {line.get("lineId"): line for line in cut_lines}
    if None in lines_by_id or len(lines_by_id) != len(cut_lines):
        return False
    region_ids = {region.get("regionId") for region in cut_regions}
    if None in region_ids or len(region_ids) != len(cut_regions):
        return False
    referenced: list[str] = []
    for region in cut_regions:
        boundary_ids = [region.get("outerBoundaryLineId"), *region.get("holeBoundaryLineIds", [])]
        if any(boundary_id not in lines_by_id for boundary_id in boundary_ids):
            return False
        boundaries = [lines_by_id[boundary_id] for boundary_id in boundary_ids]
        if boundaries[0].get("boundaryRole") != "outer" or any(line.get("boundaryRole") != "hole" for line in boundaries[1:]):
            return False
        if any(
            line.get("sourceEntityId") != region.get("sourceEntityId")
            or line.get("sourceComponentType") != region.get("sourceComponentType")
            for line in boundaries
        ):
            return False
        outer = boundaries[0]["pointsMm"]
        holes = [line["pointsMm"] for line in boundaries[1:]]
        expected_region_id = _region_id(
            output["viewContractRevisionId"],
            output["viewId"],
            region["sourceEntityId"],
            outer,
            holes,
        )
        if region.get("regionId") != expected_region_id:
            return False
        referenced.extend(boundary_ids)
    return len(referenced) == len(cut_lines) and set(referenced) == set(lines_by_id)


def _canonical_ring(points: list[list[float]]) -> tuple[tuple[float, float], ...]:
    rounded = []
    for point in points:
        x = round(float(point[0]), 3)
        y = round(float(point[1]), 3)
        rounded.append((0.0 if x == 0 else x, 0.0 if y == 0 else y))
    if len(rounded) > 1 and rounded[0] == rounded[-1]:
        rounded.pop()
    if not rounded:
        return tuple()
    candidates: list[tuple[tuple[float, float], ...]] = []
    for sequence in (rounded, list(reversed(rounded))):
        minimum = min(sequence)
        for index, point in enumerate(sequence):
            if point == minimum:
                rotated = sequence[index:] + sequence[:index]
                candidates.append(tuple(rotated + [rotated[0]]))
    return min(candidates)


def _line_parts(geometry) -> list[LineString]:
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [item for item in geometry.geoms if item.geom_type == "LineString" and item.length >= 0.001]
    return []


def _independent_cut_rings(view: dict, meshes: dict[str, trimesh.Trimesh]) -> set[tuple[str, tuple[tuple[float, float], ...]]]:
    section = view["section"]
    origin = np.asarray(section["planeOrigin"], dtype=float)
    normal = np.asarray(section["planeNormal"], dtype=float)
    right = np.asarray(view["viewFrame"]["right"], dtype=float)
    up = np.asarray(view["viewFrame"]["up"], dtype=float)
    clip = box(*view["viewFrame"]["clipRectMm"])
    result: set[tuple[str, tuple[tuple[float, float], ...]]] = set()
    for entity_id, mesh in meshes.items():
        segments = trimesh.intersections.mesh_plane(mesh, normal, origin)
        lines: list[LineString] = []
        for segment in segments:
            start = [round(float((segment[0] - origin) @ right), 3), round(float((segment[0] - origin) @ up), 3)]
            end = [round(float((segment[1] - origin) @ right), 3), round(float((segment[1] - origin) @ up), 3)]
            if start == end:
                continue
            for part in _line_parts(LineString([start, end]).intersection(clip)):
                coordinates = [[round(float(value), 3) for value in point] for point in part.coords]
                if coordinates[0] != coordinates[-1]:
                    lines.append(LineString(coordinates))
        if not lines:
            continue
        polygons, cuts, dangles, invalid = polygonize_full(unary_union(lines))
        if len(cuts.geoms) + len(dangles.geoms) + len(invalid.geoms):
            raise ValueError(f"independent cut contains open topology for {entity_id}")
        for polygon in polygons.geoms:
            result.add((entity_id, _canonical_ring([list(point) for point in polygon.exterior.coords])))
            for interior in polygon.interiors:
                result.add((entity_id, _canonical_ring([list(point) for point in interior.coords])))
    return result


def _selection(view: dict, manifest: dict) -> list[str]:
    frame = view["viewFrame"]
    origin = np.asarray(frame["origin"], dtype=float)
    axes = [np.asarray(frame[name], dtype=float) for name in ("right", "up", "depth")]
    low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], frame["clipDepthMm"][0]], dtype=float)
    high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], frame["clipDepthMm"][1]], dtype=float)
    result: list[str] = []
    for entity in manifest["entities"]:
        bounds = np.asarray(entity["bounds"], dtype=float)
        corners = np.asarray(list(itertools.product(*[(bounds[0, index], bounds[1, index]) for index in range(3)])))
        coordinates = np.column_stack(tuple((corners - origin) @ axis for axis in axes))
        if np.any(coordinates.max(axis=0) < low) or np.any(coordinates.min(axis=0) > high):
            continue
        result.append(entity["entityId"])
    return result


def _clip_depth(vertices: list[np.ndarray], boundary: float, greater: bool) -> list[np.ndarray]:
    result: list[np.ndarray] = []
    previous = vertices[-1]
    previous_inside = previous[2] >= boundary if greater else previous[2] <= boundary
    for current in vertices:
        current_inside = current[2] >= boundary if greater else current[2] <= boundary
        if current_inside != previous_inside:
            ratio = (boundary - previous[2]) / (current[2] - previous[2])
            result.append(previous + (current - previous) * ratio)
        if current_inside:
            result.append(current)
        previous = current
        previous_inside = current_inside
    return result


class VisibilityOracle:
    def __init__(self, view: dict, selected: list[str], meshes: dict[str, trimesh.Trimesh]) -> None:
        frame = view["viewFrame"]
        self.clip = frame["clipRectMm"]
        self.cell = 120.0
        origin = np.asarray(frame["origin"], dtype=float)
        right = np.asarray(frame["right"], dtype=float)
        up = np.asarray(frame["up"], dtype=float)
        depth = np.asarray(frame["depth"], dtype=float)
        minimum_depth, maximum_depth = map(float, frame["clipDepthMm"])
        self.triangles: list[np.ndarray] = []
        self.cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        for entity_id in selected:
            mesh = meshes[entity_id]
            vertices = np.column_stack(((mesh.vertices - origin) @ right, (mesh.vertices - origin) @ up, (mesh.vertices - origin) @ depth))
            for face in mesh.faces:
                polygon = _clip_depth([vertices[index].copy() for index in face], minimum_depth, True)
                if len(polygon) < 3:
                    continue
                polygon = _clip_depth(polygon, maximum_depth, False)
                for index in range(1, len(polygon) - 1):
                    self._add(np.asarray([polygon[0], polygon[index], polygon[index + 1]], dtype=float))

    def _key(self, point: np.ndarray) -> tuple[int, int]:
        return (
            math.floor((point[0] - self.clip[0]) / self.cell),
            math.floor((point[1] - self.clip[1]) / self.cell),
        )

    def _add(self, triangle: np.ndarray) -> None:
        minimum = np.maximum(triangle[:, :2].min(axis=0), np.asarray(self.clip[:2]))
        maximum = np.minimum(triangle[:, :2].max(axis=0), np.asarray(self.clip[2:]))
        if np.any(minimum > maximum):
            return
        index = len(self.triangles)
        self.triangles.append(triangle)
        first = self._key(minimum)
        last = self._key(maximum)
        for x_index in range(first[0], last[0] + 1):
            for y_index in range(first[1], last[1] + 1):
                self.cells[(x_index, y_index)].append(index)

    @staticmethod
    def _depth(triangle: np.ndarray, point: np.ndarray) -> float | None:
        first, second, third = triangle
        a = second[:2] - first[:2]
        b = third[:2] - first[:2]
        offset = point - first[:2]
        denominator = a[0] * b[1] - a[1] * b[0]
        if abs(denominator) <= 1e-9:
            return None
        u = (offset[0] * b[1] - offset[1] * b[0]) / denominator
        v = (a[0] * offset[1] - a[1] * offset[0]) / denominator
        if u < -1e-7 or v < -1e-7 or u + v > 1.0000001:
            return None
        return float(first[2] + u * (second[2] - first[2]) + v * (third[2] - first[2]))

    def visible(self, point: np.ndarray, tolerance: float = 0.501) -> bool:
        nearest: float | None = None
        for triangle_index in self.cells.get(self._key(point[:2]), []):
            depth = self._depth(self.triangles[triangle_index], point[:2])
            if depth is not None and (nearest is None or depth < nearest):
                nearest = depth
        return nearest is None or point[2] <= nearest + tolerance

    def _segment_candidates(self, start: np.ndarray, end: np.ndarray) -> list[np.ndarray]:
        minimum = np.maximum(np.minimum(start[:2], end[:2]), np.asarray(self.clip[:2], dtype=float))
        maximum = np.minimum(np.maximum(start[:2], end[:2]), np.asarray(self.clip[2:], dtype=float))
        if np.any(minimum > maximum):
            return []
        first = self._key(minimum)
        last = self._key(maximum)
        indices: set[int] = set()
        for x_index in range(first[0], last[0] + 1):
            for y_index in range(first[1], last[1] + 1):
                indices.update(self.cells.get((x_index, y_index), []))
        return [self.triangles[index] for index in sorted(indices)]

    def segment_fully_visible(self, start: np.ndarray, end: np.ndarray, tolerance: float = 0.501) -> bool:
        direction = end - start
        denominator = float(direction[:2] @ direction[:2])
        if denominator <= 1e-12:
            return True
        projected_line = LineString([start[:2], end[:2]])
        for triangle in self._segment_candidates(start, end):
            polygon = Polygon(triangle[:, :2])
            if polygon.area <= 1e-9:
                continue
            intersection = projected_line.intersection(polygon)
            for part in _line_parts(intersection):
                if part.length <= 0.01:
                    continue
                coordinates = list(part.coords)
                if len(coordinates) < 2:
                    continue
                parameters = sorted(
                    max(0.0, min(1.0, float((np.asarray(point, dtype=float) - start[:2]) @ direction[:2] / denominator)))
                    for point in (coordinates[0], coordinates[-1])
                )
                lower, upper = parameters
                if upper - lower <= 1e-9:
                    continue
                inset = min(1e-7, (upper - lower) / 4)
                for parameter in (lower + inset, upper - inset):
                    point = start + direction * parameter
                    triangle_depth = self._depth(triangle, point[:2])
                    if triangle_depth is not None and point[2] > triangle_depth + tolerance:
                        return False
        return True


def _candidate_edges(mesh: trimesh.Trimesh, frame: dict, feature_angle_deg: float) -> list[tuple[np.ndarray, np.ndarray, str]]:
    origin = np.asarray(frame["origin"], dtype=float)
    right = np.asarray(frame["right"], dtype=float)
    up = np.asarray(frame["up"], dtype=float)
    depth = np.asarray(frame["depth"], dtype=float)
    vertices = np.column_stack(((mesh.vertices - origin) @ right, (mesh.vertices - origin) @ up, (mesh.vertices - origin) @ depth))
    normals = np.asarray(mesh.face_normals, dtype=float)
    threshold = math.radians(feature_angle_deg)
    result: list[tuple[np.ndarray, np.ndarray, str]] = []
    for index, edge in enumerate(mesh.face_adjacency_edges):
        first_face, second_face = mesh.face_adjacency[index]
        first_dot = float(normals[first_face] @ depth)
        second_dot = float(normals[second_face] @ depth)
        silhouette = first_dot * second_dot <= 1e-10 and abs(first_dot - second_dot) > 1e-8
        feature = float(mesh.face_adjacency_angles[index]) >= threshold
        if silhouette or feature:
            result.append((vertices[edge[0]], vertices[edge[1]], "silhouette" if silhouette else "feature"))
    return result


def _point_segment_distance(point: np.ndarray, start: np.ndarray, end: np.ndarray) -> float:
    direction = end - start
    denominator = float(direction @ direction)
    if denominator <= 1e-12:
        return float(np.linalg.norm(point - start))
    ratio = max(0.0, min(1.0, float((point - start) @ direction) / denominator))
    return float(np.linalg.norm(point - (start + direction * ratio)))


def _projection_line_valid(line: dict, candidates: list[tuple[np.ndarray, np.ndarray, str]]) -> bool:
    points = [np.asarray(point, dtype=float) for point in line["sourcePointsViewMm"]]
    return any(
        line["lineClass"] == line_class
        and _point_segment_distance(points[0], start, end) <= 0.75
        and _point_segment_distance(points[1], start, end) <= 0.75
        for start, end, line_class in candidates
    )


def verify_sections(fixture_path: Path, manifest_path: Path, source_meshes_path: Path, sections_dir: Path) -> dict:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if _file_hash(source_meshes_path) != fixture["knownAnswers"]["sourceMeshBundleSha256"]:
        raise ValueError("source mesh bundle differs from the frozen oriented topology hash")
    source_header, meshes = _load_sources(source_meshes_path)
    _verify_source_closure(fixture, manifest, source_header, meshes)
    metadata = {item["entityId"]: item for item in manifest["entities"]}
    contract_views = {item["id"]: item for item in fixture["views"]}
    checks: list[dict] = []
    _record(checks, "source schema", source_header.get("schemaVersion"), "t0b-v2-source-meshes-1")
    _record(checks, "source mesh closure", len(meshes), len(manifest["entities"]))
    output_records: list[dict] = []

    for view_id in ("floorPlan", "transverseSection", "longitudinalSection"):
        path = sections_dir / f"{view_id}.view-geometry.json.gz"
        output = _load_output(path)
        output_records.append({"viewId": view_id, "path": path.name, "sha256": _file_hash(path)})
        view = contract_views[view_id]
        _record(checks, f"{view_id} geometry revision", output.get("geometryRevisionId"), fixture["geometryRevisionId"])
        _record(checks, f"{view_id} view contract revision", output.get("viewContractRevisionId"), fixture["viewContractRevisionId"])
        _record(checks, f"{view_id} qualification", output.get("qualification"), "not-drawing-output")
        _record(
            checks,
            f"{view_id} top level contract",
            {
                "schemaVersion": output.get("schemaVersion"),
                "status": output.get("status"),
                "qualification": output.get("qualification"),
                "viewId": output.get("viewId"),
                "unit": output.get("unit"),
                "viewFrame": output.get("viewFrame"),
                "section": output.get("section"),
            },
            {
                "schemaVersion": "t0b-v2-view-geometry-1",
                "status": "generated-not-qualified",
                "qualification": "not-drawing-output",
                "viewId": view_id,
                "unit": "mm",
                "viewFrame": view["viewFrame"],
                "section": view["section"],
            },
        )
        hash_payload = dict(output)
        stored_view_hash = hash_payload.pop("viewGeometrySha256", None)
        canonical_output = json.dumps(hash_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        _record(checks, f"{view_id} view geometry hash", stored_view_hash, sha256(canonical_output.encode("utf-8")).hexdigest())

        structural_lines = [*output.get("cutLines", []), *output.get("projectionLines", [])]
        line_ids = [line.get("lineId") for line in structural_lines]
        valid_line_records = 0
        for line in structural_lines:
            expected_derivation = "planeIntersection.cut" if line in output.get("cutLines", []) else "planeIntersection.depthProjection"
            expected_id = _line_id(
                output["viewContractRevisionId"],
                view_id,
                line.get("sourceEntityId", ""),
                expected_derivation,
                line.get("lineClass", ""),
                line.get("pointsMm", []),
            )
            if (
                line.get("lineId") == expected_id
                and line.get("viewId") == view_id
                and line.get("geometryRevisionId") == fixture["geometryRevisionId"]
                and line.get("viewContractRevisionId") == fixture["viewContractRevisionId"]
                and line.get("derivation") == expected_derivation
                and line.get("derivationTransform") == view["viewFrame"]["modelToView"]
                and line.get("visibility") == "visible"
            ):
                valid_line_records += 1
        _record(checks, f"{view_id} unique structural line ids", len(set(line_ids)), len(line_ids))
        _record(checks, f"{view_id} structural line records", valid_line_records, len(structural_lines))
        coordinate_bindings = sum(
            1
            for line in output.get("projectionLines", [])
            if line.get("pointsMm") == [point[:2] for point in line.get("sourcePointsViewMm", [])]
        )
        _record(checks, f"{view_id} projection 2d 3d binding", coordinate_bindings, len(output.get("projectionLines", [])))
        _record(checks, f"{view_id} cut region boundary closure", _verify_cut_region_closure(output), True)
        _record(checks, f"{view_id} cut line statistic", output["statistics"].get("cutLineCount"), len(output.get("cutLines", [])))
        _record(checks, f"{view_id} cut region statistic", output["statistics"].get("cutRegionCount"), len(output.get("cutRegions", [])))
        valid_cut_lines = sum(
            1
            for line in output.get("cutLines", [])
            if line.get("lineClass") == "cut"
            and line.get("closed") is True
            and line.get("boundaryRole") in {"outer", "hole"}
            and line.get("sourceEntityId") in metadata
            and line.get("sourceComponentType") == metadata[line["sourceEntityId"]]["componentType"]
        )
        _record(checks, f"{view_id} cut line semantics", valid_cut_lines, len(output.get("cutLines", [])))
        hatch_by_material = {"stone-demo": "stone", "timber-demo": "timber", "earth-demo": "earth"}
        valid_cut_regions = sum(
            1
            for region in output.get("cutRegions", [])
            if region.get("sourceEntityId") in metadata
            and region.get("sourceComponentType") == metadata[region["sourceEntityId"]]["componentType"]
            and region.get("materialId") == metadata[region["sourceEntityId"]]["materialId"]
            and region.get("materialCode") == metadata[region["sourceEntityId"]]["materialCode"]
            and region.get("materialHatch") == hatch_by_material.get(metadata[region["sourceEntityId"]]["materialCode"])
        )
        _record(checks, f"{view_id} cut region material semantics", valid_cut_regions, len(output.get("cutRegions", [])))

        expected_rings = _independent_cut_rings(view, meshes)
        actual_rings = {
            (line["sourceEntityId"], _canonical_ring(line["pointsMm"]))
            for line in output["cutLines"]
        }
        _record(checks, f"{view_id} independent cut boundary hash", _stable_hash(sorted(actual_rings)), _stable_hash(sorted(expected_rings)))
        _record(checks, f"{view_id} cut topology count", output["statistics"]["cutRegionCount"], len(expected_rings))
        expected_cut_entities = sorted({entity_id for entity_id, _ring in expected_rings})
        expected_entity_hash = sha256("\n".join(expected_cut_entities).encode("utf-8")).hexdigest()
        _record(checks, f"{view_id} independent cut entity set", output["statistics"]["cutEntitySetSha256"], expected_entity_hash)
        type_counts: dict[str, int] = defaultdict(int)
        for entity_id, _ring in expected_rings:
            type_counts[metadata[entity_id]["componentType"]] += 1
        expected_type_counts = dict(sorted(type_counts.items()))
        _record(checks, f"{view_id} independent cut regions by type", output["statistics"]["cutRegionCountByType"], expected_type_counts)
        frozen_oracle = fixture["knownAnswers"]["viewOracle"]["views"][view_id]
        _record(checks, f"{view_id} frozen cut entity set", expected_entity_hash, frozen_oracle["cutEntitySetSha256"])
        _record(checks, f"{view_id} frozen cut regions by type", expected_type_counts, frozen_oracle["cutClosedRegionsByType"])

        allowed_projection_types = set(view["section"]["depthProjectionTypes"])
        actual_projection_types = {line["sourceComponentType"] for line in output["projectionLines"]}
        _record(checks, f"{view_id} projection type boundary", actual_projection_types <= allowed_projection_types, True)
        all_types = {line["sourceComponentType"] for line in [*output["cutLines"], *output["projectionLines"]]}
        _record(checks, f"{view_id} required relationship types", REQUIRED_RELATION_TYPES[view_id] <= all_types, True)

        selected = _selection(view, manifest)
        visibility = VisibilityOracle(view, selected, meshes)
        visibility_tolerance = float(fixture["drawingRequirements"]["projectionPolicy"]["visibilityProbeToleranceMm"]) + 0.001
        candidate_cache: dict[str, list[tuple[np.ndarray, np.ndarray, str]]] = {}
        valid_sources = 0
        valid_edges = 0
        fully_visible_lines = 0
        for line in output["projectionLines"]:
            entity_id = line["sourceEntityId"]
            entity = metadata.get(entity_id)
            if entity is not None and entity["componentType"] == line["sourceComponentType"]:
                valid_sources += 1
            if entity_id not in candidate_cache and entity_id in meshes:
                candidate_cache[entity_id] = _candidate_edges(
                    meshes[entity_id],
                    view["viewFrame"],
                    float(fixture["drawingRequirements"]["projectionPolicy"]["featureAngleDeg"]),
                )
            if entity_id in candidate_cache and _projection_line_valid(line, candidate_cache[entity_id]):
                valid_edges += 1
            points = [np.asarray(point, dtype=float) for point in line["sourcePointsViewMm"]]
            if visibility.segment_fully_visible(points[0], points[1], visibility_tolerance):
                fully_visible_lines += 1
        line_count = len(output["projectionLines"])
        _record(checks, f"{view_id} projection source coverage", valid_sources, line_count)
        _record(checks, f"{view_id} source edge coverage", valid_edges, line_count)
        _record(checks, f"{view_id} independent exact occlusion", fully_visible_lines, line_count)

    status = "passed-section-geometry-only" if all(item["passed"] for item in checks) else "failed"
    return {
        "schemaVersion": "t0b-v2-section-verification-1",
        "status": status,
        "qualification": "not-drawing-output",
        "verifier": {"version": VERIFIER_VERSION, "source": Path(__file__).name, "sha256": _file_hash(Path(__file__).resolve())},
        "inputs": {
            "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
            "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            "sectionOutputs": output_records,
        },
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify T0-B v2 section ViewGeometry.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--sections-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify_sections(args.fixture, args.manifest, args.source_meshes, args.sections_dir)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0 if report["status"] == "passed-section-geometry-only" else 1


if __name__ == "__main__":
    raise SystemExit(main())
