from __future__ import annotations

import argparse
from copy import deepcopy
import gzip
from hashlib import sha256
import json
import math
from pathlib import Path

import numpy as np
from shapely.geometry import MultiPoint
import trimesh


VERIFIER_NAME = "t0b-v2-standalone-geometry-verifier"
VERIFIER_VERSION = "2.0.0"
MESH_HASH_PRECISION_MM = 3


class VerificationError(ValueError):
    pass


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_mesh_hash(mesh: trimesh.Trimesh, precision: int = MESH_HASH_PRECISION_MM) -> str:
    vertices = np.round(np.asarray(mesh.vertices, dtype=float), precision)
    vertex_records = sorted(tuple(float(value) for value in vertex) for vertex in vertices)
    triangle_records = []
    for face in np.asarray(mesh.faces, dtype=int):
        triangle_records.append(sorted(tuple(float(value) for value in vertices[index]) for index in face))
    payload = {"vertices": vertex_records, "triangles": sorted(triangle_records)}
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _to_source_coordinates(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    result = mesh.copy()
    vertices = np.asarray(result.vertices, dtype=float)
    result.vertices = np.column_stack((vertices[:, 0] * 1000, -vertices[:, 2] * 1000, vertices[:, 1] * 1000))
    return result


def _load_source_meshes(path: Path, fixture: dict) -> dict[str, trimesh.Trimesh]:
    meshes: dict[str, trimesh.Trimesh] = {}
    header_seen = False
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        lines = stream.read().splitlines()
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("recordType") == "header":
            if header_seen or line_number != 1:
                raise VerificationError("source mesh bundle must contain one first-line header")
            expected_header = {
                "recordType": "header",
                "schemaVersion": "t0b-v2-source-meshes-1",
                "unit": fixture["unit"],
                "coordinateSystem": fixture["coordinateSystem"],
                "geometryRevisionId": fixture["geometryRevisionId"],
            }
            if record != expected_header:
                raise VerificationError("source mesh bundle header differs from the fixture")
            header_seen = True
            continue
        if record.get("recordType") != "mesh":
            raise VerificationError(f"invalid source mesh record type at line {line_number}")
        entity_id = record.get("entityId")
        if not isinstance(entity_id, str) or entity_id in meshes:
            raise VerificationError(f"invalid source mesh entity at line {line_number}")
        meshes[entity_id] = trimesh.Trimesh(
            vertices=np.asarray(record["vertices"], dtype=float),
            faces=np.asarray(record["faces"], dtype=int),
            process=False,
        )
    if not header_seen:
        raise VerificationError("source mesh bundle has no schema header")
    return meshes


def _load_inputs(
    fixture_path: Path,
    manifest_path: Path,
    source_meshes_path: Path,
    glb_path: Path,
) -> tuple[dict, dict, dict[str, trimesh.Trimesh], dict[str, trimesh.Trimesh]]:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_meshes = _load_source_meshes(source_meshes_path, fixture)
    scene = trimesh.load(glb_path, force="scene")
    exported_meshes = {entity_id: _to_source_coordinates(mesh) for entity_id, mesh in scene.geometry.items()}
    return fixture, manifest, source_meshes, exported_meshes


def _entities_by_type(manifest: dict) -> dict[str, list[dict]]:
    result: dict[str, list[dict]] = {}
    for entity in manifest["entities"]:
        result.setdefault(entity["componentType"], []).append(entity)
    return result


def _verify_identity_and_meshes(
    fixture: dict,
    manifest: dict,
    source_meshes: dict[str, trimesh.Trimesh],
    exported_meshes: dict[str, trimesh.Trimesh],
) -> dict:
    entities = manifest["entities"]
    entity_ids = {item["entityId"] for item in entities}
    if entity_ids != set(source_meshes) or entity_ids != set(exported_meshes):
        raise VerificationError("source bundle, GLB nodes and manifest entities do not match")
    export_hash_mismatches = []
    maximum_coordinate_delta = 0.0
    for entity in entities:
        entity_id = entity["entityId"]
        source = source_meshes[entity_id]
        exported = exported_meshes[entity_id]
        if not isinstance(entity.get("meshHash"), str) or len(entity["meshHash"]) != 64:
            raise VerificationError(f"entity {entity_id} has no canonical source mesh hash")
        if entity.get("meshHashPrecisionMm") != 10 ** -MESH_HASH_PRECISION_MM:
            raise VerificationError(f"entity {entity_id} has an invalid source mesh hash precision")
        if _canonical_mesh_hash(source) != entity["meshHash"]:
            raise VerificationError(f"source mesh hash differs from the frozen manifest for {entity_id}")
        if int(entity["vertices"]) != len(source.vertices) or int(entity["faces"]) != len(source.faces):
            raise VerificationError(f"source mesh topology differs from the manifest for {entity_id}")
        if len(source.vertices) != len(exported.vertices) or not np.array_equal(np.asarray(source.faces), np.asarray(exported.faces)):
            raise VerificationError(f"entity {entity_id} changed topology during GLB export")
        coordinate_delta = float(np.max(np.abs(np.asarray(source.vertices) - np.asarray(exported.vertices))))
        maximum_coordinate_delta = max(maximum_coordinate_delta, coordinate_delta)
        if coordinate_delta > 10 ** -MESH_HASH_PRECISION_MM:
            raise VerificationError(f"entity {entity_id} changed source coordinates during GLB export by {coordinate_delta:.6f} mm")
        if not np.allclose(np.asarray(entity["bounds"]), exported.bounds, atol=fixture["geometryValidation"]["boundsToleranceMm"], rtol=0):
            raise VerificationError(f"entity {entity_id} changed bounds during GLB export")
        export_coordinates = np.asarray(exported.vertices, dtype=float)
        export_diagnostic = exported.copy()
        export_diagnostic.vertices = np.column_stack(
            (export_coordinates[:, 0] * 0.001, export_coordinates[:, 2] * 0.001, -export_coordinates[:, 1] * 0.001)
        )
        if _canonical_mesh_hash(export_diagnostic, precision=9) != entity.get("exportMeshHash"):
            export_hash_mismatches.append(entity_id)
    if export_hash_mismatches:
        raise VerificationError(f"diagnostic GLB mesh hashes differ for {len(export_hash_mismatches)} entities")
    closure_payload = sorted((entity["entityId"], entity["exportMeshHash"]) for entity in entities)
    closure_hash = sha256(json.dumps(closure_payload, separators=(",", ":")).encode("utf-8")).hexdigest()
    if closure_hash != manifest.get("exportClosureHash"):
        raise VerificationError("GLB export closure hash differs from the manifest")
    if manifest["geometryRevisionId"] != fixture["geometryRevisionId"]:
        raise VerificationError("geometry revision differs from the fixture")
    return {
        "name": "canonicalMeshClosure",
        "actual": {
            "entities": len(entities),
            "sourceMeshHashes": len(entities),
            "directSourceToGlbMatches": len(entities),
            "maximumCoordinateDeltaMm": round(maximum_coordinate_delta, 9),
        },
        "expected": {"entities": len(entities), "sourceMeshHashes": len(entities), "directSourceToGlbMatches": len(entities)},
        "tolerance": {"sourceToGlbCoordinateMm": 10 ** -MESH_HASH_PRECISION_MM},
        "passed": True,
    }


def _verify_sources(fixture: dict, manifest: dict) -> dict:
    expected = fixture["sourceRefs"]
    if manifest.get("producerType") != "demo" or manifest.get("sourceRefs") != expected:
        raise VerificationError("manifest provenance is not isolated to the demo fixture")
    for entity in manifest["entities"]:
        if entity.get("sourceRefs") != expected or any(not str(value).startswith("demo:") for value in entity.get("sourceRefs", [])):
            raise VerificationError(f"entity {entity['entityId']} has an external or mismatched source")
    serialized = json.dumps({"fixture": fixture, "manifest": manifest}, ensure_ascii=False).lower()
    if any(marker in serialized for marker in ("file:", "http://", "https://", "d:\\downloads")):
        raise VerificationError("external resource marker entered the geometry inputs")
    return {
        "name": "entityLevelSourceIsolation",
        "actual": {"producerType": "demo", "isolatedEntities": len(manifest["entities"])},
        "expected": {"producerType": "demo", "isolatedEntities": len(manifest["entities"])},
        "tolerance": 0,
        "passed": True,
    }


def _roof_value(curve: dict, y: float) -> float:
    t = max(0.0, abs(float(y)) / float(curve["halfSpan"]))
    return float(curve["ridgeHeight"] - sum(float(value) * t**power for value, power in zip(curve["dropCoefficients"], (1, 2, 3))))


def _roof_slope(curve: dict, y: float) -> float:
    half_span = float(curve["halfSpan"])
    t = max(0.0, abs(float(y)) / half_span)
    derivative = sum(power * float(value) * t ** (power - 1) for value, power in zip(curve["dropCoefficients"], (1, 2, 3)))
    side = -1.0 if y < 0 else 1.0
    return float(-side * derivative / half_span)


def _verify_roof_curve(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    curve = fixture["assembly"]["roofCurve"]
    board_ids = [item["entityId"] for item in manifest["entities"] if item["componentType"] == "roofBoard"]
    centerlines = []
    for entity_id in board_ids:
        vertices = np.asarray(meshes[entity_id].vertices, dtype=float)
        if len(vertices) % 4 != 0:
            raise VerificationError("roof-board topology cannot be reduced to swept cross-section centres")
        centerlines.append(vertices.reshape(-1, 4, 3).mean(axis=1))
    centers = np.vstack(centerlines)
    expected_z = np.asarray([_roof_value(curve, y) for y in centers[:, 1]], dtype=float)
    profile_error = float(np.max(np.abs(centers[:, 2] - expected_z)))

    step = float(curve["sampleStepMm"])
    chord_error = 0.0
    for start in np.arange(0.0, curve["halfSpan"], step):
        end = min(curve["halfSpan"], start + step)
        midpoint = (start + end) / 2
        chord_error = max(chord_error, abs(_roof_value(curve, midpoint) - (_roof_value(curve, start) + _roof_value(curve, end)) / 2))
    epsilon = 1e-6
    left_slope = _roof_slope(curve, -epsilon)
    right_slope = _roof_slope(curve, epsilon)
    tangent_jump = left_slope - right_slope
    edge_tangents = [abs(_roof_slope(curve, -curve["halfSpan"])), abs(_roof_slope(curve, curve["halfSpan"]))]
    profile_tolerance = float(fixture["geometryValidation"]["curveToleranceMm"])
    if profile_error > profile_tolerance:
        raise VerificationError(f"roof-board mesh differs from the declared paired curve by {profile_error:.6f} mm")
    if chord_error > fixture["geometryValidation"]["maxChordErrorMm"]:
        raise VerificationError("roof curve sampling exceeds the declared chord-error tolerance")
    if abs(left_slope - float(curve["ridgeOneSidedSlope"])) > 1e-6 or abs(right_slope + float(curve["ridgeOneSidedSlope"])) > 1e-6:
        raise VerificationError("roof ridge does not retain the frozen non-zero one-sided slopes")
    if abs(tangent_jump - float(curve["ridgeSlopeJump"])) > 1e-6:
        raise VerificationError("roof ridge slope jump differs from the frozen C0 definition")
    if max(edge_tangents) > curve["edgeTangentLimit"]:
        raise VerificationError("roof curve eave tangent exceeds the frozen limit")
    return {
        "name": "pairedRoofCurveWithRidgeBreak",
        "actual": {
            "maximumProfileErrorMm": round(profile_error, 6),
            "maxChordErrorMm": round(float(chord_error), 6),
            "leftRidgeSlope": round(float(left_slope), 6),
            "rightRidgeSlope": round(float(right_slope), 6),
            "ridgeSlopeJump": round(float(tangent_jump), 6),
            "edgeTangentMagnitudes": [round(float(value), 6) for value in edge_tangents],
        },
        "expected": {
            "family": curve["family"],
            "leftRidgeSlope": curve["ridgeOneSidedSlope"],
            "rightRidgeSlope": -curve["ridgeOneSidedSlope"],
            "ridgeSlopeJump": curve["ridgeSlopeJump"],
            "maxChordErrorMm": fixture["geometryValidation"]["maxChordErrorMm"],
            "edgeTangentLimit": curve["edgeTangentLimit"],
        },
        "tolerance": {"profileMm": profile_tolerance, "chordErrorMm": fixture["geometryValidation"]["maxChordErrorMm"]},
        "passed": True,
    }


def _ray_mesh_distance(mesh: trimesh.Trimesh, origin: np.ndarray, direction: np.ndarray, maximum: float) -> float | None:
    triangles = np.asarray(mesh.triangles, dtype=float)
    edge_one = triangles[:, 1] - triangles[:, 0]
    edge_two = triangles[:, 2] - triangles[:, 0]
    pvec = np.cross(np.broadcast_to(direction, edge_two.shape), edge_two)
    determinant = np.einsum("ij,ij->i", edge_one, pvec)
    valid = np.abs(determinant) > 1e-9
    if not np.any(valid):
        return None
    inverse = np.zeros_like(determinant)
    inverse[valid] = 1.0 / determinant[valid]
    tvec = origin - triangles[:, 0]
    u = np.einsum("ij,ij->i", tvec, pvec) * inverse
    qvec = np.cross(tvec, edge_one)
    v = np.einsum("j,ij->i", direction, qvec) * inverse
    distance = np.einsum("ij,ij->i", edge_two, qvec) * inverse
    hits = valid & (u >= -1e-8) & (v >= -1e-8) & (u + v <= 1.0 + 1e-8) & (distance >= 0) & (distance <= maximum)
    if not np.any(hits):
        return None
    return float(np.min(distance[hits]))


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
    record_by_id = {item["entityId"]: item for item in manifest["entities"]}
    relevant = [
        (record_by_id[entity_id], mesh)
        for entity_id, mesh in meshes.items()
        if record_by_id[entity_id]["componentType"]
        in {"panTile", "coverTile", "ridgeTile", "roofBoard", "rafter", "flyRafter", "purlin", "bearingBlock", "bracketArm", "bracketSeat"}
    ]
    clearance = float(policy["rayClearanceMm"])
    depth = float(policy["rayDepthMm"])
    exposed: list[dict] = []
    misses: list[list[float]] = []
    ceramic_hits = 0
    for y in y_values:
        _, _, normal = _roof_frame_from_curve(curve, float(y))
        for x in x_values:
            origin = np.asarray([x, y, _roof_value(curve, float(y))], dtype=float) + normal * clearance
            direction = -normal
            end = origin + direction * depth
            segment_min = np.minimum(origin, end) - 1e-6
            segment_max = np.maximum(origin, end) + 1e-6
            first: tuple[float, dict] | None = None
            for record, mesh in relevant:
                if np.any(mesh.bounds[1] < segment_min) or np.any(mesh.bounds[0] > segment_max):
                    continue
                distance = _ray_mesh_distance(mesh, origin, direction, depth)
                if distance is not None and (first is None or distance < first[0]):
                    first = (distance, record)
            if first is None:
                misses.append([round(float(x), 3), round(float(y), 3)])
            elif first[1]["componentType"] in {"panTile", "coverTile", "ridgeTile"}:
                ceramic_hits += 1
            else:
                exposed.append(
                    {
                        "x": round(float(x), 3),
                        "y": round(float(y), 3),
                        "firstHit": first[1]["componentType"],
                        "entityId": first[1]["entityId"],
                    }
                )
    maximum_uncovered = int(policy["maximumUncoveredSamples"])
    if len(exposed) + len(misses) > maximum_uncovered:
        example = (exposed + [{"x": item[0], "y": item[1], "firstHit": "none"} for item in misses])[:3]
        raise VerificationError(f"roof ceramic first-hit coverage failed at {len(exposed) + len(misses)} samples: {example}")
    total = len(x_values) * len(y_values)
    return {
        "name": "roofCeramicFirstHitCoverage",
        "actual": {"samples": total, "ceramicFirstHits": ceramic_hits, "exposedStructureSamples": len(exposed), "misses": len(misses)},
        "expected": {"ceramicFirstHits": total, "maximumUncoveredSamples": maximum_uncovered},
        "tolerance": {
            "sampleSpacingXmm": policy["sampleSpacingX"],
            "sampleSpacingYmm": policy["sampleSpacingY"],
            "edgeMarginXmm": policy["edgeMarginX"],
            "edgeMarginYmm": policy["edgeMarginY"],
        },
        "passed": True,
    }


def _roof_frame_from_curve(curve: dict, y: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    across = np.asarray([1.0, 0.0, 0.0])
    tangent = np.asarray([0.0, 1.0, _roof_slope(curve, y)], dtype=float)
    tangent /= np.linalg.norm(tangent)
    normal = np.cross(across, tangent)
    normal /= np.linalg.norm(normal)
    if normal[2] < 0:
        normal *= -1
    return across, tangent, normal


def _tile_curvature(mesh: trimesh.Trimesh, entity: dict, fixture: dict) -> float:
    parts = entity["key"].split(":")
    side, row = parts[1], int(parts[2])
    pan = fixture["componentTemplates"]["panTile"]["parameters"]
    step = float(pan["length"] - pan["overlap"])
    center_distance = row * step + pan["length"] / 2
    y = -center_distance if side == "south" else center_distance
    slope = _roof_slope(fixture["assembly"]["roofCurve"], y)
    tangent = np.asarray([0.0, 1.0, slope], dtype=float)
    tangent /= np.linalg.norm(tangent)
    normal = np.cross(np.asarray([1.0, 0.0, 0.0]), tangent)
    normal /= np.linalg.norm(normal)
    if normal[2] < 0:
        normal *= -1
    section = mesh.section(plane_origin=np.asarray([0.0, y, _roof_value(fixture["assembly"]["roofCurve"], y)]), plane_normal=tangent)
    if section is None:
        raise VerificationError(f"actual tile mesh has no transverse section: {entity['key']}")
    vertices = np.asarray(section.vertices, dtype=float)
    projected = vertices @ normal
    xs = vertices[:, 0]
    unique_x = sorted(set(np.round(xs, 4)))
    surface = [float(np.max(projected[np.isclose(xs, x, atol=0.01)])) for x in unique_x]
    return float(np.polyfit(np.asarray(unique_x), np.asarray(surface), 2)[0])


def _verify_component_features(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    by_type = _entities_by_type(manifest)
    pan_coefficients = [_tile_curvature(meshes[item["entityId"]], item, fixture) for item in by_type["panTile"]]
    cover_coefficients = [_tile_curvature(meshes[item["entityId"]], item, fixture) for item in by_type["coverTile"]]
    if min(pan_coefficients) <= 0 or max(cover_coefficients) >= 0:
        raise VerificationError("actual pan and cover tile meshes do not retain opposite curvature")

    ridge_components = [len(meshes[item["entityId"]].split(only_watertight=False)) for item in by_type["ridgeTile"]]
    if min(ridge_components) < 3:
        raise VerificationError("ridge tile is not a stacked family")
    wall_layers = [len(meshes[item["entityId"]].split(only_watertight=False)) for item in by_type["wall"]]
    frame_members = [len(meshes[item["entityId"]].split(only_watertight=False)) for item in by_type["doorFrame"]]
    rounded_members = [len(meshes[item["entityId"]].split(only_watertight=False)) for item in by_type["rafter"] + by_type["flyRafter"]]
    if min(wall_layers) < 3 or min(frame_members) < 4 or min(rounded_members) < 2:
        raise VerificationError("a resolved component is missing its declared geometric feature")
    return {
        "name": "resolvedFeatureGeometry",
        "actual": {
            "panQuadraticRange": [round(min(pan_coefficients), 9), round(max(pan_coefficients), 9)],
            "coverQuadraticRange": [round(min(cover_coefficients), 9), round(max(cover_coefficients), 9)],
            "minimumRidgeStackParts": min(ridge_components),
            "minimumWallLayers": min(wall_layers),
            "minimumDoorFrameMembers": min(frame_members),
            "minimumRafterBodies": min(rounded_members),
        },
        "expected": {"panSign": "positive", "coverSign": "negative", "ridgeStackParts": 3, "wallLayers": 3, "doorFrameMembers": 4, "rafterBodies": 2},
        "tolerance": 0,
        "passed": True,
    }


def _tile_section_interval(
    fixture: dict,
    mesh: trimesh.Trimesh,
    x: float,
    y: float,
) -> tuple[float, float]:
    curve = fixture["assembly"]["roofCurve"]
    _, tangent, normal = _roof_frame_from_curve(curve, y)
    section = mesh.section(
        plane_origin=np.asarray([x, y, _roof_value(curve, y)], dtype=float),
        plane_normal=tangent,
    )
    if section is None:
        raise VerificationError("tile lap section does not intersect an expected tile")
    vertices = np.asarray(section.vertices, dtype=float)
    x_distance = np.abs(vertices[:, 0] - x)
    nearest = float(np.min(x_distance))
    selected = vertices[x_distance <= nearest + 0.01]
    projected = selected @ normal
    return float(np.min(projected)), float(np.max(projected))


def _tile_record_index(records: list[dict]) -> dict[tuple[str, int, int], dict]:
    result: dict[tuple[str, int, int], dict] = {}
    for record in records:
        _, side, row, column = record["key"].split(":")
        result[(side, int(row), int(column))] = record
    return result


def _verify_tile_laps(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    policy = fixture["geometryValidation"]["tileLap"]
    tolerance = float(policy["interfaceToleranceMm"])
    minimum_step = float(policy["minimumVisibleStepMm"])
    fractions = np.linspace(0.15, 0.85, int(policy["samplesPerOverlap"]))
    results: dict[str, dict[str, float | int]] = {}
    for component_type in ("panTile", "coverTile"):
        parameters = fixture["componentTemplates"][component_type]["parameters"]
        length = float(parameters["length"])
        overlap = float(parameters["overlap"])
        step = length - overlap
        records = [item for item in manifest["entities"] if item["componentType"] == component_type]
        indexed = _tile_record_index(records)
        maximum_row = max(key[1] for key in indexed)
        checked = 0
        maximum_solid_overlap = 0.0
        maximum_interface_gap = 0.0
        minimum_top_step = math.inf
        for (side, row, column), upper_record in sorted(indexed.items()):
            if row >= maximum_row:
                continue
            lower_record = indexed.get((side, row + 1, column))
            if lower_record is None:
                raise VerificationError(f"tile lap sequence is incomplete for {component_type}:{side}:{row}:{column}")
            upper_end = row * step + length
            lower_start = (row + 1) * step
            actual_overlap = upper_end - lower_start
            if abs(actual_overlap - overlap) > tolerance:
                raise VerificationError(f"declared tile overlap differs for {component_type}:{side}:{row}:{column}")
            upper_mesh = meshes[upper_record["entityId"]]
            lower_mesh = meshes[lower_record["entityId"]]
            x = float((upper_mesh.centroid[0] + lower_mesh.centroid[0]) / 2)
            for fraction in fractions:
                distance = lower_start + overlap * float(fraction)
                y = -distance if side == "south" else distance
                upper_bottom, upper_top = _tile_section_interval(fixture, upper_mesh, x, y)
                lower_bottom, lower_top = _tile_section_interval(fixture, lower_mesh, x, y)
                solid_overlap = max(0.0, min(upper_top, lower_top) - max(upper_bottom, lower_bottom))
                interface_gap = max(0.0, upper_bottom - lower_top)
                top_step = upper_top - lower_top
                maximum_solid_overlap = max(maximum_solid_overlap, solid_overlap)
                maximum_interface_gap = max(maximum_interface_gap, interface_gap)
                minimum_top_step = min(minimum_top_step, top_step)
                if solid_overlap > tolerance:
                    raise VerificationError(f"adjacent {component_type} rows overlap solid volume by {solid_overlap:.3f} mm")
                if interface_gap > tolerance:
                    raise VerificationError(f"adjacent {component_type} rows leave a lap gap of {interface_gap:.3f} mm")
                if top_step < minimum_step:
                    raise VerificationError(f"adjacent {component_type} rows have no visible upper-over-lower step")
                checked += 1
        expected_laps = sum(1 for key in indexed if key[1] < maximum_row)
        results[component_type] = {
            "lapPairs": expected_laps,
            "sampledSections": checked,
            "declaredOverlapMm": overlap,
            "maximumSolidOverlapMm": round(maximum_solid_overlap, 6),
            "maximumInterfaceGapMm": round(maximum_interface_gap, 6),
            "minimumTopStepMm": round(minimum_top_step, 6),
        }
    return {
        "name": "tileLapIntegrity",
        "actual": results,
        "expected": {"solidOverlapMm": 0, "interfaceGapMm": 0, "minimumVisibleStepMm": minimum_step},
        "tolerance": {"interfaceMm": tolerance, "samplesPerOverlap": len(fractions)},
        "passed": True,
    }


def _aabb_gap(first: trimesh.Trimesh, second: trimesh.Trimesh) -> float:
    first_bounds = np.asarray(first.bounds, dtype=float)
    second_bounds = np.asarray(second.bounds, dtype=float)
    separation = np.maximum(np.maximum(first_bounds[0] - second_bounds[1], second_bounds[0] - first_bounds[1]), 0)
    return float(np.linalg.norm(separation))


def _vertex_surface_gap(source: trimesh.Trimesh, target: trimesh.Trimesh) -> float:
    _, distances, _ = trimesh.proximity.closest_point_naive(target, np.asarray(source.vertices, dtype=float))
    return float(np.min(distances))


def _tile_board_contact(fixture: dict, source_record: dict, source: trimesh.Trimesh, target: trimesh.Trimesh) -> tuple[float, float]:
    parts = source_record["key"].split(":")
    side, row = parts[1], int(parts[2])
    pan = fixture["componentTemplates"]["panTile"]["parameters"]
    step = float(pan["length"] - pan["overlap"])
    center_distance = row * step + pan["length"] / 2
    start_distance = max(0.0, center_distance - pan["length"] / 2)
    contact_distance = start_distance + pan["overlap"] / 2
    y = -contact_distance if side == "south" else contact_distance
    curve = fixture["assembly"]["roofCurve"]
    tangent = np.asarray([0.0, 1.0, _roof_slope(curve, y)], dtype=float)
    tangent /= np.linalg.norm(tangent)
    normal = np.cross(np.asarray([1.0, 0.0, 0.0]), tangent)
    normal /= np.linalg.norm(normal)
    if normal[2] < 0:
        normal *= -1
    origin = np.asarray([0.0, y, _roof_value(curve, y)], dtype=float)
    source_section = source.section(plane_origin=origin, plane_normal=tangent)
    target_section = target.section(plane_origin=origin, plane_normal=tangent)
    if source_section is None or target_section is None:
        raise VerificationError(f"cannot resolve tile-board contact section for {source_record['key']}")
    signed_gap = float(np.min(source_section.vertices @ normal) - np.max(target_section.vertices @ normal))
    return max(0.0, signed_gap), max(0.0, -signed_gap)


def _groove_contact_metrics(source: trimesh.Trimesh, target: trimesh.Trimesh, tolerance: float) -> tuple[int, float, float]:
    _, distances, _ = trimesh.proximity.closest_point_naive(source, np.asarray(target.vertices, dtype=float))
    contact_distances = distances[distances <= tolerance]
    lateral_offset = abs(float(source.centroid[1] - target.centroid[1]))
    maximum_error = float(np.max(contact_distances)) if len(contact_distances) else math.inf
    return int(len(contact_distances)), maximum_error, lateral_offset


def _horizontal_section_hull(mesh: trimesh.Trimesh, z: float) -> object:
    section = mesh.section(plane_origin=np.asarray([0.0, 0.0, z]), plane_normal=np.asarray([0.0, 0.0, 1.0]))
    if section is None or len(section.vertices) < 3:
        raise VerificationError("support contact section cannot be resolved")
    return MultiPoint(np.asarray(section.vertices, dtype=float)[:, :2]).convex_hull


def _bearing_contact_area(source: trimesh.Trimesh, target: trimesh.Trimesh) -> float:
    source_plane = float(source.bounds[0, 2] + min(0.1, np.ptp(source.bounds, axis=0)[2] / 10))
    target_plane = float(target.bounds[1, 2] - min(0.1, np.ptp(target.bounds, axis=0)[2] / 10))
    return float(_horizontal_section_hull(source, source_plane).intersection(_horizontal_section_hull(target, target_plane)).area)


def _verify_support_contacts(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    entity_by_id = {item["entityId"]: item for item in manifest["entities"]}
    tolerance = float(fixture["supportValidation"]["surfaceGapToleranceMm"])
    allowances = fixture["supportValidation"]["jointAllowancesMm"]
    vertical_pairs = {
        "ridgeTile:roofBoard",
        "purlin:bearingBlock",
        "purlin:interiorPost",
        "bearingBlock:bracketArm",
        "bracketArm:bracketSeat",
        "bracketSeat:eaveBeam",
        "eaveBeam:column",
        "tieBeam:column",
        "column:columnBase",
        "columnBase:terrace",
        "terrace:terrace",
        "terrace:foundation",
        "wall:terrace",
    }
    aggregates: dict[str, dict[str, float | int]] = {}
    exact_contacts: dict[str, dict[str, float | int]] = {}
    supported = [item for item in manifest["relations"] if item["relation"] == "supportedBy"]
    for relation in supported:
        source_record = entity_by_id[relation["fromEntityId"]]
        target_record = entity_by_id[relation["toEntityId"]]
        pair = f"{source_record['componentType']}:{target_record['componentType']}"
        source = meshes[source_record["entityId"]]
        target = meshes[target_record["entityId"]]
        box_gap = _aabb_gap(source, target)
        penetration = 0.0
        if pair in {"panTile:roofBoard", "coverTile:roofBoard"}:
            gap, penetration = _tile_board_contact(fixture, source_record, source, target)
        else:
            gap = box_gap if pair in vertical_pairs else _vertex_surface_gap(source, target)
        if gap > tolerance:
            raise VerificationError(f"support gap {gap:.3f} mm exceeds tolerance for {pair}")
        if pair in vertical_pairs:
            if float(source.centroid[2]) <= float(target.centroid[2]) + fixture["supportValidation"]["directionToleranceMm"]:
                raise VerificationError(f"support direction is inverted for {pair}")
            penetration = max(0.0, float(target.bounds[1, 2] - source.bounds[0, 2]))
            if penetration > float(allowances.get(pair, 0)) + tolerance:
                raise VerificationError(f"support penetration {penetration:.3f} mm exceeds allowance for {pair}")
        elif penetration > tolerance:
            raise VerificationError(f"support penetration {penetration:.3f} mm exceeds tolerance for {pair}")
        aggregate = aggregates.setdefault(pair, {"count": 0, "maxGapMm": 0.0, "maxPenetrationMm": 0.0})
        aggregate["count"] = int(aggregate["count"]) + 1
        aggregate["maxGapMm"] = max(float(aggregate["maxGapMm"]), gap)
        aggregate["maxPenetrationMm"] = max(float(aggregate["maxPenetrationMm"]), penetration)
        if pair in {"purlin:bearingBlock", "purlin:interiorPost"}:
            contact_count, profile_error, lateral_offset = _groove_contact_metrics(source, target, tolerance)
            if contact_count < int(fixture["supportValidation"]["minimumGrooveContactVertices"]):
                raise VerificationError(f"groove contact has only {contact_count} verified vertices for {pair}")
            if lateral_offset > float(fixture["supportValidation"]["maximumLateralOffsetMm"]):
                raise VerificationError(f"groove support lateral offset {lateral_offset:.3f} mm exceeds tolerance for {pair}")
            exact = exact_contacts.setdefault(
                pair,
                {"count": 0, "minimumContactVertices": contact_count, "maximumProfileErrorMm": 0.0, "maximumLateralOffsetMm": 0.0},
            )
            exact["count"] = int(exact["count"]) + 1
            exact["minimumContactVertices"] = min(int(exact["minimumContactVertices"]), contact_count)
            exact["maximumProfileErrorMm"] = max(float(exact["maximumProfileErrorMm"]), profile_error)
            exact["maximumLateralOffsetMm"] = max(float(exact["maximumLateralOffsetMm"]), lateral_offset)
        elif pair == "bearingBlock:bracketArm":
            area = _bearing_contact_area(source, target)
            if area < float(fixture["supportValidation"]["minimumBearingAreaMm2"]):
                raise VerificationError(f"bearing contact area {area:.3f} mm2 is below the minimum for {pair}")
            exact = exact_contacts.setdefault(pair, {"count": 0, "minimumBearingAreaMm2": area})
            exact["count"] = int(exact["count"]) + 1
            exact["minimumBearingAreaMm2"] = min(float(exact["minimumBearingAreaMm2"]), area)
    for value in aggregates.values():
        value["maxGapMm"] = round(float(value["maxGapMm"]), 6)
        value["maxPenetrationMm"] = round(float(value["maxPenetrationMm"]), 6)
    for value in exact_contacts.values():
        for key in list(value):
            if key != "count":
                value[key] = round(float(value[key]), 6)
    return {
        "name": "supportRelationshipAndExactContacts",
        "actual": {
            "supportedRelations": len(supported),
            "relationshipBounds": dict(sorted(aggregates.items())),
            "exactContactPairs": dict(sorted(exact_contacts.items())),
        },
        "expected": {
            "maxSurfaceGapMm": tolerance,
            "upwardSourceDirection": True,
            "jointAllowancesMm": allowances,
            "minimumGrooveContactVertices": fixture["supportValidation"]["minimumGrooveContactVertices"],
            "minimumBearingAreaMm2": fixture["supportValidation"]["minimumBearingAreaMm2"],
        },
        "tolerance": {
            "surfaceGapMm": tolerance,
            "directionMm": fixture["supportValidation"]["directionToleranceMm"],
            "lateralOffsetMm": fixture["supportValidation"]["maximumLateralOffsetMm"],
        },
        "passed": True,
    }


def _type_bounds(entity_type: str, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> list[list[float]]:
    selected = [meshes[item["entityId"]] for item in manifest["entities"] if item["componentType"] == entity_type]
    return [np.min([item.bounds[0] for item in selected], axis=0).tolist(), np.max([item.bounds[1] for item in selected], axis=0).tolist()]


def _verify_numeric_oracle(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    oracle = fixture["knownAnswers"]["geometryOracle"]
    tolerance = float(fixture["geometryValidation"]["boundsToleranceMm"])
    actual = {
        "overallBounds": [np.min([item.bounds[0] for item in meshes.values()], axis=0).tolist(), np.max([item.bounds[1] for item in meshes.values()], axis=0).tolist()],
        "stepBounds": _type_bounds("step", manifest, meshes),
        "doorLeafBounds": _type_bounds("doorLeaf", manifest, meshes),
        "ridgeBounds": _type_bounds("ridgeTile", manifest, meshes),
    }
    for field, expected in oracle.items():
        if not np.allclose(np.asarray(actual[field]), np.asarray(expected), atol=tolerance, rtol=0):
            raise VerificationError(f"numeric geometry oracle differs for {field}")
    return {
        "name": "numericGeometryOracle",
        "actual": {key: np.round(value, 6).tolist() for key, value in actual.items()},
        "expected": oracle,
        "tolerance": {"boundsMm": tolerance},
        "passed": True,
    }


def _expect_failure(name: str, callback) -> dict:
    try:
        callback()
    except VerificationError as error:
        return {"name": name, "passed": True, "detected": str(error)}
    raise VerificationError(f"negative case did not fail: {name}")


def _run_negative_cases(
    fixture: dict,
    manifest: dict,
    source_meshes: dict[str, trimesh.Trimesh],
    meshes: dict[str, trimesh.Trimesh],
) -> list[dict]:
    cases = []

    mutated_export = {key: value.copy() for key, value in meshes.items()}
    curved = next(item for item in manifest["entities"] if item["componentType"] == "panTile")
    curved_mesh = mutated_export[curved["entityId"]]
    bounds = curved_mesh.bounds.copy()
    candidates = np.where(np.all((np.asarray(curved_mesh.vertices) > bounds[0] + 0.01) & (np.asarray(curved_mesh.vertices) < bounds[1] - 0.01), axis=1))[0]
    vertex_index = int(candidates[0] if len(candidates) else len(curved_mesh.vertices) // 2)
    curved_mesh.vertices[vertex_index] += np.asarray([0.25, 0.25, 0.25])
    if not np.allclose(curved_mesh.bounds, bounds, atol=0.001, rtol=0):
        raise VerificationError("internal-vertex export mutation unexpectedly changed bounds")
    cases.append(
        _expect_failure(
            "internalVertexExportMutation",
            lambda: _verify_identity_and_meshes(fixture, manifest, source_meshes, mutated_export),
        )
    )

    source_manifest = deepcopy(manifest)
    source_manifest["entities"][0]["sourceRefs"] = ["file:external-reference"]
    cases.append(_expect_failure("externalEntitySource", lambda: _verify_sources(fixture, source_manifest)))

    swapped = deepcopy(manifest)
    pan = next(item for item in swapped["entities"] if item["componentType"] == "panTile")
    cover = next(item for item in swapped["entities"] if item["componentType"] == "coverTile")
    pan["componentType"], cover["componentType"] = cover["componentType"], pan["componentType"]
    cases.append(_expect_failure("panCoverTypeSwap", lambda: _verify_component_features(fixture, swapped, meshes)))

    coplanar_lap_meshes = {key: value.copy() for key, value in meshes.items()}
    lower_tile = next(item for item in manifest["entities"] if item["key"] == "pan-tile:south:1:0")
    _, _, lap_normal = _roof_frame_from_curve(fixture["assembly"]["roofCurve"], -440.0)
    coplanar_lap_meshes[lower_tile["entityId"]].apply_translation(
        lap_normal * float(fixture["componentTemplates"]["panTile"]["parameters"]["lapTailDepth"])
    )
    cases.append(_expect_failure("coplanarAdjacentTileLap", lambda: _verify_tile_laps(fixture, manifest, coplanar_lap_meshes)))

    raised_meshes = {key: value.copy() for key, value in meshes.items()}
    bearing = next(item for item in manifest["entities"] if item["componentType"] == "bearingBlock")
    raised_meshes[bearing["entityId"]].apply_translation([0, 0, 100])
    cases.append(_expect_failure("bearingSupportDisplacement", lambda: _verify_support_contacts(fixture, manifest, raised_meshes)))

    penetrated_meshes = {key: value.copy() for key, value in meshes.items()}
    penetrated_meshes[bearing["entityId"]].apply_translation([0, 0, -100])
    cases.append(_expect_failure("bearingSupportPenetration", lambda: _verify_support_contacts(fixture, manifest, penetrated_meshes)))

    shifted_meshes = {key: value.copy() for key, value in meshes.items()}
    shifted_meshes[bearing["entityId"]].apply_translation([0, 50, 0])
    cases.append(_expect_failure("bearingLateralMisalignment", lambda: _verify_support_contacts(fixture, manifest, shifted_meshes)))

    post_shifted_meshes = {key: value.copy() for key, value in meshes.items()}
    interior_post = next(item for item in manifest["entities"] if item["componentType"] == "interiorPost")
    post_shifted_meshes[interior_post["entityId"]].apply_translation([0, 50, 0])
    cases.append(_expect_failure("grooveLateralMisalignment", lambda: _verify_support_contacts(fixture, manifest, post_shifted_meshes)))

    ridge_meshes = {key: value.copy() for key, value in meshes.items()}
    ridge = next(item for item in manifest["entities"] if item["componentType"] == "ridgeTile")
    bounds = ridge_meshes[ridge["entityId"]].bounds
    replacement = trimesh.creation.box(extents=np.ptp(bounds, axis=0))
    replacement.apply_translation(np.mean(bounds, axis=0))
    ridge_meshes[ridge["entityId"]] = replacement
    cases.append(_expect_failure("ridgeBoxReplacement", lambda: _verify_component_features(fixture, manifest, ridge_meshes)))

    curve_meshes = {key: value.copy() for key, value in meshes.items()}
    for board in (item for item in manifest["entities"] if item["componentType"] == "roofBoard"):
        curve_meshes[board["entityId"]].apply_translation([0, 0, 20])
    cases.append(_expect_failure("roofCurveDisplacement", lambda: _verify_roof_curve(fixture, manifest, curve_meshes)))

    coverage_meshes = {key: value.copy() for key, value in meshes.items()}
    for entity in manifest["entities"]:
        if entity["componentType"] in {"panTile", "coverTile"}:
            bounds = coverage_meshes[entity["entityId"]].bounds
            if bounds[0, 0] <= 0 <= bounds[1, 0] and bounds[0, 1] <= -1000 <= bounds[1, 1]:
                coverage_meshes[entity["entityId"]].apply_translation([0, 0, -1000])
    cases.append(_expect_failure("missingTileCoverage", lambda: _verify_roof_coverage(fixture, manifest, coverage_meshes)))
    return cases


def verify_geometry(fixture_path: Path, manifest_path: Path, source_meshes_path: Path, glb_path: Path) -> dict:
    fixture, manifest, source_meshes, meshes = _load_inputs(fixture_path, manifest_path, source_meshes_path, glb_path)
    checks = [
        _verify_identity_and_meshes(fixture, manifest, source_meshes, meshes),
        _verify_sources(fixture, manifest),
        _verify_roof_curve(fixture, manifest, meshes),
        _verify_roof_coverage(fixture, manifest, meshes),
        _verify_component_features(fixture, manifest, meshes),
        _verify_tile_laps(fixture, manifest, meshes),
        _verify_support_contacts(fixture, manifest, meshes),
        _verify_numeric_oracle(fixture, manifest, meshes),
    ]
    negative_cases = _run_negative_cases(fixture, manifest, source_meshes, meshes)
    return {
        "schemaVersion": "t0b-v2-geometry-verification-3",
        "status": "passed-geometry-only",
        "qualification": {
            "localProfessionalSampleEligible": False,
            "reason": "visible-line projection, drawing generation and independent professional review are pending",
        },
        "verifier": {
            "name": VERIFIER_NAME,
            "version": VERIFIER_VERSION,
            "implementationSha256": _file_hash(Path(__file__).resolve()),
            "implementation": "standalone; does not import GeometryBuilder or geometry helpers",
            "command": "python -m workers.cad.t0b_v2.verify_geometry --fixture <fixture> --manifest <manifest> --source-meshes <source-meshes> --glb <glb> --report <report>",
        },
        "inputs": {
            "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
            "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            "glb": {"path": glb_path.name, "sha256": _file_hash(glb_path)},
        },
        "checks": checks,
        "negativeCases": negative_cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify T0-B v2 semantic geometry outputs.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--glb", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = verify_geometry(args.fixture, args.manifest, args.source_meshes, args.glb)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
