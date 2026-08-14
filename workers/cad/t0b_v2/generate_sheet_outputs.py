from __future__ import annotations

import argparse
import base64
from collections import defaultdict
from hashlib import sha256
import gzip
from html import escape
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4

from PIL import Image, ImageChops, ImageDraw, ImageFont
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from workers.cad.t0b_v2.drawing_contract import load_drawing_package_contract


PAGE_MM = (841.0, 594.0)
PNG_SIZE = (9933, 7016)
PT_PER_MM = 72.0 / 25.4
FONT_ALIAS = "GujianSansSCBound"
BUILD_RECORD_NAME = "T0B-sheet-output-build-record.json"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FORBIDDEN_OUTPUT_TOKENS = (".dwg", "downloads", "寺庙古建筑设计方案图", "一套完整的古建施工图")


class SheetOutputError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SheetOutputError(message)


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ir(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _fmt(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text if text not in {"-0", ""} else "0"


def _flatten_values(value: object) -> list[float]:
    if isinstance(value, dict):
        return [float(value[key]) for key in sorted(value)]
    _require(isinstance(value, list), "annotation valuesMm must be a list or object")
    return [float(item) for item in value]


def _parse_scale(value: str) -> float:
    match = re.fullmatch(r"1:(\d+(?:\.\d+)?)", value)
    _require(match is not None, f"invalid scale: {value}")
    return float(match.group(1))


def _polyline_path(rings: list[list[tuple[float, float]]], page_height: float | None = None) -> str:
    commands: list[str] = []
    for ring in rings:
        if len(ring) < 3:
            continue
        points = [(x, page_height - y if page_height is not None else y) for x, y in ring]
        commands.append(f"M {_fmt(points[0][0])} {_fmt(points[0][1])}")
        commands.extend(f"L {_fmt(x)} {_fmt(y)}" for x, y in points[1:])
        commands.append("Z")
    return " ".join(commands)


class DrawingSheetGenerator:
    def __init__(self, contract: dict, ir: dict, font_config: dict, font_manifest: dict, font_path: Path) -> None:
        self.contract = contract
        self.ir = ir
        self.font_config = font_config
        self.font_manifest = font_manifest
        self.font_path = font_path
        self.stages = {stage["viewId"]: stage for stage in ir["modelSpace"]["viewStages"]}
        self.annotations: dict[str, list[dict]] = defaultdict(list)
        self.title_annotations: dict[str, dict] = {}
        for annotation in ir["annotations"]:
            if annotation.get("viewId"):
                self.annotations[annotation["viewId"]].append(annotation)
            else:
                self.title_annotations[annotation["layoutName"]] = annotation
        self.rendered_requirements: set[str] = set()
        self._validate_inputs()

    def _validate_inputs(self) -> None:
        _require(self.ir["drawingPackageContractSignature"] == self.contract["contractSignature"], "IR contract signature differs")
        _require(self.ir["drawingPackageContractRevisionId"] == self.contract["contractRevisionId"], "IR contract revision differs")
        _require(self.ir["geometryRevisionId"] == self.contract["geometryRevisionId"], "geometry revision differs")
        _require(self.ir["viewContractRevisionId"] == self.contract["viewContractRevisionId"], "view contract revision differs")
        _require(self.ir["status"] == "generated-not-qualified" and self.ir["L1"] is False, "IR qualification boundary was relaxed")
        _require(len(self.stages) == 10 and len(self.ir["paperSpace"]["layouts"]) == 2, "sheet view or layout count differs")
        _require({layout["layoutName"] for layout in self.ir["paperSpace"]["layouts"]} == {"T0B-01", "T0B-02"}, "layout names differ")
        _require(all(layout["pageMm"] == [841, 594] and len(layout["viewports"]) == 5 for layout in self.ir["paperSpace"]["layouts"]), "A1 5+5 layout differs")
        bound = self.contract["fontPolicy"]["boundFonts"][0]
        _require(self.font_manifest["sha256"] == bound["sha256"] == _file_hash(self.font_path), "font file binding differs")
        _require(self.font_manifest["family"] == self.font_config["family"] == bound["family"] == "Gujian Sans SC", "font family binding differs")
        _require(self.font_manifest["postScriptName"] == self.font_config["postScriptName"] == bound["postScriptName"], "font PostScript binding differs")
        _require(self.font_manifest["instance"]["axisLocation"] == {"wght": 400} and self.font_config["instanceWeight"] == 400, "font weight differs")
        _require(self.font_manifest["fsType"] == self.font_config["fsType"] == 0, "font embedding permission differs")
        _require(self.font_manifest["glyphCoverage"]["missingCodepoints"] == [], "font corpus is incomplete")
        blockers = set(self.ir["qualificationBoundary"]["requiredBlockers"])
        _require("FONT_ASSET_NOT_BOUND" not in blockers, "closed font blocker remains")
        _require({"BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED", "PROFESSIONAL_REVIEW_PENDING"} <= blockers, "required qualification blockers are missing")

    def _view_mapping(self, viewport: dict, stage: dict):
        x, y, width, height = [float(value) for value in viewport["paperRectMm"]]
        sx1, sy1, sx2, sy2 = [float(value) for value in stage["stagedBoundsMm"]]
        model_center = ((sx1 + sx2) / 2.0, (sy1 + sy2) / 2.0)
        paper_center = (x + width / 2.0, y + height / 2.0)
        scale = float(viewport["paperScale"])

        def transform(point: list[float] | tuple[float, float]) -> tuple[float, float]:
            return (
                paper_center[0] + (float(point[0]) - model_center[0]) * scale,
                paper_center[1] + (float(point[1]) - model_center[1]) * scale,
            )

        return transform

    def _line_style(self, layer: str) -> tuple[float, tuple[float, ...]]:
        definition = self.ir["layerPolicy"]["layers"][layer]
        dash = ()
        if definition["linetype"] in {"HIDDEN", "DASHED"}:
            dash = (2.0, 1.2)
        elif definition["linetype"] == "CENTER":
            dash = (6.0, 1.5, 1.0, 1.5)
        return float(definition["lineweightMm"]), dash

    def _region_rings(self, stage: dict, region: dict, transform) -> list[list[tuple[float, float]]]:
        line_index = {line["cadObjectId"]: line for line in stage["structuralLines"]}
        if region["sourceKind"] == "ViewGeometry.cutRegion":
            source_rings = [line_index[cad_id]["modelSpacePointsMm"] for cad_id in region["boundaryCadObjectIds"]]
        else:
            source_rings = [region["modelSpaceOuterMm"], *region["modelSpaceHolesMm"]]
        rings = [[transform(point) for point in ring] for ring in source_rings]
        _require(rings and all(len(ring) >= 3 for ring in rings), f"{region['cadObjectId']} has an incomplete hatch boundary")
        return rings

    def _annotation_primitives(self, viewport: dict, stage: dict) -> list[dict]:
        view_id = stage["viewId"]
        transform = self._view_mapping(viewport, stage)
        scale = float(viewport["paperScale"])
        denominator = _parse_scale(viewport["scale"])
        text_height = max(25.0, 2.5 * denominator)
        x1, y1, x2, y2 = [float(value) for value in stage["stagedBoundsMm"]]
        primitives: list[dict] = []

        def line(points, requirement_id, width=0.13, dash=()):
            primitives.append({"type": "polyline", "points": [transform(point) for point in points], "width": width, "dash": dash, "requirementId": requirement_id})

        def text(point, value, requirement_id, size=2.5, anchor="start"):
            primitives.append({"type": "text", "point": transform(point), "text": str(value), "size": max(2.5, size), "anchor": anchor, "requirementId": requirement_id})

        def circle(point, radius_model, requirement_id):
            primitives.append({"type": "circle", "center": transform(point), "radius": radius_model * scale, "width": 0.13, "requirementId": requirement_id})

        for annotation in sorted(self.annotations[view_id], key=lambda item: (item["category"], item["requirementId"])):
            requirement_id = annotation["requirementId"]
            payload = annotation["semanticPayload"]
            category = annotation["category"]
            self.rendered_requirements.add(requirement_id)
            if category == "dimensions":
                width, height = x2 - x1, y2 - y1
                for index, original_value in enumerate(_flatten_values(payload["valuesMm"])):
                    value = abs(original_value)
                    if value <= width * 0.92:
                        center = (x1 + x2) / 2.0
                        p1 = (center - value / 2.0, y1 + text_height * (1.5 + index * 0.9))
                        p2 = (center + value / 2.0, p1[1])
                        dim_y = y1 + text_height * (2.2 + index * 0.9)
                        line([p1, (p1[0], dim_y)], requirement_id)
                        line([p2, (p2[0], dim_y)], requirement_id)
                        line([(p1[0], dim_y), (p2[0], dim_y)], requirement_id)
                        text(((p1[0] + p2[0]) / 2.0, dim_y + text_height * 0.18), f"{value:g}", requirement_id, anchor="middle")
                    else:
                        center = (y1 + y2) / 2.0
                        p1 = (x1 + text_height * (1.5 + index * 0.9), center - value / 2.0)
                        p2 = (p1[0], center + value / 2.0)
                        dim_x = x1 + text_height * (2.2 + index * 0.9)
                        line([p1, (dim_x, p1[1])], requirement_id)
                        line([p2, (dim_x, p2[1])], requirement_id)
                        line([(dim_x, p1[1]), (dim_x, p2[1])], requirement_id)
                        text((dim_x + text_height * 0.18, (p1[1] + p2[1]) / 2.0), f"{value:g}", requirement_id)
            elif category == "axes":
                bubble = text_height * 0.6
                points = [(x1 + bubble * 2, y1 + bubble * 2), (x2 - bubble * 2, y1 + bubble * 2), (x1 + bubble * 2, y2 - bubble * 2), (x2 - bubble * 2, y2 - bubble * 2)]
                for index, point in enumerate(points):
                    circle(point, bubble, requirement_id)
                    text((point[0], point[1] - text_height * 0.2), str(index + 1), requirement_id, anchor="middle")
            elif category == "levels":
                labels = payload.get("labels", [])
                translation_y = stage["viewToModelSpace"][1][2]
                for index, value in enumerate(_flatten_values(payload["valuesMm"])):
                    target_y = value + translation_y
                    if not (y1 + text_height <= target_y <= y2 - text_height):
                        target_y = y1 + text_height * (1.5 + index * 1.5)
                    point = (x2 - text_height * 5, target_y)
                    size = text_height * 0.7
                    line([(point[0] - size, point[1]), (point[0], point[1] + size * 0.6), (point[0] + size, point[1]), (point[0] - size, point[1])], requirement_id)
                    line([point, (point[0] + size * 3, point[1])], requirement_id)
                    label = labels[index] if index < len(labels) else ("±0.000" if value == 0 else f"{value / 1000:+.3f}")
                    text((point[0] + size * 3.3, point[1] - text_height * 0.15), label, requirement_id)
            elif category in {"sectionMarks", "detailIndices"}:
                target = payload.get("targetViewId", "VIEW")
                point = ((x1 + x2) / 2.0, y2 - text_height * (2 if category == "detailIndices" else 3))
                circle(point, text_height * 0.7, requirement_id)
                line([(point[0] - text_height * 0.7, point[1]), (point[0] + text_height * 0.7, point[1])], requirement_id)
                text((point[0], point[1] - text_height * 0.2), target, requirement_id, anchor="middle")
            elif category == "breakMarks":
                points: list[tuple[float, float]] = []
                if stage["cropLimitLines"]:
                    points = [((line_record["modelSpacePointsMm"][0][0] + line_record["modelSpacePointsMm"][-1][0]) / 2.0, (line_record["modelSpacePointsMm"][0][1] + line_record["modelSpacePointsMm"][-1][1]) / 2.0) for line_record in stage["cropLimitLines"]]
                else:
                    for source in stage["structuralLines"]:
                        for point in (source["modelSpacePointsMm"][0], source["modelSpacePointsMm"][-1]):
                            if min(abs(point[0] - x1), abs(point[0] - x2), abs(point[1] - y1), abs(point[1] - y2)) <= 0.001:
                                points.append((float(point[0]), float(point[1])))
                size = text_height * 0.8
                for point in sorted(set(points)):
                    line([(point[0] - size * 1.5, point[1]), (point[0] - size * 0.5, point[1] + size * 0.8), (point[0] + size * 0.5, point[1] - size * 0.8), (point[0] + size * 1.5, point[1])], requirement_id, width=0.18)
            elif requirement_id == "DR-ED-PURLIN":
                target = payload["targetEntityId"]
                points = [point for source in stage["structuralLines"] if source["sourceEntityId"] == target for point in source["modelSpacePointsMm"]]
                _require(points, "eave purlin callout target is absent from IR")
                center = (sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points))
                text((center[0] + text_height * 2, center[1] + text_height * 2), payload["label"], requirement_id)
            elif category in {"viewTitles", "notes", "componentCallouts"}:
                if "text" in payload:
                    values = [payload["text"]]
                elif "label" in payload:
                    values = [payload["label"]]
                else:
                    values = list(payload.get("labels", []))
                for index, value in enumerate(values):
                    if category == "viewTitles":
                        point = (x1 + text_height, y1 - text_height * 1.2)
                    elif category == "notes":
                        point = (x1 + text_height, y2 - text_height * (1.5 + index * 1.2))
                    else:
                        point = (x1 + text_height, y2 - text_height * (2.8 + index * 1.2))
                    text(point, value, requirement_id)
            else:
                raise SheetOutputError(f"unsupported annotation category: {category}")
        return primitives

    def _page_plan(self, layout: dict) -> dict:
        groups: list[dict] = []
        for viewport in layout["viewports"]:
            stage = self.stages[viewport["viewId"]]
            transform = self._view_mapping(viewport, stage)
            lines = []
            for source in stage["structuralLines"]:
                width, dash = self._line_style(source["layer"])
                lines.append({"points": [transform(point) for point in source["modelSpacePointsMm"]], "width": width, "dash": dash, "cadObjectId": source["cadObjectId"], "layer": source["layer"]})
            regions = [{"rings": self._region_rings(stage, region, transform), "pattern": region["targetHatchPatternKey"], "cadObjectId": region["cadObjectId"]} for region in stage["materialRegions"]]
            groups.append({"viewport": viewport, "stage": stage, "lines": lines, "regions": regions, "annotations": self._annotation_primitives(viewport, stage)})
        return {"layout": layout, "groups": groups}

    def _svg_patterns(self, page_plan: dict) -> str:
        chunks: list[str] = []
        for group in page_plan["groups"]:
            scale = float(group["viewport"]["paperScale"])
            view_id = group["stage"]["viewId"]
            for key, source_spacing in (("timber", 18.0), ("stone", 24.0), ("earth", 24.0), ("ceramic", 18.0)):
                spacing = max(0.8, source_spacing * scale)
                pattern_id = f"pat-{view_id}-{key}"
                if key == "timber":
                    body = f'<path d="M 0 0 H {_fmt(spacing)}" stroke="#8b8177" stroke-width="0.12"/>'
                elif key == "stone":
                    body = f'<path d="M 0 {_fmt(spacing)} L {_fmt(spacing)} 0 M 0 0 L {_fmt(spacing)} {_fmt(spacing)}" stroke="#8b8177" stroke-width="0.1"/>'
                elif key == "earth":
                    body = f'<path d="M 0 {_fmt(spacing/2)} H {_fmt(spacing)}" stroke="#8b8177" stroke-width="0.1"/><circle cx="{_fmt(spacing/2)}" cy="{_fmt(spacing/4)}" r="0.16" fill="#8b8177"/>'
                else:
                    body = f'<path d="M 0 {_fmt(spacing)} L {_fmt(spacing)} 0" stroke="#8b8177" stroke-width="0.1"/>'
                chunks.append(f'<pattern id="{pattern_id}" width="{_fmt(spacing)}" height="{_fmt(spacing)}" patternUnits="userSpaceOnUse">{body}</pattern>')
        return "".join(chunks)

    def write_svg(self, page_plan: dict, path: Path) -> dict:
        font_data = base64.b64encode(self.font_path.read_bytes()).decode("ascii")
        layout = page_plan["layout"]
        out = io.StringIO()
        out.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        out.write('<svg xmlns="http://www.w3.org/2000/svg" width="841mm" height="594mm" viewBox="0 0 841 594" role="img">')
        out.write(f'<metadata>{escape(json.dumps({"layoutName": layout["layoutName"], "drawingPackageIrSha256": self.ir["drawingPackageIrSha256"], "status": "generated-not-qualified", "L1": False}, ensure_ascii=False, sort_keys=True, separators=(",", ":")))}</metadata>')
        out.write('<defs>')
        out.write(f'<style>@font-face{{font-family:"Gujian Sans SC";src:url(data:font/ttf;base64,{font_data}) format("truetype");font-weight:400}}text{{font-family:"Gujian Sans SC";font-weight:400;fill:#111}}.structural{{fill:none;stroke:#181818;stroke-linecap:round;stroke-linejoin:round}}.annotation{{fill:none;stroke:#444}}</style>')
        for group in page_plan["groups"]:
            x, y, width, height = group["viewport"]["paperRectMm"]
            out.write(f'<clipPath id="clip-{group["stage"]["viewId"]}"><rect x="{_fmt(x)}" y="{_fmt(PAGE_MM[1]-y-height)}" width="{_fmt(width)}" height="{_fmt(height)}"/></clipPath>')
        out.write(self._svg_patterns(page_plan))
        out.write('</defs><rect width="841" height="594" fill="#fff"/>')
        for group in page_plan["groups"]:
            view_id = group["stage"]["viewId"]
            out.write(f'<g id="view-{view_id}" data-view-id="{view_id}" clip-path="url(#clip-{view_id})">')
            for region in group["regions"]:
                path_data = _polyline_path(region["rings"], PAGE_MM[1])
                out.write(f'<path d="{path_data}" fill="url(#pat-{view_id}-{region["pattern"]})" fill-rule="evenodd" stroke="none" data-object-class="material-region" data-cad-object-id="{region["cadObjectId"]}"/>')
            for source in group["lines"]:
                points = " ".join(f'{_fmt(x)},{_fmt(PAGE_MM[1]-y)}' for x, y in source["points"])
                dash = f' stroke-dasharray="{" ".join(_fmt(value) for value in source["dash"])}"' if source["dash"] else ""
                out.write(f'<polyline class="structural" points="{points}" stroke-width="{_fmt(source["width"])}"{dash} data-object-class="structural" data-layer="{source["layer"]}" data-cad-object-id="{source["cadObjectId"]}"/>')
            for primitive in group["annotations"]:
                requirement = escape(primitive["requirementId"], quote=True)
                if primitive["type"] == "polyline":
                    points = " ".join(f'{_fmt(x)},{_fmt(PAGE_MM[1]-y)}' for x, y in primitive["points"])
                    out.write(f'<polyline class="annotation" points="{points}" stroke-width="{_fmt(primitive["width"])}" data-object-class="annotation" data-requirement-id="{requirement}"/>')
                elif primitive["type"] == "circle":
                    x, y = primitive["center"]
                    out.write(f'<circle class="annotation" cx="{_fmt(x)}" cy="{_fmt(PAGE_MM[1]-y)}" r="{_fmt(primitive["radius"])}" stroke-width="{_fmt(primitive["width"])}" data-object-class="annotation" data-requirement-id="{requirement}"/>')
                else:
                    x, y = primitive["point"]
                    anchor = {"start": "start", "middle": "middle", "end": "end"}[primitive["anchor"]]
                    out.write(f'<text x="{_fmt(x)}" y="{_fmt(PAGE_MM[1]-y)}" font-size="{_fmt(primitive["size"])}" text-anchor="{anchor}" data-object-class="annotation-text" data-requirement-id="{requirement}">{escape(primitive["text"])}</text>')
            out.write('</g>')
            x, y, width, height = group["viewport"]["paperRectMm"]
            out.write(f'<rect x="{_fmt(x)}" y="{_fmt(PAGE_MM[1]-y-height)}" width="{_fmt(width)}" height="{_fmt(height)}" fill="none" stroke="#b8b8b8" stroke-width="0.1" data-view-frame="{view_id}"/>')
        self._svg_paper(out, layout)
        out.write('</svg>\n')
        path.write_text(out.getvalue(), encoding="utf-8", newline="\n")
        raw = path.read_bytes()
        return {"name": path.name, "sha256": sha256(raw).hexdigest(), "vector": True, "searchableText": True, "embeddedFont": True, "pageMm": [841, 594], "structuralObjectCount": sum(len(group["lines"]) for group in page_plan["groups"]), "materialRegionCount": sum(len(group["regions"]) for group in page_plan["groups"])}

    def _title_fields(self, layout: dict) -> list[tuple[str, str]]:
        return [
            ("项目", self.contract["packageIdentity"]["title"]),
            ("图名", layout["title"]),
            ("图号", layout["layoutName"]),
            ("比例", "见图"),
            ("单位", "mm"),
            ("状态", "generated-not-qualified"),
            ("版本", self.contract["contractRevisionId"]),
            ("日期", self.ir["generatedAt"][:10]),
            ("责任边界", "团队演示/非正式签发"),
        ]

    def _svg_paper(self, out: io.StringIO, layout: dict) -> None:
        out.write('<rect x="5" y="5" width="831" height="584" fill="none" stroke="#111" stroke-width="0.5" data-paper-frame="true"/>')
        x, y, width, height = 610.0, 5.0, 226.0, 55.0
        sy = PAGE_MM[1] - y - height
        out.write(f'<g data-object-class="system-title-block" data-requirement-id="{self.title_annotations[layout["layoutName"]]["requirementId"]}"><rect x="{x}" y="{sy}" width="{width}" height="{height}" fill="#fff" stroke="#111" stroke-width="0.35"/>')
        out.write(f'<line x1="{x+113}" y1="{sy}" x2="{x+113}" y2="{sy+height}" stroke="#111" stroke-width="0.18"/>')
        for row in range(1, 5):
            yy = sy + row * 11
            out.write(f'<line x1="{x}" y1="{yy}" x2="{x+width}" y2="{yy}" stroke="#111" stroke-width="0.18"/>')
        for index, (label, value) in enumerate(self._title_fields(layout)):
            column = 0 if index < 5 else 113
            row = index if index < 5 else index - 5
            tx = x + column + 3
            ty = PAGE_MM[1] - (y + 3 + row * 11)
            out.write(f'<text x="{tx}" y="{ty}" font-size="2.5">{escape(label)}：{escape(value)}</text>')
        out.write('</g>')
        self.rendered_requirements.add(self.title_annotations[layout["layoutName"]]["requirementId"])

    def _pdf_path(self, drawing: canvas.Canvas, rings: list[list[tuple[float, float]]]):
        path = drawing.beginPath()
        for ring in rings:
            if len(ring) < 3:
                continue
            path.moveTo(ring[0][0] * PT_PER_MM, ring[0][1] * PT_PER_MM)
            for x, y in ring[1:]:
                path.lineTo(x * PT_PER_MM, y * PT_PER_MM)
            path.close()
        return path

    def _pdf_hatch(self, drawing: canvas.Canvas, rings: list[list[tuple[float, float]]], pattern: str, spacing: float) -> None:
        xs = [point[0] for ring in rings for point in ring]
        ys = [point[1] for ring in rings for point in ring]
        if not xs or not ys:
            return
        xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
        drawing.saveState()
        drawing.clipPath(self._pdf_path(drawing, rings), stroke=0, fill=0, fillMode=0)
        drawing.setFillColorRGB(0.97, 0.965, 0.95)
        drawing.drawPath(self._pdf_path(drawing, rings), stroke=0, fill=1, fillMode=0)
        drawing.setStrokeColorRGB(0.55, 0.51, 0.47)
        drawing.setLineWidth(0.1 * PT_PER_MM)
        spacing = max(0.8, spacing)
        if pattern in {"timber", "earth"}:
            y = ymin - spacing
            while y <= ymax + spacing:
                drawing.line(xmin * PT_PER_MM, y * PT_PER_MM, xmax * PT_PER_MM, y * PT_PER_MM)
                y += spacing
        if pattern in {"stone", "ceramic"}:
            start = xmin - (ymax - ymin) - spacing
            x = start
            while x <= xmax + (ymax - ymin) + spacing:
                drawing.line(x * PT_PER_MM, ymin * PT_PER_MM, (x + ymax - ymin) * PT_PER_MM, ymax * PT_PER_MM)
                if pattern == "stone":
                    drawing.line(x * PT_PER_MM, ymax * PT_PER_MM, (x + ymax - ymin) * PT_PER_MM, ymin * PT_PER_MM)
                x += spacing
        if pattern == "earth":
            drawing.setFillColorRGB(0.55, 0.51, 0.47)
            x = xmin + spacing / 2
            while x <= xmax:
                y = ymin + spacing / 2
                while y <= ymax:
                    drawing.circle(x * PT_PER_MM, y * PT_PER_MM, 0.12 * PT_PER_MM, stroke=0, fill=1)
                    y += spacing
                x += spacing
        drawing.restoreState()

    def _pdf_primitive(self, drawing: canvas.Canvas, primitive: dict) -> None:
        drawing.setStrokeColorRGB(0.25, 0.25, 0.25)
        if primitive["type"] == "polyline":
            drawing.setLineWidth(primitive["width"] * PT_PER_MM)
            path = drawing.beginPath()
            points = primitive["points"]
            path.moveTo(points[0][0] * PT_PER_MM, points[0][1] * PT_PER_MM)
            for x, y in points[1:]:
                path.lineTo(x * PT_PER_MM, y * PT_PER_MM)
            drawing.drawPath(path, stroke=1, fill=0)
        elif primitive["type"] == "circle":
            drawing.setLineWidth(primitive["width"] * PT_PER_MM)
            x, y = primitive["center"]
            drawing.circle(x * PT_PER_MM, y * PT_PER_MM, primitive["radius"] * PT_PER_MM, stroke=1, fill=0)
        else:
            drawing.setFillColorRGB(0.07, 0.07, 0.07)
            drawing.setFont(FONT_ALIAS, primitive["size"] * PT_PER_MM)
            x, y = primitive["point"]
            if primitive["anchor"] == "middle":
                drawing.drawCentredString(x * PT_PER_MM, y * PT_PER_MM, primitive["text"])
            elif primitive["anchor"] == "end":
                drawing.drawRightString(x * PT_PER_MM, y * PT_PER_MM, primitive["text"])
            else:
                drawing.drawString(x * PT_PER_MM, y * PT_PER_MM, primitive["text"])

    def write_pdf(self, page_plans: list[dict], path: Path) -> dict:
        if FONT_ALIAS not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(FONT_ALIAS, str(self.font_path)))
        drawing = canvas.Canvas(
            str(path),
            pagesize=(PAGE_MM[0] * PT_PER_MM, PAGE_MM[1] * PT_PER_MM),
            pageCompression=1,
            invariant=1,
            initialFontName=FONT_ALIAS,
            initialFontSize=2.5 * PT_PER_MM,
        )
        drawing.setTitle("T0-B 古建局部专业样板")
        drawing.setAuthor("GUJIAN-CAD-WORKER")
        drawing.setCreator("DrawingPackageIR deterministic renderer")
        for page_plan in page_plans:
            layout = page_plan["layout"]
            drawing.setFillColorRGB(1, 1, 1)
            drawing.rect(0, 0, PAGE_MM[0] * PT_PER_MM, PAGE_MM[1] * PT_PER_MM, stroke=0, fill=1)
            for group in page_plan["groups"]:
                x, y, width, height = [float(value) for value in group["viewport"]["paperRectMm"]]
                drawing.saveState()
                clip = drawing.beginPath()
                clip.rect(x * PT_PER_MM, y * PT_PER_MM, width * PT_PER_MM, height * PT_PER_MM)
                drawing.clipPath(clip, stroke=0, fill=0)
                scale = float(group["viewport"]["paperScale"])
                for region in group["regions"]:
                    source_spacing = {"timber": 18.0, "stone": 24.0, "earth": 24.0, "ceramic": 18.0}[region["pattern"]]
                    self._pdf_hatch(drawing, region["rings"], region["pattern"], source_spacing * scale)
                for source in group["lines"]:
                    drawing.setStrokeColorRGB(0.09, 0.09, 0.09)
                    drawing.setLineWidth(source["width"] * PT_PER_MM)
                    if source["dash"]:
                        drawing.setDash([value * PT_PER_MM for value in source["dash"]])
                    else:
                        drawing.setDash()
                    path_record = drawing.beginPath()
                    points = source["points"]
                    path_record.moveTo(points[0][0] * PT_PER_MM, points[0][1] * PT_PER_MM)
                    for px, py in points[1:]:
                        path_record.lineTo(px * PT_PER_MM, py * PT_PER_MM)
                    drawing.drawPath(path_record, stroke=1, fill=0)
                drawing.setDash()
                for primitive in group["annotations"]:
                    self._pdf_primitive(drawing, primitive)
                drawing.restoreState()
                drawing.setStrokeColorRGB(0.72, 0.72, 0.72)
                drawing.setLineWidth(0.1 * PT_PER_MM)
                drawing.rect(x * PT_PER_MM, y * PT_PER_MM, width * PT_PER_MM, height * PT_PER_MM, stroke=1, fill=0)
            self._pdf_paper(drawing, layout)
            drawing.showPage()
        drawing.save()
        raw = path.read_bytes()
        _require(b"/FontFile2" in raw and b"GujianSansSC" in raw, "PDF does not contain the embedded drawing font")
        return {"name": path.name, "sha256": sha256(raw).hexdigest(), "pages": 2, "pageMm": [841, 594], "vector": True, "searchableText": True, "embeddedFont": True}

    def _pdf_paper(self, drawing: canvas.Canvas, layout: dict) -> None:
        drawing.setStrokeColorRGB(0.05, 0.05, 0.05)
        drawing.setLineWidth(0.5 * PT_PER_MM)
        drawing.rect(5 * PT_PER_MM, 5 * PT_PER_MM, 831 * PT_PER_MM, 584 * PT_PER_MM, stroke=1, fill=0)
        x, y, width, height = 610.0, 5.0, 226.0, 55.0
        drawing.setLineWidth(0.35 * PT_PER_MM)
        drawing.rect(x * PT_PER_MM, y * PT_PER_MM, width * PT_PER_MM, height * PT_PER_MM, stroke=1, fill=0)
        drawing.setLineWidth(0.18 * PT_PER_MM)
        drawing.line((x + 113) * PT_PER_MM, y * PT_PER_MM, (x + 113) * PT_PER_MM, (y + height) * PT_PER_MM)
        for row in range(1, 5):
            yy = y + row * 11
            drawing.line(x * PT_PER_MM, yy * PT_PER_MM, (x + width) * PT_PER_MM, yy * PT_PER_MM)
        drawing.setFillColorRGB(0.05, 0.05, 0.05)
        drawing.setFont(FONT_ALIAS, 2.5 * PT_PER_MM)
        for index, (label, value) in enumerate(self._title_fields(layout)):
            column = 0 if index < 5 else 113
            row = index if index < 5 else index - 5
            drawing.drawString((x + column + 3) * PT_PER_MM, (y + 3 + row * 11) * PT_PER_MM, f"{label}：{value}")

    def _png_point(self, point: tuple[float, float]) -> tuple[int, int]:
        return (round(point[0] / PAGE_MM[0] * PNG_SIZE[0]), round((PAGE_MM[1] - point[1]) / PAGE_MM[1] * PNG_SIZE[1]))

    def _png_hatch(self, image: Image.Image, rings: list[list[tuple[float, float]]], pattern: str, spacing_mm: float) -> None:
        pixel_rings = [[self._png_point(point) for point in ring] for ring in rings]
        xs = [point[0] for ring in pixel_rings for point in ring]
        ys = [point[1] for ring in pixel_rings for point in ring]
        if not xs or not ys:
            return
        left, top = max(0, min(xs)), max(0, min(ys))
        right, bottom = min(PNG_SIZE[0] - 1, max(xs)), min(PNG_SIZE[1] - 1, max(ys))
        width, height = right - left + 1, bottom - top + 1
        if width <= 1 or height <= 1:
            return
        local = [[(x - left, y - top) for x, y in ring] for ring in pixel_rings]
        region_mask = Image.new("L", (width, height), 0)
        mask_draw = ImageDraw.Draw(region_mask)
        mask_draw.polygon(local[0], fill=255)
        for hole in local[1:]:
            mask_draw.polygon(hole, fill=0)
        image.paste((247, 245, 241), (left, top, right + 1, bottom + 1), region_mask)
        hatch_mask = Image.new("L", (width, height), 0)
        hatch_draw = ImageDraw.Draw(hatch_mask)
        spacing = max(8, round(spacing_mm / PAGE_MM[0] * PNG_SIZE[0]))
        stroke = max(1, round(0.1 / PAGE_MM[0] * PNG_SIZE[0]))
        if pattern in {"timber", "earth"}:
            for y in range(0, height + spacing, spacing):
                hatch_draw.line((0, y, width, y), fill=255, width=stroke)
        if pattern in {"stone", "ceramic"}:
            for offset in range(-height, width + height, spacing):
                hatch_draw.line((offset, height, offset + height, 0), fill=255, width=stroke)
                if pattern == "stone":
                    hatch_draw.line((offset, 0, offset + height, height), fill=255, width=stroke)
        if pattern == "earth":
            radius = max(1, stroke)
            for x in range(spacing // 2, width, spacing):
                for y in range(spacing // 2, height, spacing):
                    hatch_draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
        hatch_mask = ImageChops.multiply(hatch_mask, region_mask)
        image.paste((128, 119, 110), (left, top, right + 1, bottom + 1), hatch_mask)

    def _png_text(self, draw: ImageDraw.ImageDraw, primitive: dict) -> None:
        size_px = max(18, round(primitive["size"] / PAGE_MM[1] * PNG_SIZE[1]))
        font = ImageFont.truetype(str(self.font_path), size=size_px)
        x, y = self._png_point(primitive["point"])
        bbox = draw.textbbox((0, 0), primitive["text"], font=font)
        width = bbox[2] - bbox[0]
        if primitive["anchor"] == "middle":
            x -= width // 2
        elif primitive["anchor"] == "end":
            x -= width
        draw.text((x, y - size_px), primitive["text"], font=font, fill=(20, 20, 20))

    def write_png(self, page_plan: dict, path: Path) -> dict:
        image = Image.new("RGB", PNG_SIZE, (255, 255, 255))
        draw = ImageDraw.Draw(image)
        for group in page_plan["groups"]:
            x, y, width, height = [float(value) for value in group["viewport"]["paperRectMm"]]
            scale = float(group["viewport"]["paperScale"])
            for region in group["regions"]:
                source_spacing = {"timber": 18.0, "stone": 24.0, "earth": 24.0, "ceramic": 18.0}[region["pattern"]]
                self._png_hatch(image, region["rings"], region["pattern"], source_spacing * scale)
            for source in group["lines"]:
                points = [self._png_point(point) for point in source["points"]]
                width_px = max(1, round(source["width"] / PAGE_MM[0] * PNG_SIZE[0]))
                draw.line(points, fill=(22, 22, 22), width=width_px, joint="curve")
            for primitive in group["annotations"]:
                if primitive["type"] == "polyline":
                    draw.line([self._png_point(point) for point in primitive["points"]], fill=(55, 55, 55), width=max(1, round(primitive["width"] / PAGE_MM[0] * PNG_SIZE[0])), joint="curve")
                elif primitive["type"] == "circle":
                    cx, cy = self._png_point(primitive["center"])
                    radius = round(primitive["radius"] / PAGE_MM[0] * PNG_SIZE[0])
                    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=(55, 55, 55), width=max(1, round(primitive["width"] / PAGE_MM[0] * PNG_SIZE[0])))
                else:
                    self._png_text(draw, primitive)
            left, top = self._png_point((x, y + height))
            right, bottom = self._png_point((x + width, y))
            draw.rectangle((left, top, right, bottom), outline=(190, 190, 190), width=1)
        self._png_paper(draw, page_plan["layout"])
        image.save(path, format="PNG", compress_level=9, optimize=False, dpi=(300, 300))
        raw = path.read_bytes()
        return {"name": path.name, "sha256": sha256(raw).hexdigest(), "pixelSize": [9933, 7016], "dpi": 300, "sourceIrRequired": True}

    def _png_paper(self, draw: ImageDraw.ImageDraw, layout: dict) -> None:
        def rect(x, y, width, height, line_width):
            left, top = self._png_point((x, y + height))
            right, bottom = self._png_point((x + width, y))
            draw.rectangle((left, top, right, bottom), outline=(15, 15, 15), width=max(1, round(line_width / PAGE_MM[0] * PNG_SIZE[0])))
        rect(5, 5, 831, 584, 0.5)
        rect(610, 5, 226, 55, 0.35)
        x, y = 610.0, 5.0
        draw.line((self._png_point((x + 113, y)), self._png_point((x + 113, y + 55))), fill=(20, 20, 20), width=2)
        for row in range(1, 5):
            draw.line((self._png_point((x, y + row * 11)), self._png_point((x + 226, y + row * 11))), fill=(20, 20, 20), width=2)
        font = ImageFont.truetype(str(self.font_path), size=round(2.5 / PAGE_MM[1] * PNG_SIZE[1]))
        for index, (label, value) in enumerate(self._title_fields(layout)):
            column = 0 if index < 5 else 113
            row = index if index < 5 else index - 5
            px, py = self._png_point((x + column + 3, y + 3 + row * 11))
            draw.text((px, py - font.size), f"{label}：{value}", font=font, fill=(15, 15, 15))

    def build(self, output_dir: Path) -> dict:
        page_plans = [self._page_plan(layout) for layout in self.ir["paperSpace"]["layouts"]]
        staging = output_dir.parent / f".{output_dir.name}.staging-{uuid4().hex}"
        staging.mkdir(parents=True, exist_ok=False)
        try:
            svg_outputs = [self.write_svg(plan, staging / f"{plan['layout']['layoutName']}.svg") for plan in page_plans]
            pdf_output = self.write_pdf(page_plans, staging / "T0B.pdf")
            png_outputs = [self.write_png(plan, staging / f"{plan['layout']['layoutName']}-300dpi.png") for plan in page_plans]
            expected_requirements = {annotation["requirementId"] for annotation in self.ir["annotations"]}
            _require(self.rendered_requirements == expected_requirements, "not every IR annotation requirement was rendered")
            record = {
                "schemaVersion": "t0b-v2-sheet-output-build-1",
                "status": "generated-not-qualified",
                "L1": False,
                "useBoundary": ["demo-only", "not-for-formal-signoff"],
                "generatedAt": self.ir["generatedAt"],
                "inputs": {
                    "drawingPackageContract": {"signature": self.contract["contractSignature"], "revisionId": self.contract["contractRevisionId"]},
                    "drawingPackageIr": {"drawingPackageIrSha256": self.ir["drawingPackageIrSha256"]},
                    "font": {"family": self.font_manifest["family"], "postScriptName": self.font_manifest["postScriptName"], "sha256": self.font_manifest["sha256"], "manifestPayloadSha256": self.font_manifest["manifestPayloadSha256"], "instanceWeight": 400, "fsType": 0, "licenseSpdx": "OFL-1.1"},
                },
                "outputs": {"svg": svg_outputs, "pdf": pdf_output, "reviewPng": png_outputs},
                "layoutClosure": {"sheetCount": 2, "viewCount": 10, "viewsPerSheet": [5, 5], "pageMm": [841, 594], "renderedRequirementCount": len(self.rendered_requirements)},
                "fontClosure": {"embeddedInSvg": True, "embeddedInPdf": True, "usedByPng": True, "missingGlyphs": 0, "fontSubstitutions": 0, "questionMarkPlaceholders": 0},
                "qualification": {"requiredBlockers": self.ir["qualificationBoundary"]["requiredBlockers"], "generatorMaySetEligible": False},
            }
            (staging / BUILD_RECORD_NAME).write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")
            for path in staging.iterdir():
                if path.is_file() and path.suffix.lower() in {".svg", ".pdf", ".json"}:
                    lowered = path.read_bytes().decode("utf-8", errors="ignore").lower()
                    inspectable = lowered
                    if path.suffix.lower() == ".svg":
                        inspectable = re.sub(r"base64,[a-z0-9+/=]+", "base64:embedded-font", inspectable)
                    elif path.suffix.lower() == ".pdf":
                        inspectable = re.sub(r"stream.*?endstream", "stream", inspectable, flags=re.DOTALL)
                    _require(not any(token in inspectable for token in FORBIDDEN_OUTPUT_TOKENS), f"{path.name} contains a forbidden external token")
                    _require(re.search(r"(?<![a-z])[a-z]:[/\\]", inspectable) is None, f"{path.name} contains an absolute path")
            if output_dir.exists():
                backup = output_dir.parent / f".{output_dir.name}.previous-{uuid4().hex}"
                os.replace(output_dir, backup)
                try:
                    os.replace(staging, output_dir)
                except Exception:
                    os.replace(backup, output_dir)
                    raise
                shutil.rmtree(backup)
            else:
                os.replace(staging, output_dir)
            return record
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise


def build_sheet_outputs(contract_path: Path, ir_path: Path, font_config_path: Path, output_dir: Path) -> dict:
    _require(contract_path.name == "t0b-v2-drawing-package-contract.json", "unexpected contract input")
    _require(ir_path.name == "drawing-package.ir.json.gz", "unexpected IR input")
    _require(font_config_path.name == "logical_font_config.json", "unexpected font config input")
    contract = load_drawing_package_contract(contract_path)
    ir = _load_ir(ir_path)
    font_config = _load_json(font_config_path)
    font_path = REPOSITORY_ROOT / Path(*font_config["fontAssetRelativePath"].split("/"))
    font_manifest_path = REPOSITORY_ROOT / Path(*font_config["fontManifestRelativePath"].split("/"))
    _require(font_path.is_file() and font_manifest_path.is_file(), "bound font asset is missing")
    _require(_file_hash(font_path) == font_config["fontSha256"], "font file hash differs")
    _require(_file_hash(font_manifest_path) == font_config["fontManifestSha256"], "font manifest hash differs")
    generator = DrawingSheetGenerator(contract, ir, font_config, _load_json(font_manifest_path), font_path)
    return generator.build(output_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate A1 SVG, PDF and 300dpi PNG sheets from frozen DrawingPackageIR.")
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--ir", type=Path, required=True)
    parser.add_argument("--font-config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    record = build_sheet_outputs(args.contract, args.ir, args.font_config, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
