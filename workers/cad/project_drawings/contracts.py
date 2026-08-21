from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any


class DrawingContractError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DrawingContractError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_value(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _unit(vector: list[float]) -> tuple[float, float, float]:
    require(isinstance(vector, list) and len(vector) == 3 and all(isinstance(item, (int, float)) for item in vector), "view vector is invalid")
    length = math.sqrt(sum(float(item) ** 2 for item in vector))
    require(abs(length - 1.0) <= 1e-6, "view vector must be unit length")
    return tuple(float(item) for item in vector)


def validate_artifact_matrix(value: dict[str, Any], geometry_manifest: dict[str, Any]) -> dict[str, Any]:
    require(value.get("schemaVersion") == "1.0", "artifact matrix schema differs")
    require(value.get("geometryRevisionId") == geometry_manifest.get("geometryRevisionId"), "geometry revision differs")
    require(value.get("projectId") == geometry_manifest.get("projectId"), "project differs")
    require(value.get("projectRevisionId") == geometry_manifest.get("projectRevisionId"), "project revision differs")
    require(value.get("issueState") == "proxy-unissued" and value.get("issueDate") is None, "only unissued proxy output is allowed")
    require(isinstance(value.get("titleZh"), str) and value["titleZh"].strip(), "title is missing")
    require(isinstance(value.get("buildingDisplayNameZh"), str) and value["buildingDisplayNameZh"].strip(), "building label is missing")
    views = value.get("views")
    sheets = value.get("sheets")
    require(isinstance(views, list) and views and isinstance(sheets, list) and sheets, "views and sheets are required")
    view_ids: set[str] = set()
    for view in views:
        require(view.get("id") not in view_ids, "duplicate view id")
        view_ids.add(view["id"])
        require(view.get("kind") in {"floorPlan", "roofPlan", "elevation", "transverseSection", "longitudinalSection", "axonometric", "detail"}, "view kind is invalid")
        require(isinstance(view.get("displayLabelZh"), str) and view["displayLabelZh"].strip(), "view display label is missing")
        require(re.fullmatch(r"[\u4e00-\u9fffA-Z0-9-]{2,20}", str(view.get("drawingRef", ""))) is not None, "drawing reference is invalid")
        direction = _unit(view.get("direction"))
        right = _unit(view.get("right"))
        up = _unit(view.get("up"))
        require(abs(sum(direction[index] * right[index] for index in range(3))) <= 1e-6, "direction and right are not orthogonal")
        require(abs(sum(direction[index] * up[index] for index in range(3))) <= 1e-6, "direction and up are not orthogonal")
        require(abs(sum(right[index] * up[index] for index in range(3))) <= 1e-6, "right and up are not orthogonal")
        rect = view.get("viewportRectMm")
        require(isinstance(rect, list) and len(rect) == 4 and rect[2] > 0 and rect[3] > 0, "viewport rectangle is invalid")
        require(isinstance(view.get("scaleDenominator"), int) and view["scaleDenominator"] > 0, "scale is invalid")
        if view["kind"] in {"transverseSection", "longitudinalSection", "detail"}:
            plane = view.get("sectionPlane")
            require(isinstance(plane, dict), "section view requires a plane")
            _unit(plane.get("normal"))
            require(isinstance(plane.get("offsetMm"), (int, float)), "section offset is invalid")
    assigned: list[str] = []
    sheet_ids: set[str] = set()
    for sheet in sheets:
        require(sheet.get("id") not in sheet_ids, "duplicate sheet id")
        sheet_ids.add(sheet["id"])
        page = sheet.get("pageMm")
        require(page in ([841, 594], [594, 420], [420, 297]), "unsupported sheet size")
        require(isinstance(sheet.get("viewIds"), list) and sheet["viewIds"], "sheet has no views")
        assigned.extend(sheet["viewIds"])
        for view_id in sheet["viewIds"]:
            require(view_id in view_ids, "sheet references an unknown view")
        rects = [next(item["viewportRectMm"] for item in views if item["id"] == view_id) for view_id in sheet["viewIds"]]
        for index, rect in enumerate(rects):
            require(rect[0] >= 10 and rect[1] >= 20 and rect[0] + rect[2] <= page[0] - 10 and rect[1] + rect[3] <= page[1] - 35, "viewport leaves printable area")
            for other in rects[:index]:
                overlap = min(rect[0] + rect[2], other[0] + other[2]) > max(rect[0], other[0]) and min(rect[1] + rect[3], other[1] + other[3]) > max(rect[1], other[1])
                require(not overlap, "paper viewports overlap")
    require(set(assigned) == view_ids and len(assigned) == len(view_ids), "each view must appear once")
    for view in views:
        require(any(sheet["id"] == view.get("sheetId") and view["id"] in sheet["viewIds"] for sheet in sheets), "view sheet binding differs")
    entity_ids = {item["id"] for item in geometry_manifest.get("entities", [])}
    for observation in value.get("observationCandidates", []):
        require(observation.get("targetEntityId") in entity_ids, "observation target is unknown")
        require(observation.get("producerType") == "demo" and observation.get("reviewStatus") == "unreviewed", "observation candidate boundary differs")
    forbidden = ("targetViewId", "2000-01-01", "generated-not-qualified", geometry_manifest.get("geometryRevisionId", ""))
    visible = canonical_bytes({key: value.get(key) for key in ("titleZh", "buildingDisplayNameZh", "revisionLabel", "views", "sheets")}).decode("utf-8")
    require(not any(item and item in visible for item in forbidden), "visible drawing metadata exposes internal identifiers or fake dates")
    return value
