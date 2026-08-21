from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
import math
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
from shapely.geometry import GeometryCollection, LineString, MultiLineString, Polygon

from .verify_sections import (
    LINE_NAMESPACE,
    VisibilityOracle,
    _candidate_edges,
    _file_hash,
    _load_sources,
    _record,
    _selection,
    _verify_source_closure,
)


VERIFIER_VERSION = "1.0.0"
PROJECTION_VIEW_IDS = ("roofPlan", "southElevation", "axonometric")


def _load_output(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _line_parts(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, (MultiLineString, GeometryCollection)):
        result = []
        for part in geometry.geoms:
            result.extend(_line_parts(part))
        return result
    return []


def _clip_segment(start: np.ndarray, end: np.ndarray, frame: dict) -> tuple[np.ndarray, np.ndarray] | None:
    low = np.asarray([frame["clipRectMm"][0], frame["clipRectMm"][1], frame["clipDepthMm"][0]], dtype=float)
    high = np.asarray([frame["clipRectMm"][2], frame["clipRectMm"][3], frame["clipDepthMm"][1]], dtype=float)
    direction = end - start
    lower = 0.0
    upper = 1.0
    for index in range(3):
        if abs(direction[index]) <= 1e-12:
            if start[index] < low[index] or start[index] > high[index]:
                return None
            continue
        first = (low[index] - start[index]) / direction[index]
        second = (high[index] - start[index]) / direction[index]
        lower = max(lower, min(first, second))
        upper = min(upper, max(first, second))
        if lower > upper:
            return None
    return start + direction * lower, start + direction * upper


def _parameter(point: np.ndarray, start: np.ndarray, direction: np.ndarray) -> float:
    denominator = float(direction[:2] @ direction[:2])
    if denominator <= 1e-12:
        return 0.0
    return max(0.0, min(1.0, float((point[:2] - start[:2]) @ direction[:2] / denominator)))


def _occluded_intervals(oracle: VisibilityOracle, start: np.ndarray, end: np.ndarray, tolerance: float) -> list[tuple[float, float]]:
    triangles = oracle._segment_candidates(start, end)
    if not triangles:
        return []
    array = np.asarray(triangles, dtype=float)
    first = array[:, 0]
    axis_a = array[:, 1, :2] - first[:, :2]
    axis_b = array[:, 2, :2] - first[:, :2]
    determinant = axis_a[:, 0] * axis_b[:, 1] - axis_a[:, 1] * axis_b[:, 0]
    valid = np.abs(determinant) > 1e-9
    safe = np.where(valid, determinant, 1.0)

    def weights(point: np.ndarray) -> np.ndarray:
        offset = point[:2] - first[:, :2]
        first_weight = (offset[:, 0] * axis_b[:, 1] - offset[:, 1] * axis_b[:, 0]) / safe
        second_weight = (axis_a[:, 0] * offset[:, 1] - axis_a[:, 1] * offset[:, 0]) / safe
        return np.column_stack((first_weight, second_weight, 1.0 - first_weight - second_weight))

    start_weights = weights(start)
    end_weights = weights(end)
    lower = np.zeros(len(array), dtype=float)
    upper = np.ones(len(array), dtype=float)
    for index in range(3):
        initial = start_weights[:, index]
        slope = end_weights[:, index] - initial
        flat = np.abs(slope) <= 1e-12
        valid &= ~(flat & (initial < -1e-9))
        crossing = np.divide(-1e-9 - initial, slope, out=np.zeros_like(slope), where=~flat)
        lower = np.where((~flat) & (slope > 0), np.maximum(lower, crossing), lower)
        upper = np.where((~flat) & (slope < 0), np.minimum(upper, crossing), upper)
    valid &= lower < upper
    direction = end - start

    def depth_difference(parameters: np.ndarray) -> np.ndarray:
        barycentric = start_weights + (end_weights - start_weights) * parameters[:, None]
        surface_depth = (
            first[:, 2]
            + barycentric[:, 0] * (array[:, 1, 2] - first[:, 2])
            + barycentric[:, 1] * (array[:, 2, 2] - first[:, 2])
        )
        line_depth = start[2] + direction[2] * parameters
        return line_depth - surface_depth - tolerance

    lower_difference = depth_difference(lower)
    upper_difference = depth_difference(upper)
    hidden = valid & ((lower_difference > 0) | (upper_difference > 0))
    mixed = hidden & ((lower_difference > 0) != (upper_difference > 0))
    crossing = lower + np.divide(
        (upper - lower) * (-lower_difference),
        upper_difference - lower_difference,
        out=np.zeros_like(lower),
        where=np.abs(upper_difference - lower_difference) > 1e-12,
    )
    result_lower = np.where(mixed & (lower_difference <= 0), crossing, lower)
    result_upper = np.where(mixed & (lower_difference > 0), crossing, upper)
    return [
        (float(result_lower[index]), float(result_upper[index]))
        for index in np.flatnonzero(hidden & (result_lower < result_upper))
    ]


def _visible_segments(
    oracle: VisibilityOracle,
    start: np.ndarray,
    end: np.ndarray,
    tolerance: float,
    minimum_length: float,
) -> list[tuple[np.ndarray, np.ndarray]]:
    occluded = sorted(_occluded_intervals(oracle, start, end, tolerance))
    merged: list[list[float]] = []
    for lower, upper in occluded:
        if merged and lower <= merged[-1][1] + 1e-9:
            merged[-1][1] = max(merged[-1][1], upper)
        else:
            merged.append([lower, upper])
    visible: list[tuple[float, float]] = []
    cursor = 0.0
    for lower, upper in merged:
        if lower > cursor:
            visible.append((cursor, lower))
        cursor = max(cursor, upper)
    if cursor < 1.0:
        visible.append((cursor, 1.0))
    direction = end - start
    length = float(np.linalg.norm(direction[:2]))
    return [
        (start + direction * lower, start + direction * upper)
        for lower, upper in visible
        if (upper - lower) * length >= minimum_length
    ]


def _canonical_segment(start: np.ndarray, end: np.ndarray) -> tuple[list[list[float]], list[list[float]]]:
    first = [round(float(value), 3) for value in start]
    second = [round(float(value), 3) for value in end]
    if tuple(first[:2]) <= tuple(second[:2]):
        return [first[:2], second[:2]], [first, second]
    return [second[:2], first[:2]], [second, first]


def _nearest_depth(oracle: VisibilityOracle, point: np.ndarray) -> float | None:
    nearest: float | None = None
    for triangle_index in oracle.cells.get(oracle._key(point), []):
        depth = oracle._depth(oracle.triangles[triangle_index], point)
        if depth is not None and (nearest is None or depth < nearest):
            nearest = depth
    return nearest


def _line_class(
    oracle: VisibilityOracle,
    start: np.ndarray,
    end: np.ndarray,
    source_class: str,
    outline_probe: float,
    continuation_tolerance: float,
) -> str:
    if source_class == "feature":
        return "feature"
    direction = end[:2] - start[:2]
    length = float(np.linalg.norm(direction))
    if length <= 1e-9:
        return "componentBoundary"
    perpendicular = np.asarray([-direction[1], direction[0]], dtype=float) / length
    midpoint = (start + end) / 2
    continuations = 0
    for sign in (-1.0, 1.0):
        nearest = _nearest_depth(oracle, midpoint[:2] + perpendicular * outline_probe * sign)
        if nearest is not None and abs(nearest - midpoint[2]) <= continuation_tolerance:
            continuations += 1
    return "silhouette" if continuations == 1 else "componentBoundary"


def _line_id(revision: str, view_id: str, entity_id: str, line_class: str, points: list[list[float]]) -> str:
    payload = json.dumps([revision, view_id, entity_id, "visibleLineProjection", line_class, points], separators=(",", ":"))
    return str(uuid5(LINE_NAMESPACE, payload))


def _expected_lines(view: dict, manifest: dict, meshes: dict, policy: dict) -> list[dict]:
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    selected = _selection(view, manifest)
    oracle = VisibilityOracle(view, selected, meshes)
    display_types = set(view["projection"]["displayTypes"])
    candidates: list[dict] = []
    for entity_id in selected:
        entity = metadata[entity_id]
        if entity["componentType"] not in display_types:
            continue
        for start, end, source_class in _candidate_edges(meshes[entity_id], view["viewFrame"], float(policy["featureAngleDeg"])):
            clipped = _clip_segment(start, end, view["viewFrame"])
            if clipped is None:
                continue
            for visible_start, visible_end in _visible_segments(
                oracle,
                *clipped,
                float(policy["visibilityProbeToleranceMm"]),
                float(policy["occlusionSplitToleranceMm"]),
            ):
                points, source_points = _canonical_segment(visible_start, visible_end)
                if points[0] == points[1]:
                    continue
                candidates.append(
                    {
                        "sourceEntityId": entity_id,
                        "sourceComponentType": entity["componentType"],
                        "lineClass": _line_class(
                            oracle,
                            visible_start,
                            visible_end,
                            source_class,
                            float(policy["outlineProbeMm"]),
                            float(policy["continuationDepthToleranceMm"]),
                        ),
                        "pointsMm": points,
                        "sourcePointsViewMm": source_points,
                        "meanDepthMm": round(float((visible_start[2] + visible_end[2]) / 2), 3),
                    }
                )
    deduplicated: dict[tuple, dict] = {}
    priorities = {"silhouette": 0, "componentBoundary": 1, "feature": 2}
    for candidate in candidates:
        key = tuple(map(tuple, candidate["pointsMm"]))
        rank = (candidate["meanDepthMm"], priorities[candidate["lineClass"]], candidate["sourceEntityId"])
        current = deduplicated.get(key)
        if current is None:
            deduplicated[key] = candidate
            continue
        current_rank = (current["meanDepthMm"], priorities[current["lineClass"]], current["sourceEntityId"])
        if rank < current_rank:
            deduplicated[key] = candidate
    result = list(deduplicated.values())
    result.sort(key=lambda item: (item["sourceEntityId"], item["lineClass"], item["pointsMm"]))
    return result


def _line_set_hash(lines: list[dict]) -> str:
    records = sorted(
        (
            line.get("sourceEntityId"),
            line.get("sourceComponentType"),
            line.get("lineClass"),
            line.get("pointsMm"),
            line.get("sourcePointsViewMm"),
        )
        for line in lines
    )
    return sha256(json.dumps(records, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def verify_projections(fixture_path: Path, manifest_path: Path, source_meshes_path: Path, projections_dir: Path) -> dict:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if _file_hash(source_meshes_path) != fixture["knownAnswers"]["sourceMeshBundleSha256"]:
        raise ValueError("source mesh bundle differs from the frozen oriented topology hash")
    header, meshes = _load_sources(source_meshes_path)
    _verify_source_closure(fixture, manifest, header, meshes)
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    views = {view["id"]: view for view in fixture["views"]}
    answers = fixture["knownAnswers"]["viewOracle"]["views"]
    policy = fixture["drawingRequirements"]["projectionPolicy"]
    checks: list[dict] = []
    outputs: list[dict] = []

    for view_id in PROJECTION_VIEW_IDS:
        view = views[view_id]
        output_path = projections_dir / f"{view_id}.view-geometry.json.gz"
        output = _load_output(output_path)
        outputs.append({"viewId": view_id, "path": output_path.name, "sha256": _file_hash(output_path)})
        _record(
            checks,
            f"{view_id} top level contract",
            {
                "schemaVersion": output.get("schemaVersion"),
                "status": output.get("status"),
                "qualification": output.get("qualification"),
                "viewId": output.get("viewId"),
                "geometryRevisionId": output.get("geometryRevisionId"),
                "viewContractRevisionId": output.get("viewContractRevisionId"),
                "unit": output.get("unit"),
                "viewFrame": output.get("viewFrame"),
            },
            {
                "schemaVersion": "t0b-v2-view-geometry-1",
                "status": "generated-not-qualified",
                "qualification": "not-drawing-output",
                "viewId": view_id,
                "geometryRevisionId": fixture["geometryRevisionId"],
                "viewContractRevisionId": fixture["viewContractRevisionId"],
                "unit": "mm",
                "viewFrame": view["viewFrame"],
            },
        )
        hash_payload = dict(output)
        stored_hash = hash_payload.pop("viewGeometrySha256", None)
        actual_hash = sha256(json.dumps(hash_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        _record(checks, f"{view_id} output hash", stored_hash, actual_hash)

        lines = output.get("projectionLines", [])
        line_ids = [line.get("lineId") for line in lines]
        valid_records = 0
        for line in lines:
            expected_id = _line_id(fixture["viewContractRevisionId"], view_id, line.get("sourceEntityId", ""), line.get("lineClass", ""), line.get("pointsMm", []))
            entity = metadata.get(line.get("sourceEntityId"))
            if (
                line.get("lineId") == expected_id
                and line.get("viewId") == view_id
                and line.get("geometryRevisionId") == fixture["geometryRevisionId"]
                and line.get("viewContractRevisionId") == fixture["viewContractRevisionId"]
                and line.get("derivation") == "visibleLineProjection"
                and line.get("derivationTransform") == view["viewFrame"]["modelToView"]
                and line.get("visibility") == "visible"
                and line.get("closed") is False
                and line.get("lineClass") in {"silhouette", "componentBoundary", "feature"}
                and line.get("pointsMm") == [point[:2] for point in line.get("sourcePointsViewMm", [])]
                and entity is not None
                and line.get("sourceComponentType") == entity["componentType"]
                and entity["componentType"] in view["projection"]["displayTypes"]
            ):
                valid_records += 1
        _record(checks, f"{view_id} unique line ids", len(set(line_ids)), len(lines))
        _record(checks, f"{view_id} line record closure", valid_records, len(lines))
        _record(checks, f"{view_id} no coincident duplicates", len({tuple(map(tuple, line["pointsMm"])) for line in lines}), len(lines))

        expected_lines = _expected_lines(view, manifest, meshes, policy)
        _record(checks, f"{view_id} independent complete visible line set", _line_set_hash(lines), _line_set_hash(expected_lines))
        expected_selected = sorted(_selection(view, manifest))
        _record(checks, f"{view_id} selection set", output["statistics"].get("selectionEntitySetSha256"), sha256("\n".join(expected_selected).encode("utf-8")).hexdigest())
        _record(checks, f"{view_id} line statistic", output["statistics"].get("visibleProjectionLineCount"), len(lines))

        actual_entities = {line["sourceEntityId"] for line in lines}
        actual_types = {line["sourceComponentType"] for line in lines}
        answer = answers[view_id]
        _record(checks, f"{view_id} required visible entities", set(answer["requiredVisibleEntityIds"]) <= actual_entities, True)
        _record(checks, f"{view_id} forbidden entities absent", bool(set(answer.get("mustNotAppearEntityIds", [])) & actual_entities), False)
        _record(checks, f"{view_id} forbidden types absent", bool(set(answer.get("mustNotAppearTypes", [])) & actual_types), False)
        for chain_name, chain in answer.get("requiredVisibleChains", {}).items():
            _record(checks, f"{view_id} {chain_name} visible", set(chain) <= actual_entities, True)

        if view_id == "axonometric":
            origin = np.asarray(view["viewFrame"]["origin"], dtype=float)
            right = np.asarray(view["viewFrame"]["right"], dtype=float)
            up = np.asarray(view["viewFrame"]["up"], dtype=float)
            ridge = np.asarray(answer["anchorModelPointsMm"]["ridgeCenter"], dtype=float) - origin
            step = np.asarray(answer["anchorModelPointsMm"]["southStepFront"], dtype=float) - origin
            _record(checks, "axonometric orientation", bool(step @ right > ridge @ right and step @ up < ridge @ up), True)

    status = "passed-projection-geometry-only" if all(check["passed"] for check in checks) else "failed"
    return {
        "schemaVersion": "t0b-v2-projection-verification-1",
        "status": status,
        "qualification": "not-drawing-output",
        "verifier": {"version": VERIFIER_VERSION, "source": Path(__file__).name, "sha256": _file_hash(Path(__file__).resolve())},
        "inputs": {
            "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
            "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            "projectionOutputs": outputs,
        },
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify complete visible-line projection ViewGeometry.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--projections-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify_projections(args.fixture, args.manifest, args.source_meshes, args.projections_dir)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0 if report["status"] == "passed-projection-geometry-only" else 1


if __name__ == "__main__":
    raise SystemExit(main())
