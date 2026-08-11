from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import gzip
from hashlib import sha256
import itertools
import json
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import LineString, box
from shapely.ops import polygonize_full, unary_union
import trimesh

try:
    from .detail_oracle import detail_oracle, detail_target_types
    from .verify_sections import _load_sources, _verify_source_closure
except ImportError:  # pragma: no cover - direct verifier execution
    from workers.cad.t0b_v2.detail_oracle import detail_oracle, detail_target_types
    from workers.cad.t0b_v2.verify_sections import _load_sources, _verify_source_closure


VERIFIER_VERSION = "3.0.0"
VIEW_CONTRACT_REVISION_NAMESPACE = UUID("7f53de29-8c75-5f46-a7bf-75c69cc967a0")


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _entity_set_hash(entity_ids: list[str]) -> str:
    return sha256("\n".join(sorted(entity_ids)).encode("utf-8")).hexdigest()


def _load_source_meshes(path: Path) -> dict[str, trimesh.Trimesh]:
    meshes: dict[str, trimesh.Trimesh] = {}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        header = json.loads(next(stream))
        if header.get("schemaVersion") != "t0b-v2-source-meshes-1":
            raise ValueError("unsupported source mesh schema")
        for line in stream:
            record = json.loads(line)
            meshes[record["entityId"]] = trimesh.Trimesh(
                vertices=np.asarray(record["vertices"], dtype=float),
                faces=np.asarray(record["faces"], dtype=int),
                process=False,
            )
    return meshes


def _selection(view: dict, manifest: dict) -> tuple[list[str], list[str]]:
    frame = view["viewFrame"]
    origin = np.asarray(frame["origin"], dtype=float)
    right = np.asarray(frame["right"], dtype=float)
    up = np.asarray(frame["up"], dtype=float)
    depth = np.asarray(frame["depth"], dtype=float)
    clip = frame["clipRectMm"]
    depth_range = frame["clipDepthMm"]
    target_types = detail_target_types(view) if view.get("detail") else None
    selected: list[str] = []
    selected_types: set[str] = set()
    for entity in manifest["entities"]:
        if target_types is not None and entity["componentType"] not in target_types:
            continue
        bounds = np.asarray(entity["bounds"], dtype=float)
        corners = np.asarray(list(itertools.product(*[(bounds[0, index], bounds[1, index]) for index in range(3)])))
        relative = corners - origin
        horizontal = relative @ right
        vertical = relative @ up
        distance = relative @ depth
        if (
            horizontal.max() < clip[0]
            or horizontal.min() > clip[2]
            or vertical.max() < clip[1]
            or vertical.min() > clip[3]
            or distance.max() < depth_range[0]
            or distance.min() > depth_range[1]
        ):
            continue
        selected.append(entity["entityId"])
        selected_types.add(entity["componentType"])
    return selected, sorted(selected_types)


def _section_spec(view: dict) -> tuple[dict, set[str] | None, bool] | None:
    if view["derivation"] == "planeIntersection":
        return view["section"], None, False
    detail = view.get("detail", {})
    if detail.get("mode") == "section-projection":
        return detail["section"], set(detail["cutTargetTypes"]), True
    return None


def _line_parts(geometry) -> list[LineString]:
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [item for item in geometry.geoms if item.geom_type == "LineString" and item.length >= 0.001]
    return []


def _section_oracle(view: dict, manifest: dict, meshes: dict[str, trimesh.Trimesh]) -> dict:
    section_spec, target_types, clip_required = _section_spec(view)  # type: ignore[misc]
    origin = np.asarray(section_spec["planeOrigin"], dtype=float)
    normal = np.asarray(section_spec["planeNormal"], dtype=float)
    right = np.asarray(view["viewFrame"]["right"], dtype=float)
    up = np.asarray(view["viewFrame"]["up"], dtype=float)
    clip_shape = box(*view["viewFrame"]["clipRectMm"])
    metadata = {item["entityId"]: item for item in manifest["entities"]}
    hit_ids: list[str] = []
    signature: list[tuple[str, tuple[float, float], tuple[float, float]]] = []
    polygon_counts: Counter[str] = Counter()
    cut_count = 0
    dangle_count = 0
    all_bounds: list[tuple[float, float, float, float]] = []

    for entity_id, mesh in meshes.items():
        component_type = metadata[entity_id]["componentType"]
        if target_types is not None and component_type not in target_types:
            continue
        segments = trimesh.intersections.mesh_plane(mesh, normal, origin)
        lines: list[LineString] = []
        for segment in segments:
            start = (
                round(float(np.dot(segment[0] - origin, right)), 3),
                round(float(np.dot(segment[0] - origin, up)), 3),
            )
            end = (
                round(float(np.dot(segment[1] - origin, right)), 3),
                round(float(np.dot(segment[1] - origin, up)), 3),
            )
            if start == end:
                continue
            geometry = LineString([start, end])
            if clip_required:
                geometry = geometry.intersection(clip_shape)
            for part in _line_parts(geometry):
                coordinates = list(part.coords)
                first = tuple(round(float(value), 3) for value in coordinates[0])
                last = tuple(round(float(value), 3) for value in coordinates[-1])
                if first == last:
                    continue
                lines.append(LineString([first, last]))
                signature.append((entity_id, min(first, last), max(first, last)))
        if not lines:
            continue
        hit_ids.append(entity_id)
        merged = unary_union(lines)
        polygons, cuts, dangles, _invalid = polygonize_full(merged)
        polygon_counts[component_type] += len(polygons.geoms)
        cut_count += len(cuts.geoms)
        dangle_count += len(dangles.geoms)
        all_bounds.extend(item.bounds for item in lines)

    segment_payload = json.dumps(sorted(signature), separators=(",", ":")).encode("utf-8")
    result = {
        "cutEntitySetSha256": _entity_set_hash(hit_ids),
        "cutSegmentSha256": sha256(segment_payload).hexdigest(),
    }
    if not clip_required:
        result.update(
            {
                "cutClosedRegionCount": sum(polygon_counts.values()),
                "cutClosedRegionsByType": dict(sorted(polygon_counts.items())),
                "cutOpenOrDangleCount": cut_count + dangle_count,
                "cutBounds2dMm": [
                    round(min(item[0] for item in all_bounds), 3),
                    round(min(item[1] for item in all_bounds), 3),
                    round(max(item[2] for item in all_bounds), 3),
                    round(max(item[3] for item in all_bounds), 3),
                ],
            }
        )
    return result


def _view_contract_signature(fixture: dict) -> str:
    payload = {
        "geometryRevisionId": fixture.get("geometryRevisionId"),
        "views": fixture.get("views"),
        "drawingSheets": fixture.get("drawingSheets"),
        "drawingRequirements": fixture.get("drawingRequirements"),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def _shift_section(view: dict, offset_mm: float) -> dict:
    shifted = deepcopy(view)
    section_spec, _target_types, _clip_required = _section_spec(shifted)  # type: ignore[misc]
    origin = np.asarray(section_spec["planeOrigin"], dtype=float)
    normal = np.asarray(section_spec["planeNormal"], dtype=float)
    section_spec["planeOrigin"] = (origin + normal * offset_mm).tolist()
    return shifted


def _stable_section_fields(result: dict) -> dict:
    return {
        key: value
        for key, value in result.items()
        if key in {"cutEntitySetSha256", "cutClosedRegionCount", "cutClosedRegionsByType", "cutOpenOrDangleCount"}
    }


def _record(checks: list[dict], name: str, actual, expected) -> None:
    checks.append({"name": name, "passed": actual == expected, "actual": actual, "expected": expected})


def verify_view_contract(fixture_path: Path, manifest_path: Path, source_meshes_path: Path) -> dict:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    if _file_hash(source_meshes_path) != fixture["knownAnswers"]["sourceMeshBundleSha256"]:
        raise ValueError("source mesh bundle differs from the frozen oriented topology hash")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_header, meshes = _load_sources(source_meshes_path)
    _verify_source_closure(fixture, manifest, source_header, meshes)
    checks: list[dict] = []
    _record(checks, "geometry revision", manifest.get("geometryRevisionId"), fixture.get("geometryRevisionId"))
    _record(checks, "geometry signature", manifest.get("geometrySignature"), fixture["knownAnswers"].get("geometrySignature"))
    _record(checks, "fixture source isolation", fixture.get("referenceIsolation"), {"fixtureOnly": True, "allowedSourceSchemes": ["demo"], "externalAssetsAllowed": False})
    _record(checks, "manifest producer", manifest.get("producerType"), "demo")
    _record(checks, "manifest sources", all(str(item).startswith("demo:") for item in manifest.get("sourceRefs", [])), True)
    actual_view_signature = _view_contract_signature(fixture)
    _record(checks, "view contract signature", fixture.get("viewContractSignature"), actual_view_signature)
    _record(checks, "view contract revision", fixture.get("viewContractRevisionId"), str(uuid5(VIEW_CONTRACT_REVISION_NAMESPACE, actual_view_signature)))

    answers = fixture["knownAnswers"]["viewOracle"]["views"]
    metadata = {item["entityId"]: item for item in manifest["entities"]}
    for view in fixture["views"]:
        view_id = view["id"]
        expected = answers[view_id]
        selected, selected_types = _selection(view, manifest)
        _record(checks, f"{view_id} selection set", _entity_set_hash(selected), expected["selectionEntitySetSha256"])
        _record(checks, f"{view_id} selection types", selected_types, expected["selectionTypes"])
        _record(checks, f"{view_id} selection diagnostic", len(selected), expected["selectionCountDiagnostic"])
        if view.get("detail"):
            detail = view["detail"]
            anchor = metadata.get(detail["anchorEntityId"])
            _record(checks, f"{view_id} anchor exists", anchor is not None, True)
            if anchor is not None:
                _record(checks, f"{view_id} anchor type", anchor["componentType"], detail["anchorComponentType"])
                delta = float(np.max(np.abs(np.asarray(anchor["centroid"], dtype=float) - np.asarray(detail["anchorCentroid"], dtype=float))))
                _record(checks, f"{view_id} anchor centroid tolerance", delta <= 0.001, True)
                bounds = np.asarray(anchor["bounds"], dtype=float)
                anchor_point = np.asarray(detail["anchorPoint"], dtype=float)
                _record(checks, f"{view_id} anchor point inside entity bounds", bool(np.all(anchor_point >= bounds[0] - 0.001) and np.all(anchor_point <= bounds[1] + 0.001)), True)
                crop = np.asarray(detail["cropBoundsModelMm"], dtype=float)
                _record(checks, f"{view_id} anchor bounds intersect crop", bool(np.all(bounds[1] >= crop[0]) and np.all(bounds[0] <= crop[1])), True)
                corners = np.asarray(list(itertools.product(*[(crop[0, index], crop[1, index]) for index in range(3)])))
                frame = view["viewFrame"]
                relative = corners - np.asarray(frame["origin"], dtype=float)
                projected = [
                    round(float((relative @ np.asarray(frame["right"], dtype=float)).min()), 6),
                    round(float((relative @ np.asarray(frame["up"], dtype=float)).min()), 6),
                    round(float((relative @ np.asarray(frame["right"], dtype=float)).max()), 6),
                    round(float((relative @ np.asarray(frame["up"], dtype=float)).max()), 6),
                ]
                _record(checks, f"{view_id} crop projects to clip rectangle", projected, [round(float(value), 6) for value in frame["clipRectMm"]])
                _record(checks, f"{view_id} target types match oracle", sorted(detail_target_types(view)), sorted(expected["requiredTypes"]))
            actual_detail = detail_oracle(view, manifest, meshes, fixture["drawingRequirements"]["projectionPolicy"])
            for field, actual in actual_detail.items():
                _record(checks, f"{view_id} {field}", actual, expected[field])
            actual_sources = set(actual_detail["requiredVisibleEntityIds"])
            _record(checks, f"{view_id} forbidden entities exist", all(entity_id in metadata for entity_id in expected["mustNotAppearEntityIds"]), True)
            _record(checks, f"{view_id} forbidden entities absent", not (actual_sources & set(expected["mustNotAppearEntityIds"])), True)
            _record(
                checks,
                f"{view_id} forbidden types absent",
                not ({metadata[entity_id]["componentType"] for entity_id in actual_sources} & set(expected["mustNotAppearTypes"])),
                True,
            )
            selected_materials_match = all(
                metadata[entity_id]["materialCode"] == expected["materialCodeByType"][metadata[entity_id]["componentType"]]
                for entity_id in selected
            )
            _record(checks, f"{view_id} source material mapping", selected_materials_match, True)
            manifest_relations = {
                (relation["fromEntityId"], relation["relation"], relation["toEntityId"])
                for relation in manifest["relations"]
            }
            for chain_name, relations in expected["requiredEntityChains"].items():
                actual_relations = {
                    (relation["fromEntityId"], relation["relation"], relation["toEntityId"])
                    for relation in relations
                }
                _record(checks, f"{view_id} {chain_name} relations", actual_relations <= manifest_relations, True)
            if view_id == "doorWindowDetail":
                templates = fixture["componentTemplates"]
                selected_type_counts = Counter(metadata[entity_id]["componentType"] for entity_id in selected)
                topology = {
                    "doorLeaves": selected_type_counts["doorLeaf"],
                    "doorPanels": selected_type_counts["doorLeaf"] * templates["doorLeaf"]["parameters"]["panels"],
                    "latticeWindows": selected_type_counts["latticeWindow"],
                    "latticeCells": selected_type_counts["latticeWindow"] * templates["latticeWindow"]["parameters"]["rows"] * templates["latticeWindow"]["parameters"]["columns"],
                }
                _record(checks, f"{view_id} panel and lattice topology", topology, expected["topologyCounts"])

        if view.get("derivation") == "planeIntersection":
            actual_section = _section_oracle(view, manifest, meshes)
            for field, actual in actual_section.items():
                _record(checks, f"{view_id} {field}", actual, expected[field])
            section_spec, _target_types, _clip_required = _section_spec(view)  # type: ignore[misc]
            probe = float(section_spec["stabilityProbeMm"])
            before = _section_oracle(_shift_section(view, -probe), manifest, meshes)
            after = _section_oracle(_shift_section(view, probe), manifest, meshes)
            center_stability = _stable_section_fields(actual_section)
            _record(checks, f"{view_id} negative section stability", _stable_section_fields(before), center_stability)
            _record(checks, f"{view_id} positive section stability", _stable_section_fields(after), center_stability)
        elif view.get("detail", {}).get("mode") == "section-projection":
            section_spec = view["detail"]["section"]
            probe = float(section_spec["stabilityProbeMm"])
            center = detail_oracle(view, manifest, meshes, fixture["drawingRequirements"]["projectionPolicy"])
            before = detail_oracle(_shift_section(view, -probe), manifest, meshes, fixture["drawingRequirements"]["projectionPolicy"])
            after = detail_oracle(_shift_section(view, probe), manifest, meshes, fixture["drawingRequirements"]["projectionPolicy"])
            stable_fields = {"cutEntitySetSha256", "cutClosedRegionCount", "cutClosedRegionsByType", "cutOpenOrDangleCount", "materialRegionsByCode", "maximumMaterialOverlapAreaMm2"}
            center_stability = {field: center[field] for field in stable_fields}
            _record(checks, f"{view_id} negative section stability", {field: before[field] for field in stable_fields}, center_stability)
            _record(checks, f"{view_id} positive section stability", {field: after[field] for field in stable_fields}, center_stability)
            anchor_id = view["detail"]["anchorEntityId"]
            if anchor_id in meshes:
                cut = trimesh.intersections.mesh_plane(
                    meshes[anchor_id],
                    np.asarray(section_spec["planeNormal"], dtype=float),
                    np.asarray(section_spec["planeOrigin"], dtype=float),
                )
                _record(checks, f"{view_id} anchor mesh intersects cut plane", len(cut) > 0, True)
            else:
                _record(checks, f"{view_id} anchor mesh intersects cut plane", False, True)
        if view.get("derivation") == "visibleLineProjection":
            display_types = set(view.get("projection", {}).get("displayTypes", []))
            required_visible = expected.get("requiredVisibleEntityIds", [])
            forbidden_entities = expected.get("mustNotAppearEntityIds", [])
            _record(checks, f"{view_id} required visible entities exist", all(entity_id in metadata for entity_id in required_visible), True)
            _record(
                checks,
                f"{view_id} required visible types are displayed",
                all(metadata[entity_id]["componentType"] in display_types for entity_id in required_visible if entity_id in metadata),
                True,
            )
            _record(checks, f"{view_id} forbidden entities exist", all(entity_id in metadata for entity_id in forbidden_entities), True)
            _record(checks, f"{view_id} forbidden types are not displayed", not (set(expected.get("mustNotAppearTypes", [])) & display_types), True)
            for chain_name, chain in expected.get("requiredVisibleChains", {}).items():
                chain_bounds = [np.asarray(metadata[entity_id]["bounds"], dtype=float) for entity_id in chain if entity_id in metadata]
                connected = len(chain_bounds) == len(chain) and all(
                    bool(np.all(chain_bounds[index][1] + 0.001 >= chain_bounds[index + 1][0]) and np.all(chain_bounds[index + 1][1] + 0.001 >= chain_bounds[index][0]))
                    for index in range(len(chain_bounds) - 1)
                )
                _record(checks, f"{view_id} {chain_name} source continuity", connected, True)
            if view_id == "axonometric":
                frame = view["viewFrame"]
                origin = np.asarray(frame["origin"], dtype=float)
                right = np.asarray(frame["right"], dtype=float)
                up = np.asarray(frame["up"], dtype=float)
                ridge = np.asarray(expected["anchorModelPointsMm"]["ridgeCenter"], dtype=float) - origin
                step = np.asarray(expected["anchorModelPointsMm"]["southStepFront"], dtype=float) - origin
                ridge_2d = np.asarray([ridge @ right, ridge @ up])
                step_2d = np.asarray([step @ right, step @ up])
                _record(checks, "axonometric anchor orientation", bool(step_2d[0] > ridge_2d[0] and step_2d[1] < ridge_2d[1]), True)

    status = "passed-contract-only" if all(item["passed"] for item in checks) else "failed"
    return {
        "schemaVersion": "t0b-v2-view-contract-verification-1",
        "status": status,
        "qualification": "not-view-output",
        "verifier": {
            "version": VERIFIER_VERSION,
            "source": Path(__file__).name,
            "sha256": _file_hash(Path(__file__).resolve()),
        },
        "inputs": {
            "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
            "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
        },
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify the frozen T0-B v2 view contract.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify_view_contract(args.fixture, args.manifest, args.source_meshes)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0 if report["status"] == "passed-contract-only" else 1


if __name__ == "__main__":
    raise SystemExit(main())
