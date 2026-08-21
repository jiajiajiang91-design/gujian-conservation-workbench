from __future__ import annotations

from collections import Counter
from copy import deepcopy
from hashlib import sha256
import itertools
import json

import numpy as np
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Polygon, box
from shapely.ops import polygonize_full, unary_union
import trimesh

try:
    from .verify_projections import _expected_lines
    from .verify_sections import _selection
except ImportError:  # pragma: no cover - direct verifier execution
    from workers.cad.t0b_v2.verify_projections import _expected_lines
    from workers.cad.t0b_v2.verify_sections import _selection


DETAIL_VIEW_IDS = ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail")
MATERIAL_HATCH = {"stone-demo": "stone", "timber-demo": "timber", "earth-demo": "earth", "ceramic-demo": "ceramic"}


def detail_target_types(view: dict) -> set[str]:
    detail = view["detail"]
    if detail["mode"] == "section-projection":
        return set(detail["cutTargetTypes"]) | set(detail["depthProjectionTypes"])
    return set(detail["visibleProjectionTypes"])


def _filtered_manifest(view: dict, manifest: dict) -> dict:
    allowed = detail_target_types(view)
    return {**manifest, "entities": [entity for entity in manifest["entities"] if entity["componentType"] in allowed]}


def detail_selection(view: dict, manifest: dict) -> list[str]:
    return _selection(view, _filtered_manifest(view, manifest))


def _entity_set_hash(entity_ids: list[str] | set[str]) -> str:
    return sha256("\n".join(sorted(entity_ids)).encode("utf-8")).hexdigest()


def _canonical_pair(first: np.ndarray, second: np.ndarray) -> tuple[list[float], list[float]]:
    start = [round(float(value), 3) for value in first]
    end = [round(float(value), 3) for value in second]
    return (start, end) if tuple(start) <= tuple(end) else (end, start)


def _canonical_ring(points) -> list[list[float]]:
    values = [[round(float(value), 3) for value in point] for point in points]
    if values[0] == values[-1]:
        values.pop()
    if not values:
        return []
    rotations = []
    for sequence in (values, list(reversed(values))):
        for index in range(len(sequence)):
            rotations.append(sequence[index:] + sequence[:index])
    result = min(rotations)
    return result + [result[0]]


def _line_parts(geometry) -> list[LineString]:
    if geometry.is_empty:
        return []
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, (MultiLineString, GeometryCollection)):
        result: list[LineString] = []
        for part in geometry.geoms:
            result.extend(_line_parts(part))
        return result
    return []


def _polygon_parts(geometry) -> list[Polygon]:
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, (MultiPolygon, GeometryCollection)):
        result: list[Polygon] = []
        for part in geometry.geoms:
            result.extend(_polygon_parts(part))
        return result
    return []


def _section_materials(view: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    detail = view["detail"]
    section = detail["section"]
    frame = view["viewFrame"]
    origin = np.asarray(section["planeOrigin"], dtype=float)
    normal = np.asarray(section["planeNormal"], dtype=float)
    right = np.asarray(frame["right"], dtype=float)
    up = np.asarray(frame["up"], dtype=float)
    clip = box(*frame["clipRectMm"])
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    selected = detail_selection(view, manifest)
    cut_types = set(detail["cutTargetTypes"])
    raw_regions: list[dict] = []
    cut_segments: list[tuple] = []
    open_or_dangle = 0

    for entity_id in selected:
        entity = metadata[entity_id]
        if entity["componentType"] not in cut_types:
            continue
        segments = trimesh.intersections.mesh_plane(meshes[entity_id], normal, origin)
        full_lines: list[LineString] = []
        for segment in segments:
            start = np.asarray([np.dot(segment[0] - origin, right), np.dot(segment[0] - origin, up)], dtype=float)
            end = np.asarray([np.dot(segment[1] - origin, right), np.dot(segment[1] - origin, up)], dtype=float)
            first, last = _canonical_pair(start, end)
            if first == last:
                continue
            full_lines.append(LineString([first, last]))
            for part in _line_parts(LineString([first, last]).intersection(clip)):
                coordinates = list(part.coords)
                clipped_first, clipped_last = _canonical_pair(np.asarray(coordinates[0]), np.asarray(coordinates[-1]))
                if clipped_first != clipped_last:
                    cut_segments.append((entity_id, entity["componentType"], clipped_first, clipped_last))
        if not full_lines:
            continue
        polygons, cuts, dangles, invalid = polygonize_full(unary_union(full_lines))
        open_or_dangle += len(cuts.geoms) + len(dangles.geoms) + len(invalid.geoms)
        for polygon in polygons.geoms:
            for clipped_polygon in _polygon_parts(polygon.intersection(clip)):
                if clipped_polygon.area <= 0.001:
                    continue
                raw_regions.append(
                    {
                        "sourceEntityId": entity_id,
                        "sourceComponentType": entity["componentType"],
                        "materialId": entity["materialId"],
                        "materialCode": entity["materialCode"],
                        "materialHatch": MATERIAL_HATCH.get(entity["materialCode"]),
                        "geometry": clipped_polygon,
                    }
                )

    priority = detail["materialOverlapPriority"]
    priority_field = {"componentType": "sourceComponentType", "materialCode": "materialCode"}[priority["field"]]
    higher_priority = Polygon()
    resolved_geometry: dict[int, object] = {}
    for priority_value in priority["order"]:
        matching = [region for region in raw_regions if region[priority_field] == priority_value]
        for region in matching:
            resolved_geometry[id(region)] = region["geometry"].difference(higher_priority)
        if matching:
            higher_priority = unary_union([higher_priority, *(region["geometry"] for region in matching)])

    regions: list[dict] = []
    for region in raw_regions:
        geometry = resolved_geometry.get(id(region), region["geometry"])
        for part in _polygon_parts(geometry):
            if part.area <= 0.001:
                continue
            regions.append({**region, "geometry": part})

    material_geometries = {
        material_code: unary_union([region["geometry"] for region in regions if region["materialCode"] == material_code])
        for material_code in sorted({region["materialCode"] for region in regions})
    }
    maximum_overlap = 0.0
    material_items = list(material_geometries.items())
    for index, (_first_code, first_geometry) in enumerate(material_items):
        for _second_code, second_geometry in material_items[index + 1 :]:
            maximum_overlap = max(maximum_overlap, float(first_geometry.intersection(second_geometry).area))

    crop_boundary = clip.boundary
    crop_segments: list[tuple] = []
    for region in regions:
        intersection = region["geometry"].boundary.intersection(crop_boundary)
        for part in _line_parts(intersection):
            coordinates = list(part.coords)
            first, last = _canonical_pair(np.asarray(coordinates[0]), np.asarray(coordinates[-1]))
            if first != last:
                crop_segments.append((region["sourceEntityId"], region["sourceComponentType"], first, last))

    region_counts = Counter(region["sourceComponentType"] for region in regions)
    material_counts = {
        material_code: len(_polygon_parts(geometry))
        for material_code, geometry in material_geometries.items()
    }
    cut_entity_ids = {region["sourceEntityId"] for region in regions}
    segment_payload = json.dumps(sorted(cut_segments), separators=(",", ":"))
    crop_payload = json.dumps(sorted(crop_segments), separators=(",", ":"))
    return {
        "regions": regions,
        "cutSegments": sorted(cut_segments),
        "cropSegments": sorted(crop_segments),
        "cutEntitySetSha256": _entity_set_hash(cut_entity_ids),
        "cutSegmentSha256": sha256(segment_payload.encode("utf-8")).hexdigest(),
        "cropLimitSegmentSha256": sha256(crop_payload.encode("utf-8")).hexdigest(),
        "cropLimitSegmentCount": len(crop_segments),
        "cutClosedRegionCount": len(regions),
        "cutClosedRegionsByType": dict(sorted(region_counts.items())),
        "cutOpenOrDangleCount": open_or_dangle,
        "materialRegionsByCode": dict(sorted(material_counts.items())),
        "maximumMaterialOverlapAreaMm2": round(maximum_overlap, 6),
    }


def _projection_lines(view: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh], policy: dict) -> list[dict]:
    filtered_manifest = _filtered_manifest(view, manifest)
    projection_view = deepcopy(view)
    detail = projection_view["detail"]
    display_types = detail.get("visibleProjectionTypes", detail.get("depthProjectionTypes", []))
    projection_view["projection"] = {"displayTypes": display_types}
    lines = _expected_lines(projection_view, filtered_manifest, meshes, policy)
    if detail["mode"] == "section-projection":
        tolerance = float(detail["section"]["cutToleranceMm"])
        lines = [line for line in lines if max(point[2] for point in line["sourcePointsViewMm"]) > tolerance]
    return lines


def _normalized_lines(cut_segments: list[tuple], projection_lines: list[dict]) -> list[tuple]:
    records: list[tuple] = []
    cut_keys: set[tuple] = set()
    for entity_id, component_type, first, last in cut_segments:
        key = (tuple(first), tuple(last))
        cut_keys.add(key)
        records.append((entity_id, component_type, "planeIntersection.cut", "cut", [first, last], None))
    for line in projection_lines:
        key = tuple(tuple(point) for point in line["pointsMm"])
        if key in cut_keys:
            continue
        records.append(
            (
                line["sourceEntityId"],
                line["sourceComponentType"],
                "detail.depthProjection" if cut_segments else "detail.visibleLineProjection",
                line["lineClass"],
                line["pointsMm"],
                line["sourcePointsViewMm"],
            )
        )
    return sorted(records, key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))


def detail_oracle(view: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh], policy: dict) -> dict:
    selected = detail_selection(view, manifest)
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    selection_types = sorted({metadata[entity_id]["componentType"] for entity_id in selected})
    section_result = _section_materials(view, manifest, meshes) if view["detail"]["mode"] == "section-projection" else None
    projection_lines = _projection_lines(view, manifest, meshes, policy)
    cut_segments = section_result["cutSegments"] if section_result else []
    line_records = _normalized_lines(cut_segments, projection_lines)
    line_sources = sorted({record[0] for record in line_records})
    points = [point for record in line_records for point in record[4]]
    if not points:
        raise ValueError(f"{view['id']} independent detail oracle produced no structural lines")
    bounds = [
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    ]
    result = {
        "selectionCountDiagnostic": len(selected),
        "selectionEntitySetSha256": _entity_set_hash(selected),
        "selectionTypes": selection_types,
        "visibleLineSetSha256": sha256(json.dumps(line_records, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "requiredVisibleEntityIds": line_sources,
        "viewBounds2dMm": [round(float(value), 3) for value in bounds],
        "visibleLineCountDiagnostic": len(line_records),
    }
    if section_result:
        result.update({key: value for key, value in section_result.items() if key not in {"regions", "cutSegments", "cropSegments"}})
    return result


def detail_oracles(fixture: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict[str, dict]:
    views = {view["id"]: view for view in fixture["views"]}
    policy = fixture["drawingRequirements"]["projectionPolicy"]
    return {view_id: detail_oracle(views[view_id], manifest, meshes, policy) for view_id in DETAIL_VIEW_IDS}
