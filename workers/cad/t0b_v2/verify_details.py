from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import gzip
from hashlib import sha256
import itertools
import json
import math
from pathlib import Path
import re
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Polygon, box
from shapely.ops import polygonize_full, unary_union
import trimesh

try:
    from .verify_projections import _expected_lines
except ImportError:  # pragma: no cover - direct execution
    from workers.cad.t0b_v2.verify_projections import _expected_lines


VERIFIER_VERSION = "1.0.0"
DETAIL_VIEW_IDS = ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail")
LINE_NAMESPACE = UUID("f2557e7f-8aec-56df-80de-57873fb48c7e")
REGION_NAMESPACE = UUID("2db3c952-3453-5d69-9efe-e7fda07997d8")
GEOMETRY_REVISION_NAMESPACE = UUID("1f321b7d-38a4-5b48-8a82-353bc6298225")
VIEW_CONTRACT_REVISION_NAMESPACE = UUID("7f53de29-8c75-5f46-a7bf-75c69cc967a0")
MATERIAL_HATCH = {
    "stone-demo": "stone",
    "timber-demo": "timber",
    "earth-demo": "earth",
    "ceramic-demo": "ceramic",
}
FORBIDDEN_MARKERS = (".dwg", "file:", "http://", "https://", "\\downloads\\", "/downloads/")


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_hash(value) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _entity_set_hash(entity_ids) -> str:
    return sha256("\n".join(sorted(entity_ids)).encode("utf-8")).hexdigest()


def _load_output(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


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
    triangle_records = [
        sorted(tuple(float(value) for value in vertices[index]) for index in face)
        for face in np.asarray(mesh.faces, dtype=int)
    ]
    payload = {"vertices": vertex_records, "triangles": sorted(triangle_records)}
    return _stable_hash(payload)


def _walk_strings(value, path: tuple[str, ...] = ()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _walk_strings(item, (*path, str(key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _walk_strings(item, (*path, str(index)))
    elif isinstance(value, str):
        yield path, value


def _assert_reference_isolation(value, label: str) -> None:
    drive_path = re.compile(r"^[a-zA-Z]:[\\/]")
    hex_hash = re.compile(r"^[0-9a-fA-F]{64}$")
    for path, text in _walk_strings(value):
        lowered = text.lower()
        if any(marker in lowered for marker in FORBIDDEN_MARKERS) or drive_path.match(text):
            raise ValueError(f"{label} contains an external CAD or absolute-path dependency at {'.'.join(path)}")
        key = path[-1].lower() if path else ""
        if hex_hash.fullmatch(text) and any(token in key for token in ("external", "dependency", "reference", "probe")):
            raise ValueError(f"{label} contains an injected external dependency hash at {'.'.join(path)}")


def _sanitized_generation_input(fixture: dict) -> dict:
    contract = deepcopy(
        {
            "geometryRevisionId": fixture["geometryRevisionId"],
            "viewContractRevisionId": fixture["viewContractRevisionId"],
            "views": fixture["views"],
            "drawingSheets": fixture["drawingSheets"],
            "drawingRequirements": fixture["drawingRequirements"],
        }
    )
    _assert_reference_isolation(contract, "sanitized detail generation input")
    if "knownAnswers" in contract or "viewOracle" in contract:
        raise ValueError("sanitized detail generation input contains frozen answers")
    signature_payload = {
        "geometryRevisionId": contract["geometryRevisionId"],
        "views": contract["views"],
        "drawingSheets": contract["drawingSheets"],
        "drawingRequirements": contract["drawingRequirements"],
    }
    signature = _stable_hash(signature_payload)
    if signature != fixture.get("viewContractSignature"):
        raise ValueError("view contract signature differs from the sanitized generation input")
    if str(uuid5(VIEW_CONTRACT_REVISION_NAMESPACE, signature)) != contract["viewContractRevisionId"]:
        raise ValueError("view contract revision does not derive from the sanitized generation input")
    return contract


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
    expected_identity = {
        "schemaVersion": "t0b-v2-geometry-1",
        "projectId": fixture["projectId"],
        "fixtureId": fixture["fixtureId"],
        "geometryRevisionId": fixture["geometryRevisionId"],
        "unit": fixture["unit"],
        "producerType": "demo",
        "sourceRefs": fixture["sourceRefs"],
    }
    if any(manifest.get(key) != expected for key, expected in expected_identity.items()):
        raise ValueError("manifest identity differs from the frozen demo fixture")
    if fixture.get("referenceIsolation") != {
        "fixtureOnly": True,
        "allowedSourceSchemes": ["demo"],
        "externalAssetsAllowed": False,
    }:
        raise ValueError("fixture reference isolation is not demo-only")
    _assert_reference_isolation(fixture, "fixture")
    _assert_reference_isolation(manifest, "manifest")
    if not fixture.get("sourceRefs") or not all(item.startswith("demo:") for item in fixture["sourceRefs"]):
        raise ValueError("fixture source scheme is outside the demo boundary")

    entities = manifest.get("entities", [])
    entity_ids = [entity.get("entityId") for entity in entities]
    if None in entity_ids or len(entity_ids) != len(set(entity_ids)) or set(entity_ids) != set(meshes):
        raise ValueError("manifest and source mesh entity closures differ")
    for entity in entities:
        entity_id = entity["entityId"]
        if not entity.get("sourceRefs") or not all(item.startswith("demo:") for item in entity["sourceRefs"]):
            raise ValueError(f"entity {entity_id} is outside the demo source boundary")
        mesh = meshes[entity_id]
        if entity.get("meshHashPrecisionMm") != 0.001 or _canonical_mesh_hash(mesh) != entity.get("meshHash"):
            raise ValueError(f"source mesh hash differs for {entity_id}")
        if len(mesh.vertices) != int(entity.get("vertices", -1)) or len(mesh.faces) != int(entity.get("faces", -1)):
            raise ValueError(f"source mesh topology differs for {entity_id}")

    closure_payload = sorted((entity["entityId"], entity.get("exportMeshHash")) for entity in entities)
    if sha256(json.dumps(closure_payload, separators=(",", ":")).encode("utf-8")).hexdigest() != manifest.get("exportClosureHash"):
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
    geometry_signature = _stable_hash({"entities": signature_entities, "relations": signature_relations})
    if geometry_signature != manifest.get("geometrySignature"):
        raise ValueError("manifest semantic geometry signature is invalid")
    if str(uuid5(GEOMETRY_REVISION_NAMESPACE, geometry_signature)) != fixture["geometryRevisionId"]:
        raise ValueError("geometry revision does not derive from the independent semantic signature")


def _canonical_pair(first, second, precision: int = 3) -> tuple[list[float], list[float]]:
    start = [round(float(value), precision) for value in first]
    end = [round(float(value), precision) for value in second]
    return (start, end) if tuple(start) <= tuple(end) else (end, start)


def _canonical_ring(points, precision: int = 9) -> list[list[float]]:
    values = [[round(float(value), precision) for value in point] for point in points]
    if values and values[0] == values[-1]:
        values.pop()
    if not values:
        return []
    candidates = []
    for sequence in (values, list(reversed(values))):
        for index in range(len(sequence)):
            candidates.append(sequence[index:] + sequence[:index])
    result = min(candidates)
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


def _selection(view: dict, manifest: dict, allowed_types: set[str]) -> list[str]:
    frame = view["viewFrame"]
    origin = np.asarray(frame["origin"], dtype=float)
    axes = [np.asarray(frame[name], dtype=float) for name in ("right", "up", "depth")]
    low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], frame["clipDepthMm"][0]], dtype=float)
    high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], frame["clipDepthMm"][1]], dtype=float)
    result: list[str] = []
    for entity in manifest["entities"]:
        if entity["componentType"] not in allowed_types:
            continue
        bounds = np.asarray(entity["bounds"], dtype=float)
        corners = np.asarray(list(itertools.product(*[(bounds[0, index], bounds[1, index]) for index in range(3)])))
        coordinates = np.column_stack(tuple((corners - origin) @ axis for axis in axes))
        if np.any(coordinates.max(axis=0) < low) or np.any(coordinates.min(axis=0) > high):
            continue
        result.append(entity["entityId"])
    return sorted(result)


def _line_id(revision: str, view_id: str, entity_id: str, derivation: str, line_class: str, points) -> str:
    payload = json.dumps([revision, view_id, entity_id, derivation, line_class, points], separators=(",", ":"))
    return str(uuid5(LINE_NAMESPACE, payload))


def _region_id(revision: str, view_id: str, entity_id: str, outer, holes) -> str:
    payload = json.dumps([revision, view_id, entity_id, outer, holes], separators=(",", ":"))
    return str(uuid5(REGION_NAMESPACE, payload))


def _independent_projection(view: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh], policy: dict) -> list[dict]:
    detail = view["detail"]
    allowed = set(detail.get("visibleProjectionTypes", detail.get("depthProjectionTypes", [])))
    filtered_manifest = {**manifest, "entities": [item for item in manifest["entities"] if item["componentType"] in allowed]}
    projection_view = deepcopy(view)
    projection_view["projection"] = {"displayTypes": sorted(allowed)}
    lines = _expected_lines(projection_view, filtered_manifest, meshes, policy)
    if detail["mode"] == "section-projection":
        section = detail["section"]
        cut_tolerance = float(section["cutToleranceMm"])
        retained_low, retained_high = map(float, section["retainedProjectionDepthMm"])
        padding = float(section["allowedPaddingMm"])
        lines = [
            line
            for line in lines
            if max(point[2] for point in line["sourcePointsViewMm"]) > max(cut_tolerance, retained_low)
            and min(point[2] for point in line["sourcePointsViewMm"]) <= retained_high + padding
        ]
    derivation = "detail.depthProjection" if detail["mode"] == "section-projection" else "detail.visibleLineProjection"
    result = []
    for line in lines:
        record = {
            "sourceEntityId": line["sourceEntityId"],
            "sourceComponentType": line["sourceComponentType"],
            "derivation": derivation,
            "lineClass": line["lineClass"],
            "pointsMm": line["pointsMm"],
            "sourcePointsViewMm": line["sourcePointsViewMm"],
        }
        record["lineId"] = _line_id(
            view["viewContractRevisionId"], view["id"], record["sourceEntityId"], derivation, record["lineClass"], record["pointsMm"]
        )
        result.append(record)
    return sorted(result, key=lambda item: item["lineId"])


def _independent_section(view: dict, selected: list[str], manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    detail = view["detail"]
    section = detail["section"]
    frame = view["viewFrame"]
    origin = np.asarray(section["planeOrigin"], dtype=float)
    normal = np.asarray(section["planeNormal"], dtype=float)
    right = np.asarray(frame["right"], dtype=float)
    up = np.asarray(frame["up"], dtype=float)
    clip = box(*frame["clipRectMm"])
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    cut_types = set(detail["cutTargetTypes"])
    raw_regions: list[dict] = []
    raw_segments: list[tuple] = []
    open_count = 0

    for entity_id in selected:
        entity = metadata[entity_id]
        if entity["componentType"] not in cut_types:
            continue
        segments = trimesh.intersections.mesh_plane(meshes[entity_id], normal, origin)
        full_lines: list[LineString] = []
        for segment in segments:
            first = [np.dot(segment[0] - origin, right), np.dot(segment[0] - origin, up)]
            second = [np.dot(segment[1] - origin, right), np.dot(segment[1] - origin, up)]
            start, end = _canonical_pair(first, second)
            if start == end:
                continue
            line = LineString([start, end])
            full_lines.append(line)
            for clipped in _line_parts(line.intersection(clip)):
                clipped_start, clipped_end = _canonical_pair(clipped.coords[0], clipped.coords[-1])
                if clipped_start != clipped_end:
                    raw_segments.append((entity_id, entity["componentType"], clipped_start, clipped_end))
        if not full_lines:
            continue
        polygons, cuts, dangles, invalid = polygonize_full(unary_union(full_lines))
        open_count += len(cuts.geoms) + len(dangles.geoms) + len(invalid.geoms)
        for polygon in polygons.geoms:
            for part in _polygon_parts(polygon.intersection(clip)):
                if part.area <= 0.001:
                    continue
                raw_regions.append(
                    {
                        "sourceEntityId": entity_id,
                        "sourceComponentType": entity["componentType"],
                        "materialId": entity["materialId"],
                        "materialCode": entity["materialCode"],
                        "materialHatch": MATERIAL_HATCH.get(entity["materialCode"]),
                        "geometry": part,
                    }
                )

    priority = detail["materialOverlapPriority"]
    field = {"componentType": "sourceComponentType", "materialCode": "materialCode"}[priority["field"]]
    higher_priority = Polygon()
    resolved: dict[int, object] = {}
    for value in priority["order"]:
        matching = [region for region in raw_regions if region[field] == value]
        for region in matching:
            resolved[id(region)] = region["geometry"].difference(higher_priority)
        if matching:
            higher_priority = unary_union([higher_priority, *(region["geometry"] for region in matching)])

    region_records: list[dict] = []
    region_geometries: list[tuple[dict, Polygon]] = []
    for region in raw_regions:
        for part in _polygon_parts(resolved.get(id(region), region["geometry"])):
            if part.area <= 0.001:
                continue
            outer = _canonical_ring(part.exterior.coords)
            holes = [_canonical_ring(ring.coords) for ring in part.interiors]
            region_records.append(
                {
                    "regionId": _region_id(view["viewContractRevisionId"], view["id"], region["sourceEntityId"], outer, holes),
                    "sourceEntityId": region["sourceEntityId"],
                    "sourceComponentType": region["sourceComponentType"],
                    "materialId": region["materialId"],
                    "materialCode": region["materialCode"],
                    "materialHatch": region["materialHatch"],
                    "outerMm": outer,
                    "holesMm": holes,
                    "areaMm2": round(float(part.area), 3),
                }
            )
            region_geometries.append((region, part))

    line_occurrences: Counter[tuple] = Counter()
    cut_records = []
    for entity_id, component_type, first, last in sorted(raw_segments):
        key = (entity_id, component_type, tuple(first), tuple(last))
        occurrence = line_occurrences[key]
        line_occurrences[key] += 1
        id_derivation = "planeIntersection.cut" if occurrence == 0 else f"planeIntersection.cut#{occurrence}"
        cut_records.append(
            {
                "lineId": _line_id(view["viewContractRevisionId"], view["id"], entity_id, id_derivation, "cut", [first, last]),
                "sourceEntityId": entity_id,
                "sourceComponentType": component_type,
                "derivation": "planeIntersection.cut",
                "lineClass": "cut",
                "pointsMm": [first, last],
            }
        )

    crop_records = []
    for region, geometry in region_geometries:
        for part in _line_parts(geometry.boundary.intersection(clip.boundary)):
            first, last = _canonical_pair(part.coords[0], part.coords[-1])
            if first == last:
                continue
            crop_records.append(
                {
                    "lineId": _line_id(view["viewContractRevisionId"], view["id"], region["sourceEntityId"], "detail.cropLimit", "cropLimit", [first, last]),
                    "sourceEntityId": region["sourceEntityId"],
                    "sourceComponentType": region["sourceComponentType"],
                    "derivation": "detail.cropLimit",
                    "lineClass": "cropLimit",
                    "pointsMm": [first, last],
                }
            )

    material_geometries = {
        code: unary_union([geometry for region, geometry in region_geometries if region["materialCode"] == code])
        for code in sorted({region["materialCode"] for region, _geometry in region_geometries})
    }
    maximum_overlap = 0.0
    items = list(material_geometries.items())
    for index, (_first_code, first_geometry) in enumerate(items):
        for _second_code, second_geometry in items[index + 1 :]:
            maximum_overlap = max(maximum_overlap, float(first_geometry.intersection(second_geometry).area))
    cut_sources = sorted({region["sourceEntityId"] for region, _geometry in region_geometries})
    return {
        "cutLines": sorted(cut_records, key=lambda item: item["lineId"]),
        "materialRegions": sorted(region_records, key=lambda item: item["regionId"]),
        "cropLimitLines": sorted(crop_records, key=lambda item: item["lineId"]),
        "statistics": {
            "cutSourceCount": len(cut_sources),
            "cutEntitySetSha256": _entity_set_hash(cut_sources),
            "cutRegionCount": len(region_records),
            "cutRegionCountByType": dict(sorted(Counter(item["sourceComponentType"] for item in region_records).items())),
            "materialRegionCountByCode": {
                code: len(_polygon_parts(geometry)) for code, geometry in material_geometries.items()
            },
            "maximumMaterialOverlapAreaMm2": round(maximum_overlap, 6),
            "cutLineCount": len(cut_records),
            "cropLimitLineCount": len(crop_records),
            "openOrDangleCount": open_count,
        },
    }


def _core_line(line: dict, projection: bool) -> dict:
    record = {
        "lineId": line.get("lineId"),
        "sourceEntityId": line.get("sourceEntityId"),
        "sourceComponentType": line.get("sourceComponentType"),
        "derivation": line.get("derivation"),
        "lineClass": line.get("lineClass"),
        "pointsMm": line.get("pointsMm"),
    }
    if projection:
        record["sourcePointsViewMm"] = line.get("sourcePointsViewMm")
    return record


def _core_region(region: dict) -> dict:
    return {
        "regionId": region.get("regionId"),
        "sourceEntityId": region.get("sourceEntityId"),
        "sourceComponentType": region.get("sourceComponentType"),
        "materialId": region.get("materialId"),
        "materialCode": region.get("materialCode"),
        "materialHatch": region.get("materialHatch"),
        "outerMm": region.get("outerMm"),
        "holesMm": region.get("holesMm"),
        "areaMm2": region.get("areaMm2"),
    }


def _record(checks: list[dict], name: str, actual, expected) -> None:
    checks.append({"name": name, "passed": actual == expected, "actual": actual, "expected": expected})


def _record_shape_valid(output: dict, view: dict, metadata: dict[str, dict]) -> bool:
    allowed_line_classes = {"cut", "silhouette", "componentBoundary", "feature", "cropLimit"}
    seen_ids: set[str] = set()
    for group, projection, structural in (
        (output.get("cutLines", []), False, True),
        (output.get("projectionLines", []), True, True),
        (output.get("cropLimitLines", []), False, False),
    ):
        for line in group:
            line_id = line.get("lineId")
            entity = metadata.get(line.get("sourceEntityId"))
            if (
                not isinstance(line_id, str)
                or line_id in seen_ids
                or entity is None
                or line.get("sourceComponentType") != entity["componentType"]
                or line.get("viewId") != view["id"]
                or line.get("geometryRevisionId") != view["geometryRevisionId"]
                or line.get("viewContractRevisionId") != view["viewContractRevisionId"]
                or line.get("derivationTransform") != view["viewFrame"]["modelToView"]
                or line.get("visibility") != "visible"
                or line.get("closed") is not False
                or line.get("lineClass") not in allowed_line_classes
                or not isinstance(line.get("pointsMm"), list)
                or len(line["pointsMm"]) != 2
            ):
                return False
            if projection and line.get("pointsMm") != [point[:2] for point in line.get("sourcePointsViewMm", [])]:
                return False
            if not structural and line.get("structural") is not False:
                return False
            seen_ids.add(line_id)
    for region in output.get("materialRegions", []):
        entity = metadata.get(region.get("sourceEntityId"))
        if (
            entity is None
            or region.get("sourceComponentType") != entity["componentType"]
            or region.get("materialId") != entity["materialId"]
            or region.get("materialCode") != entity["materialCode"]
            or region.get("materialHatch") != MATERIAL_HATCH.get(entity["materialCode"])
            or region.get("viewId") != view["id"]
            or region.get("geometryRevisionId") != view["geometryRevisionId"]
            or region.get("viewContractRevisionId") != view["viewContractRevisionId"]
            or region.get("regionId") != _region_id(
                view["viewContractRevisionId"], view["id"], region["sourceEntityId"], region.get("outerMm"), region.get("holesMm")
            )
        ):
            return False
    return True


def _depth_semantics_valid(view: dict, output: dict) -> bool:
    frame = view["viewFrame"]
    clip_low, clip_high = map(float, frame["clipDepthMm"])
    for line in output.get("projectionLines", []):
        for point in line.get("sourcePointsViewMm", []):
            if not (clip_low - 0.001 <= float(point[2]) <= clip_high + 0.001):
                return False
    detail = view["detail"]
    if detail["mode"] != "section-projection":
        return True
    section = detail["section"]
    cut_tolerance = float(section["cutToleranceMm"])
    if section["cutSourceDepthMm"] != [-cut_tolerance, cut_tolerance]:
        return False
    retained_low, retained_high = map(float, section["retainedProjectionDepthMm"])
    padding = float(section["allowedPaddingMm"])
    if retained_low != cut_tolerance or retained_high > clip_high + padding or retained_low < clip_low:
        return False
    for line in output.get("projectionLines", []):
        depths = [float(point[2]) for point in line["sourcePointsViewMm"]]
        if max(depths) <= retained_low or min(depths) > retained_high + padding:
            return False
    crop = np.asarray(detail["cropBoundsModelMm"], dtype=float)
    origin = np.asarray(frame["origin"], dtype=float)
    axes = [np.asarray(frame[name], dtype=float) for name in ("right", "up", "depth")]
    corners = np.asarray(list(itertools.product(*[(crop[0, index], crop[1, index]) for index in range(3)])))
    projected = np.column_stack(tuple((corners - origin) @ axis for axis in axes))
    projected_rect = [projected[:, 0].min(), projected[:, 1].min(), projected[:, 0].max(), projected[:, 1].max()]
    if not np.allclose(projected_rect, frame["clipRectMm"], atol=0.001):
        return False
    actual_depths = [point[2] for line in output.get("projectionLines", []) for point in line.get("sourcePointsViewMm", [])]
    if actual_depths and (min(actual_depths) < projected[:, 2].min() - padding or max(actual_depths) > projected[:, 2].max() + padding):
        return False
    return True


def _visible_sources(path: Path) -> set[str]:
    output = _load_output(path)
    return {
        line["sourceEntityId"]
        for line in [*output.get("cutLines", []), *output.get("projectionLines", [])]
        if isinstance(line.get("sourceEntityId"), str)
    }


def _continuation_sources(outputs_root: Path) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for directory in (outputs_root / "details", outputs_root / "sections", outputs_root / "projections"):
        if not directory.exists():
            continue
        for path in directory.glob("*.view-geometry.json.gz"):
            result[path.name.split(".")[0]] = _visible_sources(path)
    return result


def _relations_valid(view_id: str, visible: set[str], fixture: dict, manifest: dict, continuations: dict[str, set[str]]) -> bool:
    answer = fixture["knownAnswers"]["viewOracle"]["views"][view_id]
    relation_set = {
        (item.get("fromEntityId"), item.get("relation"), item.get("toEntityId"))
        for item in manifest.get("relations", [])
    }
    for chain in answer.get("requiredEntityChains", {}).values():
        for relation in chain:
            endpoints = {relation["fromEntityId"], relation["toEntityId"]}
            if (relation["fromEntityId"], relation["relation"], relation["toEntityId"]) not in relation_set:
                return False
            if relation["relationScope"] == "inView":
                if not endpoints <= visible or set(relation) != {"fromEntityId", "relation", "toEntityId", "relationScope"}:
                    return False
            elif relation["relationScope"] == "crossViewContext":
                external = relation.get("externalEndpointEntityId")
                continuation = relation.get("continuationViewId")
                if (
                    external not in endpoints
                    or external in visible
                    or not (endpoints - {external}) <= visible
                    or external not in continuations.get(continuation, set())
                ):
                    return False
            else:
                return False
    return True


def _door_topology(fixture: dict, selected: list[str], metadata: dict[str, dict]) -> dict:
    selected_entities = [metadata[entity_id] for entity_id in selected]
    leaves = sum(entity["componentType"] == "doorLeaf" for entity in selected_entities)
    windows = sum(entity["componentType"] == "latticeWindow" for entity in selected_entities)
    leaf_parameters = fixture["componentTemplates"]["doorLeaf"]["parameters"]
    lattice_parameters = fixture["componentTemplates"]["latticeWindow"]["parameters"]
    return {
        "doorLeaves": leaves,
        "doorPanels": leaves * int(leaf_parameters["panels"]),
        "latticeWindows": windows,
        "latticeCells": windows * int(lattice_parameters["rows"]) * int(lattice_parameters["columns"]),
    }


def verify_details(
    fixture_path: Path,
    manifest_path: Path,
    source_meshes_path: Path,
    details_dir: Path,
    view_ids: tuple[str, ...] = DETAIL_VIEW_IDS,
    context_outputs_root: Path | None = None,
) -> dict:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    contract = _sanitized_generation_input(fixture)
    header, meshes = _load_sources(source_meshes_path)
    _verify_source_closure(fixture, manifest, header, meshes)
    if fixture["knownAnswers"].get("sourceMeshBundleSha256") != _file_hash(source_meshes_path):
        raise ValueError("source mesh bundle differs from the frozen oriented-topology hash")

    oracle = fixture["knownAnswers"]["viewOracle"]
    oracle_payload = {key: value for key, value in oracle.items() if key != "viewOracleSignature"}
    if oracle.get("viewOracleSignature") != _stable_hash(oracle_payload):
        raise ValueError("view oracle signature is invalid")
    views = {
        view["id"]: {**view, "viewContractRevisionId": contract["viewContractRevisionId"]}
        for view in contract["views"]
    }
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    policy = contract["drawingRequirements"]["projectionPolicy"]
    outputs_root = context_outputs_root or details_dir.parent
    continuations = _continuation_sources(outputs_root)
    checks: list[dict] = []
    output_records: list[dict] = []

    _record(
        checks,
        "sanitized generation input excludes frozen answers",
        sorted(contract),
        sorted({"geometryRevisionId", "viewContractRevisionId", "views", "drawingSheets", "drawingRequirements"}),
    )
    _record(checks, "external reference isolation", fixture["referenceIsolation"], {"fixtureOnly": True, "allowedSourceSchemes": ["demo"], "externalAssetsAllowed": False})

    for view_id in view_ids:
        if view_id not in DETAIL_VIEW_IDS:
            raise ValueError(f"unsupported detail view {view_id}")
        view = views[view_id]
        output_path = details_dir / f"{view_id}.view-geometry.json.gz"
        output = _load_output(output_path)
        _assert_reference_isolation(output, f"{view_id} output")
        output_records.append(
            {
                "viewId": view_id,
                "path": output_path.name,
                "sha256": _file_hash(output_path),
                "viewGeometrySha256": output.get("viewGeometrySha256"),
            }
        )
        expected_top = {
            "schemaVersion": "t0b-v2-detail-view-geometry-1",
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "L1": False,
            "viewId": view_id,
            "geometryRevisionId": contract["geometryRevisionId"],
            "viewContractRevisionId": contract["viewContractRevisionId"],
            "unit": "mm",
            "viewFrame": view["viewFrame"],
            "detail": view["detail"],
        }
        actual_top = {key: output.get(key) for key in expected_top}
        _record(checks, f"{view_id} top-level contract and qualification boundary", actual_top, expected_top)
        expected_keys = set(expected_top) | {"cutLines", "projectionLines", "materialRegions", "cropLimitLines", "statistics", "viewGeometrySha256"}
        _record(checks, f"{view_id} exact top-level schema", sorted(output), sorted(expected_keys))
        payload = dict(output)
        stored_hash = payload.pop("viewGeometrySha256", None)
        _record(checks, f"{view_id} output hash", stored_hash, _stable_hash(payload))

        detail = view["detail"]
        allowed_types = (
            set(detail["cutTargetTypes"]) | set(detail["depthProjectionTypes"])
            if detail["mode"] == "section-projection"
            else set(detail["visibleProjectionTypes"])
        )
        selected = _selection(view, manifest, allowed_types)
        expected_projection = _independent_projection(view, manifest, meshes, policy)
        expected_section = (
            _independent_section(view, selected, manifest, meshes)
            if detail["mode"] == "section-projection"
            else {"cutLines": [], "materialRegions": [], "cropLimitLines": [], "statistics": {}}
        )
        actual_cut = sorted((_core_line(item, False) for item in output.get("cutLines", [])), key=lambda item: item["lineId"])
        actual_projection = sorted((_core_line(item, True) for item in output.get("projectionLines", [])), key=lambda item: item["lineId"])
        actual_crop = sorted((_core_line(item, False) for item in output.get("cropLimitLines", [])), key=lambda item: item["lineId"])
        actual_regions = sorted((_core_region(item) for item in output.get("materialRegions", [])), key=lambda item: item["regionId"])
        _record(checks, f"{view_id} independent complete cut-line set", _stable_hash(actual_cut), _stable_hash(expected_section["cutLines"]))
        _record(checks, f"{view_id} independent complete visible-line and occlusion set", _stable_hash(actual_projection), _stable_hash(expected_projection))
        _record(checks, f"{view_id} independent complete material-region set", _stable_hash(actual_regions), _stable_hash(expected_section["materialRegions"]))
        _record(checks, f"{view_id} independent complete crop-limit set", _stable_hash(actual_crop), _stable_hash(expected_section["cropLimitLines"]))
        _record(checks, f"{view_id} trace, revision, transform and native record closure", _record_shape_valid(output, view, metadata), True)
        _record(checks, f"{view_id} retained-side and crop depth semantics", _depth_semantics_valid(view, output), True)

        structural_lines = [*output.get("cutLines", []), *output.get("projectionLines", [])]
        visible_sources = {line["sourceEntityId"] for line in structural_lines}
        visible_types = {line["sourceComponentType"] for line in structural_lines}
        expected_stats = {
            "selectedSourceCount": len(selected),
            "selectionEntitySetSha256": _entity_set_hash(selected),
            "structuralLineCount": len(expected_section["cutLines"]) + len(expected_projection),
            "structuralSourceCount": len({item["sourceEntityId"] for item in [*expected_section["cutLines"], *expected_projection]}),
            "structuralSourceEntitySetSha256": _entity_set_hash({item["sourceEntityId"] for item in [*expected_section["cutLines"], *expected_projection]}),
            "visibleProjectionLineCount": len(expected_projection),
            "structuralSourceTypes": sorted({item["sourceComponentType"] for item in [*expected_section["cutLines"], *expected_projection]}),
            **expected_section["statistics"],
        }
        _record(checks, f"{view_id} independently recomputed statistics", output.get("statistics"), expected_stats)
        _record(checks, f"{view_id} all structural sources allowed", visible_types <= allowed_types, True)

        anchor = metadata.get(detail["anchorEntityId"])
        anchor_valid = bool(
            anchor
            and anchor["componentType"] == detail["anchorComponentType"]
            and np.allclose(anchor["centroid"], detail["anchorCentroid"], atol=1e-6)
            and detail["anchorEntityId"] in visible_sources
        )
        if detail["mode"] == "section-projection":
            anchor_valid = anchor_valid and abs(float(np.dot(
                np.asarray(detail["anchorPoint"]) - np.asarray(detail["section"]["planeOrigin"]),
                np.asarray(detail["section"]["planeNormal"]),
            ))) <= float(detail["section"]["cutToleranceMm"])
        _record(checks, f"{view_id} anchor binds frozen source geometry", anchor_valid, True)
        _record(checks, f"{view_id} relation scope and continuation closure", _relations_valid(view_id, visible_sources, fixture, manifest, continuations), True)

        answer = oracle["views"][view_id]
        _record(checks, f"{view_id} independently derived visible sources", sorted(visible_sources), sorted(answer["requiredVisibleEntityIds"]))
        _record(checks, f"{view_id} forbidden entities absent", bool(set(answer.get("mustNotAppearEntityIds", [])) & visible_sources), False)
        _record(checks, f"{view_id} forbidden types absent", bool(set(answer.get("mustNotAppearTypes", [])) & visible_types), False)
        if view_id == "doorWindowDetail":
            _record(checks, "doorWindowDetail independent topology counts", _door_topology(fixture, selected, metadata), answer["topologyCounts"])

    build_record_path = details_dir / "detail-build-record.json"
    build_record = json.loads(build_record_path.read_text(encoding="utf-8"))
    _assert_reference_isolation(build_record, "detail build record")
    expected_build_outputs = [
        {
            "viewId": item["viewId"],
            "path": item["path"],
            "sha256": item["sha256"],
            "viewGeometrySha256": item["viewGeometrySha256"],
        }
        for item in output_records
    ]
    actual_build_outputs = [
        {key: item.get(key) for key in ("viewId", "path", "sha256", "viewGeometrySha256")}
        for item in build_record.get("outputs", [])
        if item.get("viewId") in view_ids
    ]
    _record(checks, "detail build record output closure", actual_build_outputs, expected_build_outputs)
    _record(
        checks,
        "detail build record qualification boundary",
        {key: build_record.get(key) for key in ("status", "qualification", "L1", "geometryRevisionId", "viewContractRevisionId")},
        {
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "L1": False,
            "geometryRevisionId": contract["geometryRevisionId"],
            "viewContractRevisionId": contract["viewContractRevisionId"],
        },
    )
    expected_inputs = {
        "generationContract": {"sha256": _stable_hash(contract)},
        "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
        "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
    }
    _record(checks, "detail build record input hashes", build_record.get("inputs"), expected_inputs)

    upstream_specs = {
        "viewContract": (outputs_root / "view-contract-verification.json", "passed-contract-only"),
        "section": (outputs_root / "sections" / "section-verification.json", "passed-section-geometry-only"),
        "projection": (outputs_root / "projections" / "projection-verification.json", "passed-projection-geometry-only"),
    }
    upstream_reports = {}
    for label, (path, expected_status) in upstream_specs.items():
        if not path.exists():
            _record(checks, f"upstream {label} verifier report present", False, True)
            continue
        report = json.loads(path.read_text(encoding="utf-8"))
        upstream_reports[label] = {"path": path.name, "sha256": _file_hash(path), "status": report.get("status")}
        _record(checks, f"upstream {label} verifier status", report.get("status"), expected_status)

    status = "passed-detail-geometry-only" if all(check["passed"] for check in checks) else "failed"
    return {
        "schemaVersion": "t0b-v2-detail-verification-1",
        "status": status,
        "qualification": "not-drawing-output",
        "L1": False,
        "verifier": {"version": VERIFIER_VERSION, "source": Path(__file__).name, "sha256": _file_hash(Path(__file__).resolve())},
        "inputs": {
            "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
            "sanitizedGenerationInput": {"sha256": _stable_hash(contract)},
            "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            "detailBuildRecord": {"path": build_record_path.name, "sha256": _file_hash(build_record_path)},
            "detailOutputs": output_records,
            "upstreamReports": upstream_reports,
        },
        "checks": checks,
        "summary": {"total": len(checks), "passed": sum(check["passed"] for check in checks), "failed": sum(not check["passed"] for check in checks)},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify controlled detail ViewGeometry without generator or frozen geometry oracle imports.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--details-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify_details(args.fixture, args.manifest, args.source_meshes, args.details_dir)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0 if report["status"] == "passed-detail-geometry-only" else 1


if __name__ == "__main__":
    raise SystemExit(main())
