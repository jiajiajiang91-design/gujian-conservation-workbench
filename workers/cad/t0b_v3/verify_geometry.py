from __future__ import annotations

import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
import math
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
import trimesh
from shapely.geometry import Polygon
from shapely.ops import unary_union


GEOMETRY_REVISION_NAMESPACE = UUID("450b6735-9609-4a80-a8c4-76f7210be2ef")
DIMENSION_NAMESPACE = UUID("8ec581f4-ddc4-48fc-b8ad-8f604f1b5200")
PARAMETER_NAMESPACE = UUID("3af0d813-77f9-4b98-b3dc-2df17f09cde7")


class VerificationError(ValueError):
    pass


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_id(namespace: UUID, *parts: object) -> str:
    return str(uuid5(namespace, "|".join(_canonical(part) for part in parts)))


def _canonical_triangle(points: np.ndarray) -> tuple:
    triangle = tuple(tuple(round(float(value), 3) for value in point) for point in points)
    rotations = (triangle, triangle[1:] + triangle[:1], triangle[2:] + triangle[:2])
    return min(rotations)


def _mesh_hash(mesh: trimesh.Trimesh) -> str:
    vertices = np.asarray(mesh.vertices, dtype=float)
    vertex_records = sorted(tuple(round(float(value), 3) for value in vertex) for vertex in vertices)
    triangles = sorted(_canonical_triangle(vertices[face]) for face in np.asarray(mesh.faces, dtype=int))
    return sha256(_canonical({"vertices": vertex_records, "orientedTriangles": triangles}).encode("utf-8")).hexdigest()


def _load_source_bundle(path: Path) -> tuple[dict, dict[str, trimesh.Trimesh]]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        records = [json.loads(line) for line in stream if line.strip()]
    if not records or records[0].get("recordType") != "header":
        raise VerificationError("source bundle header is missing")
    meshes: dict[str, trimesh.Trimesh] = {}
    for item in records[1:]:
        if item.get("recordType") != "mesh" or item.get("entityId") in meshes:
            raise VerificationError("source bundle mesh records are invalid")
        mesh = trimesh.Trimesh(
            vertices=np.asarray(item["vertices"], dtype=float),
            faces=np.asarray(item["faces"], dtype=int),
            process=False,
        )
        if _mesh_hash(mesh) != item["meshHash"]:
            raise VerificationError(f"source mesh hash differs for {item['entityId']}")
        meshes[item["entityId"]] = mesh
    if len(meshes) != int(records[0]["entityCount"]):
        raise VerificationError("source bundle entity count differs")
    return records[0], meshes


def _inverse_glb_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    vertices = np.asarray(mesh.vertices, dtype=float)
    restored = np.column_stack((vertices[:, 0], -vertices[:, 2], vertices[:, 1])) * 1000.0
    return trimesh.Trimesh(vertices=restored, faces=np.asarray(mesh.faces, dtype=int), process=False)


def _surface_distance(source: trimesh.Trimesh, target: trimesh.Trimesh) -> float:
    source_points = np.vstack(
        [
            np.asarray(source.vertices, dtype=float),
            np.asarray(source.triangles_center, dtype=float),
            np.asarray(source.vertices, dtype=float)[np.asarray(source.edges_unique, dtype=int)].mean(axis=1),
        ]
    )
    target_points = np.vstack(
        [
            np.asarray(target.vertices, dtype=float),
            np.asarray(target.triangles_center, dtype=float),
            np.asarray(target.vertices, dtype=float)[np.asarray(target.edges_unique, dtype=int)].mean(axis=1),
        ]
    )
    source_bounds = np.asarray(source.bounds, dtype=float)
    target_bounds = np.asarray(target.bounds, dtype=float)
    padding = 10.0
    source_mask = np.all((source_points >= target_bounds[0] - padding) & (source_points <= target_bounds[1] + padding), axis=1)
    target_mask = np.all((target_points >= source_bounds[0] - padding) & (target_points <= source_bounds[1] + padding), axis=1)
    selected_source = source_points[source_mask] if np.any(source_mask) else source_points
    selected_target = target_points[target_mask] if np.any(target_mask) else target_points
    _, first, _ = trimesh.proximity.closest_point_naive(target, selected_source)
    _, second, _ = trimesh.proximity.closest_point_naive(source, selected_target)
    return min(float(np.min(first)), float(np.min(second)))


SUPPORT_FLOW_ROLES = {
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

SUPPORT_ROLE_TYPES = {
    "ridge-roof-finish": ("ridgeTile", {"panTile", "coverTile"}),
    "cover-tile-pan-tile": ("coverTile", {"panTile"}),
    "pan-tile-roof-board": ("panTile", {"roofBoard"}),
    "roof-board-rafter": ("roofBoard", {"rafter"}),
    "rafter-purlin": ("rafter", {"purlin"}),
    "bearing-block-purlin": ("purlin", {"bearingBlock"}),
    "arm-bearing-block": ("bearingBlock", {"bracketArm"}),
    "seat-arm-x": ("bracketArm", {"bracketSeat"}),
    "seat-arm-y": ("bracketArm", {"bracketSeat"}),
    "eave-beam-seat": ("bracketSeat", {"eaveBeam"}),
    "column-eave-beam": ("eaveBeam", {"column"}),
    "interior-post-purlin": ("purlin", {"interiorPost"}),
    "tie-beam-interior-post": ("interiorPost", {"tieBeam"}),
    "column-tie-beam": ("tieBeam", {"column"}),
    "column-base": ("column", {"columnBase"}),
    "base-terrace": ("columnBase", {"terrace"}),
    "terrace-course-stack": ("terrace", {"terrace"}),
    "terrace-foundation": ("terrace", {"foundationLayer"}),
    "foundation-course-stack": ("foundationLayer", {"foundationLayer"}),
    "foundation-bearing-ground": ("foundationLayer", {"groundLayer"}),
}


def _face_patch(mesh: trimesh.Trimesh, face_indices: list[int]) -> trimesh.Trimesh:
    faces = np.asarray(mesh.faces, dtype=int)[np.asarray(face_indices, dtype=int)]
    unique, inverse = np.unique(faces.reshape(-1), return_inverse=True)
    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices, dtype=float)[unique],
        faces=inverse.reshape((-1, 3)),
        process=False,
    )


def _patch_descriptor(mesh: trimesh.Trimesh, face_indices: list[int]) -> dict:
    ordered = np.asarray(sorted(face_indices), dtype=int)
    areas = np.asarray(mesh.area_faces, dtype=float)[ordered]
    centers = np.asarray(mesh.triangles_center, dtype=float)[ordered]
    normals = np.asarray(mesh.face_normals, dtype=float)[ordered]
    area = float(np.sum(areas))
    centroid = np.average(centers, axis=0, weights=areas) if area > 0 else np.mean(centers, axis=0)
    normal = np.sum(normals * areas[:, None], axis=0)
    magnitude = float(np.linalg.norm(normal))
    if magnitude > 0:
        normal /= magnitude
    vertices = np.asarray(mesh.vertices, dtype=float)
    triangles = [
        _canonical_triangle(vertices[face])
        for face in np.asarray(mesh.faces, dtype=int)[ordered]
    ]
    return {
        "faceCount": int(len(ordered)),
        "areaMm2": round(area, 6),
        "centroidMm": np.round(centroid, 6).tolist(),
        "areaWeightedNormal": np.round(normal, 9).tolist(),
        "patchHash": sha256(_canonical(sorted(triangles)).encode("utf-8")).hexdigest(),
    }


def _patch_descriptor_matches(recorded: dict, actual: dict) -> bool:
    return (
        recorded.get("faceCount") == actual.get("faceCount")
        and recorded.get("patchHash") == actual.get("patchHash")
        and abs(float(recorded.get("areaMm2", -1)) - float(actual.get("areaMm2", -2))) <= 0.01
        and np.allclose(recorded.get("centroidMm"), actual.get("centroidMm"), atol=0.001)
        and np.allclose(recorded.get("areaWeightedNormal"), actual.get("areaWeightedNormal"), atol=1e-6)
    )


def _parameter_type_map(fixture: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for value_type, definition in fixture["parameterTypeRegistry"].items():
        for name in definition["parameters"]:
            result[name] = {"valueType": value_type, "unit": definition["unit"]}
    return result


def _roof_row_count(fixture: dict) -> int:
    curve = fixture["assembly"]["roofCurve"]
    fly = fixture["componentTemplates"]["flyRafter"]["parameters"]
    pan = fixture["componentTemplates"]["panTile"]["parameters"]
    derivative = sum(
        power * float(coefficient)
        for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"])
    ) / float(curve["halfSpan"])
    tangent_y = 1.0 / math.sqrt(1.0 + derivative**2)
    finished_half_span = float(curve["halfSpan"]) + tangent_y * float(fly["length"])
    return int(math.floor((finished_half_span - float(pan["length"])) / float(pan["rowPitch"]))) + 1


def _roof_value(curve: dict, y: float) -> float:
    half_span = float(curve["halfSpan"])
    distance = abs(float(y))
    t = min(1.0, max(0.0, distance / half_span))
    value = float(curve["ridgeHeight"]) - sum(
        float(coefficient) * t**power
        for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"])
    )
    if distance > half_span:
        value += _roof_slope(curve, half_span) * (distance - half_span)
    return value


def _roof_slope(curve: dict, y: float) -> float:
    half_span = float(curve["halfSpan"])
    t = min(1.0, max(0.0, abs(float(y)) / half_span))
    derivative = sum(
        power * float(coefficient) * t ** (power - 1)
        for power, coefficient in zip((1, 2, 3), curve["dropCoefficients"])
    )
    side = -1.0 if y < 0 else 1.0
    return float(-side * derivative / half_span)


def _roof_frame(curve: dict, y: float) -> tuple[np.ndarray, np.ndarray]:
    tangent = np.asarray([0.0, 1.0, _roof_slope(curve, y)], dtype=float)
    tangent /= np.linalg.norm(tangent)
    normal = np.cross(np.asarray([1.0, 0.0, 0.0]), tangent)
    normal /= np.linalg.norm(normal)
    if normal[2] < 0:
        normal *= -1
    return tangent, normal


def _ray_mesh_distance(mesh: trimesh.Trimesh, origin: np.ndarray, direction: np.ndarray, maximum: float) -> float | None:
    triangles = np.asarray(mesh.triangles, dtype=float)
    edge_one = triangles[:, 1] - triangles[:, 0]
    edge_two = triangles[:, 2] - triangles[:, 0]
    pvec = np.cross(np.broadcast_to(direction, edge_two.shape), edge_two)
    determinant = np.einsum("ij,ij->i", edge_one, pvec)
    valid = np.abs(determinant) > 1e-9
    inverse = np.zeros_like(determinant)
    inverse[valid] = 1.0 / determinant[valid]
    tvec = origin - triangles[:, 0]
    u = np.einsum("ij,ij->i", tvec, pvec) * inverse
    qvec = np.cross(tvec, edge_one)
    v = np.einsum("j,ij->i", direction, qvec) * inverse
    distance = np.einsum("ij,ij->i", edge_two, qvec) * inverse
    hits = valid & (u >= -1e-8) & (v >= -1e-8) & (u + v <= 1.0 + 1e-8) & (distance >= 0) & (distance <= maximum)
    return float(np.min(distance[hits])) if np.any(hits) else None


def _verify_roof_coverage(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    policy = fixture["geometryValidation"]["roofCoverage"]
    curve = fixture["assembly"]["roofCurve"]
    roof_width = float(fixture["assembly"]["roofWidth"])
    half_span = float(curve["halfSpan"])
    x_values = np.arange(
        -roof_width / 2 + float(policy["edgeMarginX"]),
        roof_width / 2 - float(policy["edgeMarginX"]) + 1e-6,
        float(policy["sampleSpacingX"]),
    )
    y_values = np.arange(
        -half_span + float(policy["edgeMarginY"]),
        half_span - float(policy["edgeMarginY"]) + 1e-6,
        float(policy["sampleSpacingY"]),
    )
    records = {item["entityId"]: item for item in manifest["entities"]}
    relevant = [
        (records[entity_id], mesh)
        for entity_id, mesh in meshes.items()
        if records[entity_id]["componentType"] in {"panTile", "coverTile", "ridgeTile", "roofBoard", "rafter", "flyRafter", "purlin"}
    ]
    uncovered: list[tuple[float, float, str]] = []
    ceramic_hits = 0
    clearance = float(policy["rayClearanceMm"])
    depth = float(policy["rayDepthMm"])
    for y in y_values:
        _, normal = _roof_frame(curve, float(y))
        for x in x_values:
            origin = np.asarray([x, y, _roof_value(curve, float(y))], dtype=float) + normal * clearance
            end = origin - normal * depth
            lower, upper = np.minimum(origin, end) - 1e-6, np.maximum(origin, end) + 1e-6
            first: tuple[float, dict] | None = None
            for record, mesh in relevant:
                if np.any(mesh.bounds[1] < lower) or np.any(mesh.bounds[0] > upper):
                    continue
                distance = _ray_mesh_distance(mesh, origin, -normal, depth)
                if distance is not None and (first is None or distance < first[0]):
                    first = (distance, record)
            if first is not None and first[1]["componentType"] in {"panTile", "coverTile", "ridgeTile"}:
                ceramic_hits += 1
            else:
                uncovered.append((float(x), float(y), first[1]["componentType"] if first else "none"))
    if len(uncovered) > int(policy["maximumUncoveredSamples"]):
        raise VerificationError(f"roof finish exposes structure or empty area: {uncovered[:3]}")
    return {"sampleCount": len(x_values) * len(y_values), "ceramicFirstHits": ceramic_hits, "uncoveredSamples": len(uncovered)}


def _tile_section_interval(fixture: dict, mesh: trimesh.Trimesh, x: float, y: float) -> tuple[float, float]:
    curve = fixture["assembly"]["roofCurve"]
    _, normal = _roof_frame(curve, y)
    origin = np.asarray([x, y, _roof_value(curve, y)], dtype=float)
    triangles = np.asarray(mesh.triangles, dtype=float)
    edge_one = triangles[:, 1] - triangles[:, 0]
    edge_two = triangles[:, 2] - triangles[:, 0]
    pvec = np.cross(np.broadcast_to(normal, edge_two.shape), edge_two)
    determinant = np.einsum("ij,ij->i", edge_one, pvec)
    valid = np.abs(determinant) > 1e-10
    inverse = np.zeros_like(determinant)
    inverse[valid] = 1.0 / determinant[valid]
    tvec = origin - triangles[:, 0]
    u = np.einsum("ij,ij->i", tvec, pvec) * inverse
    qvec = np.cross(tvec, edge_one)
    v = np.einsum("j,ij->i", normal, qvec) * inverse
    distance = np.einsum("ij,ij->i", edge_two, qvec) * inverse
    hits = distance[valid & (u >= -1e-8) & (v >= -1e-8) & (u + v <= 1.0 + 1e-8)]
    unique_hits = np.unique(np.round(hits, 7))
    if len(unique_hits) < 2:
        raise VerificationError("normal section line misses the declared tile or board solid")
    return float(unique_hits[0]), float(unique_hits[-1])


def _finished_roof_half_span(fixture: dict) -> float:
    curve = fixture["assembly"]["roofCurve"]
    fly = fixture["componentTemplates"]["flyRafter"]["parameters"]
    slope = _roof_slope(curve, float(curve["halfSpan"]))
    tangent_y = 1.0 / math.sqrt(1.0 + slope**2)
    return float(curve["halfSpan"]) + tangent_y * float(fly["length"])


def _tile_body_sample_distances(fixture: dict, component_type: str, row: int) -> np.ndarray:
    parameters = fixture["componentTemplates"][component_type]["parameters"]
    start = _finished_roof_half_span(fixture) - float(parameters["length"]) - row * float(parameters["rowPitch"])
    transition = min(20.0, float(parameters["overlap"]) / 2.0)
    stable_length = float(parameters["length"]) - float(parameters["overlap"]) - transition
    if stable_length <= 0:
        raise VerificationError(f"{component_type} has no stable bearing interval")
    return start + stable_length * np.asarray([0.15, 0.45, 0.75], dtype=float)


def _verify_tile_support_interfaces(
    fixture: dict,
    manifest: dict,
    meshes: dict[str, trimesh.Trimesh],
) -> dict:
    records = {item["entityId"]: item for item in manifest["entities"]}
    maximum_overlap = 0.0
    maximum_gap = 0.0
    checked_sections = 0
    role_counts: Counter = Counter()
    overlap_tolerance = float(fixture["geometryValidation"]["contactToleranceMm"])
    cover_width = float(fixture["componentTemplates"]["coverTile"]["parameters"]["width"])
    for item in manifest["interfaces"]:
        role = item["role"]
        if role not in {"pan-tile-roof-board", "cover-tile-pan-tile"}:
            continue
        source_record = records[item["fromEntityId"]]
        target_record = records[item["toEntityId"]]
        source_mesh = meshes[item["fromEntityId"]]
        target_mesh = meshes[item["toEntityId"]]
        source_parts = source_record["key"].split(":")
        side = source_parts[1]
        row = int(source_parts[3])
        distances = _tile_body_sample_distances(fixture, source_record["componentType"], row)
        if role == "pan-tile-roof-board":
            sample_x = round(float(source_mesh.centroid[0]), 3)
        else:
            target_x = round(float(target_mesh.centroid[0]), 3)
            source_x = round(float(source_mesh.centroid[0]), 3)
            sample_x = source_x + (1.0 if target_x > source_x else -1.0) * cover_width / 2.0
        for distance in distances:
            sample_y = -float(distance) if side == "south" else float(distance)
            source_bottom, source_top = _tile_section_interval(fixture, source_mesh, sample_x, sample_y)
            target_bottom, target_top = _tile_section_interval(fixture, target_mesh, sample_x, sample_y)
            solid_overlap = max(0.0, min(source_top, target_top) - max(source_bottom, target_bottom))
            interface_gap = max(0.0, source_bottom - target_top, target_bottom - source_top)
            maximum_overlap = max(maximum_overlap, solid_overlap)
            maximum_gap = max(maximum_gap, interface_gap)
            if solid_overlap > overlap_tolerance:
                raise VerificationError(f"tile bearing line has solid overlap: {item['interfaceId']}")
            if interface_gap > float(item["maximumGapMm"]):
                raise VerificationError(f"tile bearing line has an open gap: {item['interfaceId']}")
            checked_sections += 1
        role_counts[role] += 1
    expected_counts = Counter(
        item["role"]
        for item in manifest["interfaces"]
        if item["role"] in {"pan-tile-roof-board", "cover-tile-pan-tile"}
    )
    if role_counts != expected_counts:
        raise VerificationError("tile support interface coverage differs")
    return {
        "interfaceCounts": dict(sorted(role_counts.items())),
        "sampledSections": checked_sections,
        "maximumUnexpectedSolidOverlapMm": round(maximum_overlap, 6),
        "maximumInterfaceGapMm": round(maximum_gap, 6),
        "sampling": "three-stations-on-stable-tile-body-at-declared-bearing-line",
    }


def _verify_tile_laps(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    policy = fixture["geometryValidation"]["tileLap"]
    tolerance = float(policy["interfaceToleranceMm"])
    minimum_step = float(policy["minimumVisibleStepMm"])
    fractions = np.linspace(0.15, 0.85, int(policy["samplesPerOverlap"]))
    results: dict[str, dict] = {}
    for component_type, key_prefix in (("panTile", "pan-tile"), ("coverTile", "cover-tile")):
        parameters = fixture["componentTemplates"][component_type]["parameters"]
        length = float(parameters["length"])
        pitch = float(parameters["rowPitch"])
        overlap = float(parameters["overlap"])
        indexed: dict[tuple[str, int, int], dict] = {}
        for record in manifest["entities"]:
            if record["componentType"] != component_type:
                continue
            prefix, side, column, row = record["key"].split(":")
            if prefix != key_prefix:
                raise VerificationError(f"tile key prefix differs: {record['key']}")
            indexed[(side, int(column), int(row))] = record
        maximum_row = max(row for _, _, row in indexed)
        checked = 0
        maximum_overlap = 0.0
        maximum_gap = 0.0
        minimum_actual_step = math.inf
        finished_half_span = (
            float(fixture["assembly"]["roofCurve"]["halfSpan"])
            + 1.0
            / math.sqrt(1.0 + _roof_slope(fixture["assembly"]["roofCurve"], float(fixture["assembly"]["roofCurve"]["halfSpan"])) ** 2)
            * float(fixture["componentTemplates"]["flyRafter"]["parameters"]["length"])
        )
        for (side, column, row), lower_record in sorted(indexed.items()):
            if row >= maximum_row:
                continue
            upper_record = indexed.get((side, column, row + 1))
            if upper_record is None:
                raise VerificationError(f"tile lap sequence is incomplete: {component_type}:{side}:{column}:{row}")
            lower_start = finished_half_span - length - row * pitch
            upper_end = finished_half_span - (row + 1) * pitch
            if abs((upper_end - lower_start) - overlap) > tolerance:
                raise VerificationError("tile lap length differs from the fixture")
            lower_mesh = meshes[lower_record["entityId"]]
            upper_mesh = meshes[upper_record["entityId"]]
            x = float((lower_mesh.centroid[0] + upper_mesh.centroid[0]) / 2)
            for fraction in fractions:
                distance = lower_start + overlap * float(fraction)
                y = -distance if side == "south" else distance
                lower_bottom, lower_top = _tile_section_interval(fixture, lower_mesh, x, y)
                upper_bottom, upper_top = _tile_section_interval(fixture, upper_mesh, x, y)
                solid_overlap = max(0.0, min(lower_top, upper_top) - max(lower_bottom, upper_bottom))
                interface_gap = max(0.0, upper_bottom - lower_top)
                top_step = upper_top - lower_top
                maximum_overlap = max(maximum_overlap, solid_overlap)
                maximum_gap = max(maximum_gap, interface_gap)
                minimum_actual_step = min(minimum_actual_step, top_step)
                if solid_overlap > tolerance:
                    raise VerificationError(f"tile lap has unexpected solid overlap: {lower_record['key']}")
                if interface_gap > tolerance:
                    raise VerificationError(f"tile lap has an open interface: {lower_record['key']}")
                if top_step < minimum_step:
                    raise VerificationError(f"tile lap has no visible raised upper tile: {lower_record['key']}")
                checked += 1
        results[component_type] = {
            "lapPairs": sum(1 for _, _, row in indexed if row < maximum_row),
            "sampledSections": checked,
            "maximumUnexpectedSolidOverlapMm": round(maximum_overlap, 6),
            "maximumInterfaceGapMm": round(maximum_gap, 6),
            "minimumVisibleStepMm": round(minimum_actual_step, 6),
        }
    return results


def _expected_entity_type_counts(fixture: dict) -> dict[str, int]:
    assembly = fixture["assembly"]
    templates = fixture["componentTemplates"]
    row_count = _roof_row_count(fixture)
    pan = templates["panTile"]["parameters"]
    cover = templates["coverTile"]["parameters"]
    ridge = templates["ridgeTile"]["parameters"]
    roof_width = float(assembly["roofWidth"])
    return {
        "groundLayer": 6,
        "foundationLayer": 4 * int(templates["foundationLayer"]["parameters"]["courses"]),
        "terrace": round(templates["terrace"]["parameters"]["height"] / templates["terrace"]["parameters"]["courseHeight"]),
        "step": int(templates["step"]["parameters"]["count"]),
        "columnBase": 4,
        "column": 4,
        "eaveBeam": 2,
        "tieBeam": 2,
        "interiorPost": 10,
        "bracketSeat": 4,
        "bracketArm": 8,
        "bearingBlock": 4,
        "purlin": 7,
        "rafter": 34,
        "flyRafter": 34,
        "eaveClosure": 2,
        "roofBoard": 32,
        "panTile": 2 * (int(round((roof_width - float(pan["columnPitch"])) / float(pan["columnPitch"]))) + 1) * row_count,
        "coverTile": 2 * (int(round(roof_width / float(cover["columnPitch"]))) + 1) * row_count,
        "ridgeTile": int(math.ceil(roof_width / float(ridge["segmentLength"]))),
        "wall": 1,
        "doorFrameMember": 4,
        "doorLeafStile": 4,
        "doorLeafRail": 10,
        "doorLeafPanel": 8,
        "latticeFrameMember": 8,
        "latticeBar": 10,
    }


def _expected_interface_role_counts(fixture: dict) -> dict[str, int]:
    row_count = _roof_row_count(fixture)
    pan_columns = 16
    cover_columns = 17
    ridge = fixture["componentTemplates"]["ridgeTile"]["parameters"]
    pan = fixture["componentTemplates"]["panTile"]["parameters"]
    cover = fixture["componentTemplates"]["coverTile"]["parameters"]
    roof_width = float(fixture["assembly"]["roofWidth"])
    ridge_count = int(math.ceil(roof_width / float(ridge["segmentLength"])))
    segment = roof_width / ridge_count
    finish_intervals = []
    for side in range(2):
        finish_intervals.extend(
            (x - float(pan["width"]) / 2, x + float(pan["width"]) / 2)
            for x in np.arange(-2250, 2250.1, float(pan["columnPitch"]))
        )
        finish_intervals.extend(
            (x - float(cover["width"]) / 2, x + float(cover["width"]) / 2)
            for x in np.arange(-2400, 2400.1, float(cover["columnPitch"]))
        )
    ridge_finish = 0
    for index in range(ridge_count):
        x0 = -roof_width / 2 + segment * index
        x1 = x0 + segment
        ridge_finish += sum(1 for a, b in finish_intervals if min(x1, b) - max(x0, a) > 0)
    return {
        "foundation-ground": 8,
        "foundation-bearing-ground": 4,
        "foundation-course-stack": 8,
        "terrace-foundation": 4,
        "terrace-course-stack": 2,
        "step-course-stack": 2,
        "ground-step": 1,
        "step-terrace": 1,
        "column-base": 4,
        "base-terrace": 4,
        "column-eave-beam": 4,
        "column-tie-beam": 4,
        "tie-beam-interior-post": 10,
        "interior-post-purlin": 10,
        "eave-beam-seat": 4,
        "seat-arm-x": 4,
        "seat-arm-y": 4,
        "arm-cross-half-lap": 4,
        "arm-bearing-block": 8,
        "bearing-block-purlin": 4,
        "rafter-purlin": 136,
        "fly-rafter-rafter": 34,
        "roof-board-rafter": 64,
        "pan-tile-roof-board": 2 * pan_columns * row_count,
        "cover-tile-pan-tile": 2 * (cover_columns * 2 - 2) * row_count,
        "tile-longitudinal-lap": 2 * (pan_columns + cover_columns) * (row_count - 1),
        "ridge-roof-finish": ridge_finish,
        "eave-closure": 32,
        "wall-terrace": 1,
        "door-frame-terrace": 1,
        "frame-corner-joint": 4,
        "door-leaf-rail-stile": 20,
        "door-panel-groove": 32,
        "door-leaf-clearance": 3,
        "lattice-cross-joint": 12,
        "lattice-frame-corner": 8,
        "lattice-bar-frame": 20,
        "opening-closure": 11,
    }


def _expected_interface_bindings(fixture: dict) -> dict[str, tuple[str, str, str]]:
    expected: dict[str, tuple[str, str, str]] = {}

    def add(role: str, source: str, target: str, suffix: str) -> None:
        interface_id = f"IF-{role.upper()}-{suffix.upper()}".replace(":", "-")
        if interface_id in expected:
            raise VerificationError(f"independent interface oracle produced a duplicate: {interface_id}")
        expected[interface_id] = (role, source, target)

    for course in (1, 2):
        for x_index in range(2):
            for y_index in range(2):
                add(
                    "foundation-ground",
                    f"foundation:{x_index}:{y_index}:course:{course}",
                    f"ground:ring:foundation-course:{course}",
                    f"{x_index}-{y_index}-c{course}",
                )
    for x_index in range(2):
        for y_index in range(2):
            add("foundation-bearing-ground", f"foundation:{x_index}:{y_index}:course:0", f"ground:bearing:{x_index}:{y_index}", f"{x_index}-{y_index}")
            for course in (1, 2):
                add("foundation-course-stack", f"foundation:{x_index}:{y_index}:course:{course}", f"foundation:{x_index}:{y_index}:course:{course - 1}", f"{x_index}-{y_index}-c{course}")
            add("terrace-foundation", "terrace:course:0", f"foundation:{x_index}:{y_index}:course:2", f"{x_index}-{y_index}")
            add("column-base", f"column:{x_index}:{y_index}", f"column-base:{x_index}:{y_index}", f"{x_index}-{y_index}")
            add("base-terrace", f"column-base:{x_index}:{y_index}", "terrace:course:2", f"{x_index}-{y_index}")
            add("column-eave-beam", f"eave-beam:{y_index}", f"column:{x_index}:{y_index}", f"{x_index}-{y_index}")
            add("column-tie-beam", f"tie-beam:{x_index}", f"column:{x_index}:{y_index}", f"{x_index}-{y_index}")
            add("eave-beam-seat", f"bracket-seat:{x_index}:{y_index}", f"eave-beam:{y_index}", f"{x_index}-{y_index}")
            add("seat-arm-x", f"bracket-arm-x:{x_index}:{y_index}", f"bracket-seat:{x_index}:{y_index}", f"{x_index}-{y_index}")
            add("seat-arm-y", f"bracket-arm-y:{x_index}:{y_index}", f"bracket-seat:{x_index}:{y_index}", f"{x_index}-{y_index}")
            add("arm-cross-half-lap", f"bracket-arm-y:{x_index}:{y_index}", f"bracket-arm-x:{x_index}:{y_index}", f"{x_index}-{y_index}")
            for arm_axis in ("x", "y"):
                add("arm-bearing-block", f"bearing-block:{x_index}:{y_index}", f"bracket-arm-{arm_axis}:{x_index}:{y_index}", f"{x_index}-{y_index}-{arm_axis}")
            add("bearing-block-purlin", f"purlin:{0 if y_index == 0 else 6}", f"bearing-block:{x_index}:{y_index}", f"{x_index}-{y_index}")
    for course in (1, 2):
        add("terrace-course-stack", f"terrace:course:{course}", f"terrace:course:{course - 1}", f"c{course}")
        add("step-course-stack", f"step:south:{course}", f"step:south:{course - 1}", f"c{course}")
    add("ground-step", "step:south:0", "ground:ring:foundation-course:2", "south")
    add("step-terrace", "step:south:2", "terrace:course:2", "south")
    for x_index in range(2):
        for post_index, purlin_index in enumerate(range(1, 6)):
            add("tie-beam-interior-post", f"interior-post:{x_index}:{post_index}", f"tie-beam:{x_index}", f"{x_index}-{post_index}")
            add("interior-post-purlin", f"purlin:{purlin_index}", f"interior-post:{x_index}:{post_index}", f"{x_index}-{post_index}")
    row_count = _roof_row_count(fixture)
    for side in ("south", "north"):
        purlins = range(0, 4) if side == "south" else range(3, 7)
        for rafter in range(17):
            for purlin in purlins:
                add("rafter-purlin", f"rafter:{side}:{rafter}", f"purlin:{purlin}", f"{side}-{rafter}-p{purlin}")
            add("fly-rafter-rafter", f"fly-rafter:{side}:{rafter}", f"rafter:{side}:{rafter}", f"{side}-{rafter}")
        for board in range(16):
            for rafter in (board, board + 1):
                add("roof-board-rafter", f"roof-board:{side}:{board}", f"rafter:{side}:{rafter}", f"{side}-{board}-r{rafter}")
            for row in range(row_count):
                add("pan-tile-roof-board", f"pan-tile:{side}:{board}:{row}", f"roof-board:{side}:{board}", f"{side}-{board}-{row}")
        for cover in range(17):
            for pan in (cover - 1, cover):
                if 0 <= pan < 16:
                    for row in range(row_count):
                        add("cover-tile-pan-tile", f"cover-tile:{side}:{cover}:{row}", f"pan-tile:{side}:{pan}:{row}", f"{side}-c{cover}-p{pan}-r{row}")
        for tile_type, columns in (("pan-tile", 16), ("cover-tile", 17)):
            for column in range(columns):
                for row in range(1, row_count):
                    add("tile-longitudinal-lap", f"{tile_type}:{side}:{column}:{row}", f"{tile_type}:{side}:{column}:{row - 1}", f"{tile_type}-{side}-{column}-{row}")
        for board in range(16):
            add("eave-closure", f"eave-closure:{side}", f"roof-board:{side}:{board}", f"{side}-{board}")
    roof_width = float(fixture["assembly"]["roofWidth"])
    ridge = fixture["componentTemplates"]["ridgeTile"]["parameters"]
    ridge_count = int(math.ceil(roof_width / float(ridge["segmentLength"])))
    segment = roof_width / ridge_count
    finish: list[tuple[str, float, float]] = []
    final_row = row_count - 1
    for side in ("south", "north"):
        for column, x in enumerate(np.arange(-2250, 2250.1, float(fixture["componentTemplates"]["panTile"]["parameters"]["columnPitch"]))):
            width = float(fixture["componentTemplates"]["panTile"]["parameters"]["width"])
            finish.append((f"pan-tile:{side}:{column}:{final_row}", float(x) - width / 2, float(x) + width / 2))
        for column, x in enumerate(np.arange(-2400, 2400.1, float(fixture["componentTemplates"]["coverTile"]["parameters"]["columnPitch"]))):
            width = float(fixture["componentTemplates"]["coverTile"]["parameters"]["width"])
            finish.append((f"cover-tile:{side}:{column}:{final_row}", float(x) - width / 2, float(x) + width / 2))
    for index in range(ridge_count):
        x0 = -roof_width / 2 + segment * index
        x1 = x0 + segment
        ridge_key = f"ridge-tile:{index}"
        for finish_key, finish_x0, finish_x1 in finish:
            if min(x1, finish_x1) - max(x0, finish_x0) > 0:
                add("ridge-roof-finish", ridge_key, finish_key, f"{ridge_key}-{finish_key}")
    add("wall-terrace", "wall:south:left", "terrace:course:2", "south")
    add("door-frame-terrace", "door-frame:threshold", "terrace:course:2", "south")
    for horizontal in ("head", "threshold"):
        for vertical in ("left-stile", "right-stile"):
            add("frame-corner-joint", f"door-frame:{horizontal}", f"door-frame:{vertical}", f"{horizontal}-{vertical}")
    for member in ("left-stile", "right-stile", "head"):
        add("opening-closure", f"door-frame:{member}", "wall:south:left", f"door-{member}")
    for leaf in range(2):
        for rail in range(5):
            for side in ("left", "right"):
                add("door-leaf-rail-stile", f"door-leaf:{leaf}:rail:{rail}", f"door-leaf:{leaf}:stile:{side}", f"{leaf}-{rail}-{side}")
        for panel in range(4):
            for side in ("left", "right"):
                add("door-panel-groove", f"door-leaf:{leaf}:panel:{panel}", f"door-leaf:{leaf}:stile:{side}", f"{leaf}-p{panel}-{side}")
            for rail in (panel, panel + 1):
                add("door-panel-groove", f"door-leaf:{leaf}:panel:{panel}", f"door-leaf:{leaf}:rail:{rail}", f"{leaf}-p{panel}-r{rail}")
    add("door-leaf-clearance", "door-leaf:0:stile:right", "door-leaf:1:stile:left", "center")
    add("door-leaf-clearance", "door-leaf:0:stile:left", "door-frame:left-stile", "left-jamb")
    add("door-leaf-clearance", "door-leaf:1:stile:right", "door-frame:right-stile", "right-jamb")
    for side in ("left", "right"):
        for horizontal in ("top", "bottom"):
            for vertical in ("left", "right"):
                add("lattice-frame-corner", f"lattice:{side}:frame:{horizontal}", f"lattice:{side}:frame:{vertical}", f"{side}-{horizontal}-{vertical}")
        for member in ("left", "right", "top", "bottom"):
            add("opening-closure", f"lattice:{side}:frame:{member}", "wall:south:left", f"window-{side}-{member}")
        for horizontal in range(1, 4):
            for vertical in range(1, 3):
                add("lattice-cross-joint", f"lattice:{side}:hbar:{horizontal}", f"lattice:{side}:vbar:{vertical}", f"{side}-h{horizontal}-v{vertical}")
        for vertical in range(1, 3):
            for frame_member in ("top", "bottom"):
                add("lattice-bar-frame", f"lattice:{side}:vbar:{vertical}", f"lattice:{side}:frame:{frame_member}", f"{side}-v{vertical}-{frame_member}")
        for horizontal in range(1, 4):
            for frame_member in ("left", "right"):
                add("lattice-bar-frame", f"lattice:{side}:hbar:{horizontal}", f"lattice:{side}:frame:{frame_member}", f"{side}-h{horizontal}-{frame_member}")
    return expected


def _verify_signature(manifest: dict) -> dict:
    payload = {
        "entities": manifest["entities"],
        "interfaces": manifest["interfaces"],
        "dimensionFacts": manifest["dimensionFacts"],
        "observationCandidates": manifest["observationCandidates"],
        "protectionRecommendationCandidates": manifest["protectionRecommendationCandidates"],
    }
    signature = sha256(_canonical(payload).encode("utf-8")).hexdigest()
    revision = str(uuid5(GEOMETRY_REVISION_NAMESPACE, signature))
    if signature != manifest["geometrySignature"] or revision != manifest["geometryRevisionId"]:
        raise VerificationError("geometry signature or revision cannot be reproduced")
    return {"geometrySignature": signature, "geometryRevisionId": revision}


def _verify_entities(manifest: dict, meshes: dict[str, trimesh.Trimesh], fixture: dict) -> dict:
    records = {item["entityId"]: item for item in manifest["entities"]}
    if set(records) != set(meshes):
        raise VerificationError("manifest and source bundle entity sets differ")
    parameter_types = _parameter_type_map(fixture)
    unknown_registry = fixture["unknownRegistry"]
    value_type_counts: Counter = Counter()
    dimension_count = 0
    unknown_count = 0
    parameter_ids: set[str] = set()
    for entity_id, item in records.items():
        mesh = meshes[entity_id]
        if _mesh_hash(mesh) != item["meshHash"]:
            raise VerificationError(f"manifest mesh hash differs for {item['key']}")
        if not mesh.is_watertight or not mesh.is_winding_consistent:
            raise VerificationError(f"source mesh is not a consistently wound solid: {item['key']}")
        if item["producerType"] != "demo" or item["formalEligibility"] != "ineligible":
            raise VerificationError(f"entity provenance boundary differs: {item['key']}")
        if any(not str(ref).startswith("demo:") for ref in item["sourceRefs"]):
            raise VerificationError(f"external source entered an entity: {item['key']}")
        if item["resolution"].get("l1DemoEligibility") != "blocked":
            raise VerificationError(f"entity incorrectly claims L1 demo eligibility: {item['key']}")
        parameter_by_id = {fact["parameterId"]: fact for fact in item["parameterFacts"]}
        if len(parameter_by_id) != len(item["parameterFacts"]):
            raise VerificationError(f"duplicate parameter fact IDs: {item['key']}")
        for fact in item["parameterFacts"]:
            expected_id = _stable_id(PARAMETER_NAMESPACE, manifest["fixtureId"], item["key"], fact["stableKey"])
            expected_type = parameter_types.get(fact["stableKey"])
            if fact["parameterId"] != expected_id or expected_type is None:
                raise VerificationError(f"parameter fact identity differs: {item['key']}")
            if fact["valueType"] != expected_type["valueType"] or fact["unit"] != expected_type["unit"]:
                raise VerificationError(f"parameter value type differs: {item['key']}:{fact['stableKey']}")
            if fact["valueType"] == "count" and (
                not isinstance(fact["value"], int) or isinstance(fact["value"], bool)
            ):
                raise VerificationError(f"count parameter is not an integer: {item['key']}:{fact['stableKey']}")
            value_type_counts[fact["valueType"]] += 1
            parameter_ids.add(fact["parameterId"])
        expected_dimension_ids = {
            fact["parameterId"]
            for fact in item["parameterFacts"]
            if fact["valueType"] in {"length", "angle"}
        }
        actual_dimension_ids = {fact["dimensionId"] for fact in item["dimensionFacts"]}
        if actual_dimension_ids != expected_dimension_ids:
            raise VerificationError(f"entity dimension facts include non-dimensional values: {item['key']}")
        if any(fact.get("valueType") not in {"length", "angle"} for fact in item["dimensionFacts"]):
            raise VerificationError(f"entity dimension fact type is invalid: {item['key']}")
        dimension_count += len(item["dimensionFacts"])
        for unknown in item["unknowns"]:
            source = unknown_registry.get(unknown["stableKey"])
            if source is None:
                raise VerificationError(f"entity unknown is not declared: {item['key']}")
            for field in (
                "reasonCode", "displayNameZh", "requiredEvidence", "affectedClaims",
                "blocksProxyResult", "blocksFormalEligibility", "blocksL1",
            ):
                if unknown.get(field) != source.get(field):
                    raise VerificationError(f"entity unknown differs from its registry: {item['key']}:{field}")
            if unknown.get("affectedEntityId") != entity_id or not unknown.get("blocksFormalEligibility") or not unknown.get("blocksL1"):
                raise VerificationError(f"entity unknown does not preserve its qualification boundary: {item['key']}")
            unknown_count += 1
    if len(parameter_ids) != sum(value_type_counts.values()):
        raise VerificationError("parameter fact IDs are not unique across entities")
    return {
        "entityCount": len(records),
        "componentTypeCount": len({item["componentType"] for item in records.values()}),
        "parameterFactCount": sum(value_type_counts.values()),
        "parameterValueTypeCounts": dict(sorted(value_type_counts.items())),
        "dimensionFactCount": dimension_count,
        "structuredUnknownCount": unknown_count,
    }


def _verify_glb(glb_path: Path, meshes: dict[str, trimesh.Trimesh]) -> dict:
    scene = trimesh.load(glb_path, force="scene")
    if set(scene.geometry) != set(meshes):
        raise VerificationError("GLB entity set differs from the source bundle")
    maximum_error = 0.0
    for entity_id, source in meshes.items():
        restored = _inverse_glb_mesh(scene.geometry[entity_id])
        if (
            np.asarray(restored.vertices).shape != np.asarray(source.vertices).shape
            or np.asarray(restored.faces).shape != np.asarray(source.faces).shape
            or not np.array_equal(np.asarray(restored.faces, dtype=int), np.asarray(source.faces, dtype=int))
        ):
            raise VerificationError(f"GLB topology differs for {entity_id}")
        coordinate_error = float(
            np.max(np.abs(np.asarray(restored.vertices, dtype=float) - np.asarray(source.vertices, dtype=float)))
        )
        if coordinate_error > 0.001:
            raise VerificationError(f"GLB coordinate error exceeds 0.001 mm for {entity_id}")
        maximum_error = max(
            maximum_error,
            coordinate_error,
        )
    return {"meshCount": len(meshes), "maximumCoordinateErrorMm": round(maximum_error, 9)}


def _verify_dimensions(manifest: dict) -> dict:
    expected = {
        _stable_id(DIMENSION_NAMESPACE, manifest["fixtureId"], item["stableKey"])
        for item in manifest["dimensionFacts"]
    }
    actual = {item["dimensionFactId"] for item in manifest["dimensionFacts"]}
    if actual != expected:
        raise VerificationError("dimension fact IDs cannot be reproduced")
    for item in manifest["interfaces"]:
        if not set(item["dimensionFactIds"]) <= actual:
            raise VerificationError(f"interface dimension fact is unresolved: {item['interfaceId']}")
    return {"dimensionFactCount": len(actual)}


def _verify_interfaces(manifest: dict, meshes: dict[str, trimesh.Trimesh], fixture: dict) -> dict:
    entity_ids = set(meshes)
    connected: set[str] = set()
    adjacency: dict[str, set[str]] = {}
    maximum_gap = 0.0
    policies = {item["role"]: item for item in fixture["interfaceTemplates"]}
    actual_type_counts = Counter(item["componentType"] for item in manifest["entities"])
    if dict(actual_type_counts) != _expected_entity_type_counts(fixture):
        raise VerificationError("entity type counts cannot be reconstructed from the fixture")
    actual_role_counts = Counter(item["role"] for item in manifest["interfaces"])
    if dict(actual_role_counts) != _expected_interface_role_counts(fixture):
        raise VerificationError("interface role counts cannot be reconstructed from the fixture")
    expected_bindings = _expected_interface_bindings(fixture)
    actual_bindings = {
        item["interfaceId"]: (item["role"], item["fromEntityKey"], item["toEntityKey"])
        for item in manifest["interfaces"]
    }
    if actual_bindings != expected_bindings:
        raise VerificationError("interface instance bindings cannot be reconstructed from the fixture")
    records_by_key = {item["key"]: item for item in manifest["entities"]}
    for item in manifest["interfaces"]:
        source_id, target_id = item["fromEntityId"], item["toEntityId"]
        if source_id not in entity_ids or target_id not in entity_ids:
            raise VerificationError(f"interface entity is missing: {item['interfaceId']}")
        if (
            records_by_key[item["fromEntityKey"]]["entityId"] != source_id
            or records_by_key[item["toEntityKey"]]["entityId"] != target_id
        ):
            raise VerificationError(f"interface entity ID differs from its stable key: {item['interfaceId']}")
        connected.update((source_id, target_id))
        if item["role"] in SUPPORT_FLOW_ROLES:
            adjacency.setdefault(source_id, set()).add(target_id)
            source_type, target_types = SUPPORT_ROLE_TYPES[item["role"]]
            if (
                records_by_key[item["fromEntityKey"]]["componentType"] != source_type
                or records_by_key[item["toEntityKey"]]["componentType"] not in target_types
            ):
                raise VerificationError(f"support state transition differs: {item['interfaceId']}")
        policy = policies.get(item["role"])
        if policy is None:
            raise VerificationError(f"interface role is not in the fixture: {item['role']}")
        for field in (
            "role",
            "fromSurfaceRef",
            "toSurfaceRef",
            "interfaceKind",
            "contactMode",
            "interfaceStatus",
            "direction",
            "expectedGapMm",
            "maximumGapMm",
            "maximumUnexpectedOverlapMm3",
            "factBasis",
            "formalEligibility",
        ):
            if item.get(field) != policy.get(field):
                raise VerificationError(f"interface policy differs for {item['interfaceId']}: {field}")
        source_faces = item["surfaceWitness"]["fromFaceIndices"]
        target_faces = item["surfaceWitness"]["toFaceIndices"]
        if not source_faces or not target_faces:
            raise VerificationError(f"interface surface patch is empty: {item['interfaceId']}")
        if max(source_faces) >= len(meshes[source_id].faces) or max(target_faces) >= len(meshes[target_id].faces):
            raise VerificationError(f"interface surface patch exceeds mesh topology: {item['interfaceId']}")
        source_patch = _face_patch(meshes[source_id], source_faces)
        target_patch = _face_patch(meshes[target_id], target_faces)
        expected_resolution = {
            "fromSurfaceRef": item["fromSurfaceRef"],
            "toSurfaceRef": item["toSurfaceRef"],
            "selectionBasis": "nearest-mesh-surface-patch",
            "claimBoundary": "demo-geometric-witness-only",
        }
        if item["surfaceWitness"].get("surfaceRefResolution") != expected_resolution:
            raise VerificationError(f"interface surface reference boundary differs: {item['interfaceId']}")
        if not _patch_descriptor_matches(
            item["surfaceWitness"].get("fromPatch", {}),
            _patch_descriptor(meshes[source_id], source_faces),
        ):
            raise VerificationError(f"interface source patch descriptor differs: {item['interfaceId']}")
        if not _patch_descriptor_matches(
            item["surfaceWitness"].get("toPatch", {}),
            _patch_descriptor(meshes[target_id], target_faces),
        ):
            raise VerificationError(f"interface target patch descriptor differs: {item['interfaceId']}")
        measured = _surface_distance(source_patch, target_patch)
        global_minimum = _surface_distance(meshes[source_id], meshes[target_id])
        witness_gap = float(item["surfaceWitness"]["minimumSampledSurfaceDistanceMm"])
        witness_tolerance = float(fixture["geometryValidation"]["contactToleranceMm"])
        if abs(measured - witness_gap) > witness_tolerance + 0.001:
            raise VerificationError(f"interface surface witness differs: {item['interfaceId']}")
        if abs(global_minimum - witness_gap) > witness_tolerance + 0.001:
            raise VerificationError(f"interface patch is not the nearest mesh surface: {item['interfaceId']}")
        maximum_gap = max(maximum_gap, measured)
        if item["contactMode"] == "clearance":
            if abs(measured - float(item["expectedGapMm"])) > 0.5:
                raise VerificationError(f"interface clearance differs: {item['interfaceId']}")
        elif measured > float(item["maximumGapMm"]) + 0.001:
            raise VerificationError(f"interface surface gap differs: {item['interfaceId']}")
    if connected != entity_ids:
        raise VerificationError("one or more entities are absent from the interface graph")
    by_id = {item["entityId"]: item for item in manifest["entities"]}
    targets = {
        entity_id
        for entity_id, item in by_id.items()
        if item["componentType"] == "groundLayer" and item["key"].startswith("ground:bearing:")
    }
    starts = [entity_id for entity_id, item in by_id.items() if item["componentType"] in {"panTile", "coverTile", "ridgeTile"}]
    for start in starts:
        pending, visited = [start], {start}
        while pending and not (visited & targets):
            current = pending.pop()
            for neighbor in adjacency.get(current, set()) - visited:
                visited.add(neighbor)
                pending.append(neighbor)
        if not (visited & targets):
            raise VerificationError(f"roof finish lacks a ground path: {by_id[start]['key']}")
    return {"interfaceCount": len(manifest["interfaces"]), "maximumSampledGapMm": round(maximum_gap, 6)}


def _section_geometry(
    mesh: trimesh.Trimesh,
    origin: np.ndarray,
    normal: np.ndarray,
    coordinate_axes: tuple[int, int],
):
    section = mesh.section(plane_origin=origin, plane_normal=normal)
    if section is None:
        raise VerificationError("declared construction section does not intersect the entity")
    adjacency: dict[int, set[int]] = {}
    unused_edges: set[tuple[int, int]] = set()
    for entity in section.entities:
        indices = [int(value) for value in np.asarray(entity.points, dtype=int).tolist()]
        for first, second in zip(indices[:-1], indices[1:]):
            edge = tuple(sorted((first, second)))
            unused_edges.add(edge)
            adjacency.setdefault(first, set()).add(second)
            adjacency.setdefault(second, set()).add(first)
    polygons = []
    while unused_edges:
        first, second = next(iter(unused_edges))
        unused_edges.remove((first, second))
        loop = [first, second]
        previous, current = first, second
        while current != first:
            choices = [value for value in adjacency.get(current, set()) if value != previous]
            if not choices:
                break
            nxt = next((value for value in choices if tuple(sorted((current, value))) in unused_edges), choices[0])
            edge = tuple(sorted((current, nxt)))
            unused_edges.discard(edge)
            loop.append(nxt)
            previous, current = current, nxt
            if len(loop) > len(section.vertices) + 1:
                break
        if current != first or len(loop) < 4:
            continue
        points = np.asarray(section.vertices, dtype=float)[loop]
        polygon = Polygon(points[:, coordinate_axes]).buffer(0)
        if not polygon.is_empty and polygon.area > 1e-6:
            polygons.append(polygon)
    if not polygons:
        raise VerificationError("declared construction section has no closed material region")
    return unary_union(polygons)


def _estimated_intersection_volume(
    first: trimesh.Trimesh,
    second: trimesh.Trimesh,
    *,
    samples: int = 7,
) -> float:
    lower = np.maximum(first.bounds[0], second.bounds[0])
    upper = np.minimum(first.bounds[1], second.bounds[1])
    overlap = upper - lower
    if np.any(overlap <= 1e-6):
        return 0.0
    axes = [
        np.linspace(lower[index], upper[index], samples, endpoint=False)
        + overlap[index] / samples / 2
        for index in range(3)
    ]
    points = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape((-1, 3))
    inside = _points_inside_mesh(points, first) & _points_inside_mesh(points, second)
    return float(np.count_nonzero(inside) * np.prod(overlap) / len(points))


def _points_inside_mesh(points: np.ndarray, mesh: trimesh.Trimesh) -> np.ndarray:
    components = trimesh.graph.connected_components(
        mesh.face_adjacency,
        min_len=1,
        nodes=np.arange(len(mesh.faces)),
        engine="scipy",
    )
    if len(components) > 1:
        result = np.zeros(len(points), dtype=bool)
        for component in components:
            faces = np.asarray(mesh.faces, dtype=int)[np.asarray(component, dtype=int)]
            unique, inverse = np.unique(faces.reshape(-1), return_inverse=True)
            part = trimesh.Trimesh(
                vertices=np.asarray(mesh.vertices, dtype=float)[unique],
                faces=inverse.reshape((-1, 3)),
                process=False,
            )
            result |= _points_inside_connected_mesh(points, part)
        return result
    return _points_inside_connected_mesh(points, mesh)


def _points_inside_connected_mesh(points: np.ndarray, mesh: trimesh.Trimesh) -> np.ndarray:
    directions = [
        np.asarray([1.0, 0.3713906763541037, 0.1278314921007632], dtype=float),
        np.asarray([0.193847213, 1.0, 0.417239817], dtype=float),
        np.asarray([0.283719331, 0.149283741, 1.0], dtype=float),
    ]
    votes = np.zeros(len(points), dtype=int)
    for direction in directions:
        direction /= np.linalg.norm(direction)
        votes += _points_inside_mesh_one_direction(points, mesh, direction).astype(int)
    return votes >= 2


def _points_inside_mesh_one_direction(
    points: np.ndarray,
    mesh: trimesh.Trimesh,
    direction: np.ndarray,
) -> np.ndarray:
    triangles = np.asarray(mesh.triangles, dtype=float)
    edge_one = triangles[:, 1] - triangles[:, 0]
    edge_two = triangles[:, 2] - triangles[:, 0]
    pvec = np.cross(np.broadcast_to(direction, edge_two.shape), edge_two)
    determinant = np.einsum("ij,ij->i", edge_one, pvec)
    valid_faces = np.abs(determinant) > 1e-10
    inverse = np.zeros_like(determinant)
    inverse[valid_faces] = 1.0 / determinant[valid_faces]
    result = np.zeros(len(points), dtype=bool)
    for point_index, point in enumerate(np.asarray(points, dtype=float)):
        tvec = point - triangles[:, 0]
        u = np.einsum("ij,ij->i", tvec, pvec) * inverse
        qvec = np.cross(tvec, edge_one)
        v = np.einsum("j,ij->i", direction, qvec) * inverse
        distance = np.einsum("ij,ij->i", edge_two, qvec) * inverse
        hit_distances = distance[
            valid_faces
            & (u >= -1e-9)
            & (v >= -1e-9)
            & (u + v <= 1.0 + 1e-9)
            & (distance > 1e-8)
        ]
        unique_hits = np.unique(np.round(hit_distances, 7))
        result[point_index] = len(unique_hits) % 2 == 1
    return result


def _verify_unexpected_overlap(manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    tile_roles = {
        "pan-tile-roof-board",
        "cover-tile-pan-tile",
        "tile-longitudinal-lap",
    }
    maximum_volume = 0.0
    checked = 0
    for item in manifest["interfaces"]:
        if item["contactMode"] == "clearance" or item["role"] in tile_roles:
            continue
        volume = _estimated_intersection_volume(
            meshes[item["fromEntityId"]],
            meshes[item["toEntityId"]],
        )
        maximum_volume = max(maximum_volume, volume)
        if volume > float(item["maximumUnexpectedOverlapMm3"]) + 0.001:
            raise VerificationError(
                f"unexpected material overlap {volume:.6f} mm3: {item['interfaceId']}"
            )
        checked += 1
    return {
        "checkedInterfaces": checked,
        "maximumEstimatedUnexpectedOverlapMm3": round(maximum_volume, 6),
        "method": "independent-stratified-ray-parity-volume-v1",
    }


def _verify_local_construction(manifest: dict, meshes: dict[str, trimesh.Trimesh], fixture: dict) -> dict:
    by_key = {item["key"]: item for item in manifest["entities"]}
    panel_parameters = fixture["componentTemplates"]["doorLeafPanel"]["parameters"]
    rail_parameters = fixture["componentTemplates"]["doorLeafRail"]["parameters"]
    stile_parameters = fixture["componentTemplates"]["doorLeafStile"]["parameters"]
    maximum_area_error = 0.0
    for leaf in range(2):
        for panel in range(4):
            record = by_key[f"door-leaf:{leaf}:panel:{panel}"]
            feature_names = {item["featureName"] for item in record["featureIds"]}
            required = {"panel-left-tongue", "panel-right-tongue", "panel-top-tongue", "panel-bottom-tongue"}
            if not required <= feature_names:
                raise VerificationError(f"door panel edge tongues are incomplete: {record['key']}")
            panel_mesh = meshes[record["entityId"]]
            if len(panel_mesh.split(only_watertight=False)) != 1:
                raise VerificationError(f"door panel is not one continuous solid: {record['key']}")
            section = _section_geometry(
                panel_mesh,
                np.asarray([panel_mesh.centroid[0], panel_mesh.centroid[1], panel_mesh.centroid[2]]),
                np.asarray([0.0, 1.0, 0.0]),
                (0, 2),
            )
            tongue = float(panel_parameters["edgeTongue"])
            body_width = float(np.ptp(panel_mesh.bounds[:, 0])) - tongue * 2
            body_height = float(np.ptp(panel_mesh.bounds[:, 2])) - tongue * 2
            expected_area = body_width * body_height + 2 * tongue * body_height + 2 * tongue * body_width
            area_error = abs(float(section.area) - expected_area)
            maximum_area_error = max(maximum_area_error, area_error)
            if area_error > 0.01:
                raise VerificationError(f"door panel tongue profile differs: {record['key']}")
            if abs(float(np.ptp(panel_mesh.bounds[:, 1])) - float(panel_parameters["depth"])) > 0.001:
                raise VerificationError(f"door panel depth differs: {record['key']}")
    for leaf in range(2):
        for rail in range(5):
            record = by_key[f"door-leaf:{leaf}:rail:{rail}"]
            rail_mesh = meshes[record["entityId"]]
            if len(rail_mesh.split(only_watertight=False)) != 1:
                raise VerificationError(f"door rail is not one continuous solid: {record['key']}")
            feature_names = {item["featureName"] for item in record["featureIds"]}
            if "rail-panel-through-grooves" not in feature_names:
                raise VerificationError(f"door rail through-groove feature is missing: {record['key']}")
            section = _section_geometry(
                rail_mesh,
                np.asarray([rail_mesh.centroid[0], rail_mesh.centroid[1], rail_mesh.centroid[2]]),
                np.asarray([1.0, 0.0, 0.0]),
                (1, 2),
            )
            expected_area = (
                float(rail_parameters["depth"]) * float(rail_parameters["height"])
                - 2 * float(rail_parameters["panelGrooveWidth"]) * float(rail_parameters["panelGrooveDepth"])
            )
            area_error = abs(float(section.area) - expected_area)
            maximum_area_error = max(maximum_area_error, area_error)
            if area_error > 0.01:
                raise VerificationError(f"door rail groove profile differs: {record['key']}")
            expected_length = (
                float(rail_mesh.bounds[1, 0] - rail_mesh.bounds[0, 0])
                - float(rail_parameters["housingDepth"]) * 2
            )
            if expected_length <= 0:
                raise VerificationError(f"door rail housed projection is invalid: {record['key']}")
    if float(rail_parameters["panelGrooveWidth"]) - float(panel_parameters["depth"]) <= 0:
        raise VerificationError("door panel has no design clearance inside the rail groove")
    if float(stile_parameters["panelGrooveWidth"]) - float(panel_parameters["depth"]) <= 0:
        raise VerificationError("door panel has no design clearance inside the stile groove")
    for leaf in range(2):
        for side in ("left", "right"):
            stile_record = by_key[f"door-leaf:{leaf}:stile:{side}"]
            stile_mesh = meshes[stile_record["entityId"]]
            for rail in range(5):
                rail_mesh = meshes[by_key[f"door-leaf:{leaf}:rail:{rail}"]["entityId"]]
                section = _section_geometry(
                    stile_mesh,
                    np.asarray([stile_mesh.centroid[0], stile_mesh.centroid[1], rail_mesh.centroid[2]]),
                    np.asarray([0.0, 0.0, 1.0]),
                    (0, 1),
                )
                expected_area = (
                    float(stile_parameters["width"]) - float(stile_parameters["railHousingDepth"])
                ) * float(stile_parameters["depth"])
                if abs(float(section.area) - expected_area) > 0.01:
                    raise VerificationError(f"stile rail housing differs: {stile_record['key']}:{rail}")
    threshold = meshes[by_key["door-frame:threshold"]["entityId"]]
    terrace = meshes[by_key["terrace:course:2"]["entityId"]]
    overlap = np.maximum(
        np.minimum(threshold.bounds[1], terrace.bounds[1])
        - np.maximum(threshold.bounds[0], terrace.bounds[0]),
        0,
    )
    if float(np.prod(overlap)) > 0.001 or abs(float(threshold.bounds[0, 2] - terrace.bounds[1, 2])) > 0.001:
        raise VerificationError("door threshold overlaps the terrace or lacks bottom bearing")
    for side in ("left", "right"):
        for horizontal in ("top", "bottom"):
            first = meshes[by_key[f"lattice:{side}:frame:{horizontal}"]["entityId"]]
            for vertical in ("left", "right"):
                second = meshes[by_key[f"lattice:{side}:frame:{vertical}"]["entityId"]]
                overlap = np.maximum(np.minimum(first.bounds[1], second.bounds[1]) - np.maximum(first.bounds[0], second.bounds[0]), 0)
                if float(np.prod(overlap)) > 0.001:
                    raise VerificationError(f"lattice frame members overlap at {side}:{horizontal}:{vertical}")
    for upper in (1, 2):
        first = meshes[by_key[f"step:south:{upper}"]["entityId"]]
        second = meshes[by_key[f"step:south:{upper - 1}"]["entityId"]]
        overlap = np.maximum(np.minimum(first.bounds[1], second.bounds[1]) - np.maximum(first.bounds[0], second.bounds[0]), 0)
        if float(np.prod(overlap)) > 0.001:
            raise VerificationError("step courses overlap instead of stacking")
    return {
        "doorPanels": 8,
        "doorRails": 10,
        "latticeFrames": 2,
        "stepCourses": 3,
        "maximumDoorProfileAreaErrorMm2": round(maximum_area_error, 6),
    }


def verify(fixture_path: Path, output_dir: Path) -> dict:
    manifest_path = output_dir / "geometry-manifest.json"
    source_path = output_dir / "source-meshes.ndjson.gz"
    glb_path = output_dir / "local-construction-sample.glb"
    frozen = (output_dir / "build-record.json").exists()
    record_path = output_dir / ("build-record.json" if frozen else "prefreeze-build-record.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    record = json.loads(record_path.read_text(encoding="utf-8"))
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    for item in record["outputs"]:
        if _file_hash(output_dir / item["path"]) != item["sha256"]:
            raise VerificationError(f"build output hash differs: {item['path']}")
    if record["fixtureSha256"] != _file_hash(fixture_path):
        raise VerificationError("fixture hash differs from the build record")
    if frozen:
        if fixture["geometryRevisionId"] == "UNFROZEN" or fixture["knownAnswers"]["geometrySignature"] == "UNFROZEN":
            raise VerificationError("frozen verification requires a frozen fixture")
        if manifest["geometrySignature"] != fixture["knownAnswers"]["geometrySignature"]:
            raise VerificationError("manifest differs from the frozen geometry signature")
        if _file_hash(source_path) != fixture["knownAnswers"]["sourceMeshBundleSha256"]:
            raise VerificationError("source bundle differs from the frozen fixture")
    elif fixture["geometryRevisionId"] != "UNFROZEN" or fixture["knownAnswers"]["geometrySignature"] != "UNFROZEN":
        raise VerificationError("prefreeze verification requires an unfrozen fixture")
    header, meshes = _load_source_bundle(source_path)
    if header["geometryRevisionId"] != manifest["geometryRevisionId"]:
        raise VerificationError("source header revision differs")
    checks = {
        "signature": _verify_signature(manifest),
        "entities": _verify_entities(manifest, meshes, fixture),
        "glb": _verify_glb(glb_path, meshes),
        "dimensions": _verify_dimensions(manifest),
        "interfaces": _verify_interfaces(manifest, meshes, fixture),
        "tileSupportInterfaces": _verify_tile_support_interfaces(fixture, manifest, meshes),
        "tileLapIntegrity": _verify_tile_laps(fixture, manifest, meshes),
        "roofFinishCoverage": _verify_roof_coverage(fixture, manifest, meshes),
        "unexpectedOverlap": _verify_unexpected_overlap(manifest, meshes),
        "localConstruction": _verify_local_construction(manifest, meshes, fixture),
    }
    serialized = _canonical({"fixture": fixture, "manifest": manifest, "record": record}).lower()
    forbidden = [item.lower() for item in fixture["geometryValidation"]["forbiddenExternalTokens"]]
    dependency_payload = json.loads(_canonical({"fixture": fixture, "manifest": manifest, "record": record}))
    dependency_payload["fixture"]["geometryValidation"].pop("forbiddenExternalTokens", None)
    dependency_serialized = _canonical(dependency_payload).lower()
    if any(token in dependency_serialized for token in forbidden):
        raise VerificationError("external reference token entered the prefreeze evidence")
    report = {
        "schemaVersion": "t0b-v3-geometry-verification-2",
        "status": (
            "passed-independent-demo-geometry-technical-only"
            if frozen
            else "passed-independent-prefreeze-geometry-only"
        ),
        "decision": "technical-checks-passed-no-professional-qualification",
        "qualification": {
            "technicalDemoRevalidationPassed": bool(frozen),
            "localProfessionalSampleEligible": False,
            "L1": False,
            "formalEligibility": "ineligible",
        },
        "fixtureSha256": _file_hash(fixture_path),
        "manifestSha256": _file_hash(manifest_path),
        "sourceMeshBundleSha256": _file_hash(source_path),
        "glbSha256": _file_hash(glb_path),
        "verifierSha256": _file_hash(Path(__file__)),
        "checks": checks,
        "failedChecks": 0,
        "blockers": [
            "PROFESSIONAL_REVIEW_REQUIRED",
            "VIEW_AND_DRAWING_REGENERATION_REQUIRED",
            "GENERIC_GEOMETRY_KERNEL_REQUIRED",
            *([] if frozen else ["GEOMETRY_REVISION_NOT_FROZEN"]),
        ],
    }
    report_name = "geometry-verification.json" if frozen else "prefreeze-verification.json"
    (output_dir / report_name).write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify T0-B v3 prefreeze geometry evidence.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.fixture, args.output_dir), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
