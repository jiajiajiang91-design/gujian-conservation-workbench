from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import re
from pathlib import Path
from typing import Any, Callable, NamedTuple

from fontTools import subset
from fontTools.ttLib import TTFont as FontToolsFont
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


MM_TO_POINT = 72.0 / 25.4
PX_PER_MM_300 = 300.0 / 25.4


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def annotation_bands(requirement: dict[str, Any]) -> tuple[float, float, float]:
    """本视图要留的左、右、下三条标注带宽度，单位纸面毫米。"""
    plan = requirement.get("annotationPlan") or {}
    axes = plan.get("axes", [])
    has_u_axes = any(item["along"] == "u" for item in axes)
    has_v_axes = any(item["along"] == "v" for item in axes)
    has_levels = bool(plan.get("levels"))
    left = AXIS_BUBBLE_OFFSET_PAPER_MM + AXIS_BUBBLE_RADIUS_PAPER_MM if has_v_axes else EDGE_CLEARANCE_PAPER_MM
    right = LEVEL_BAND_PAPER_MM if has_levels else EDGE_CLEARANCE_PAPER_MM
    bottom = ANNOTATION_BAND_PAPER_MM if has_u_axes else TITLE_OFFSET_PAPER_MM - AXIS_BUBBLE_OFFSET_PAPER_MM + 12.0
    return left, right, bottom


def _view_transform(view: dict[str, Any], requirement: dict[str, Any]) -> Callable[[list[float]], tuple[float, float]]:
    bounds = view["boundsMm"]
    rect = requirement["viewportRectMm"]
    scale = float(requirement["scaleDenominator"])
    model_center = ((bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2)
    model_width = (bounds[1][0] - bounds[0][0]) / scale
    model_height = (bounds[1][1] - bounds[0][1]) / scale
    left, right, bottom = annotation_bands(requirement)
    drawing_width = rect[2] - left - right
    drawing_height = rect[3] - bottom - EDGE_CLEARANCE_PAPER_MM
    paper_center = (rect[0] + left + drawing_width / 2, rect[1] + bottom + drawing_height / 2)
    if model_width > drawing_width or model_height > drawing_height:
        raise ValueError(
            f"view {view['viewKey']} does not fit its frozen viewport at 1:{int(scale)}: "
            f"needs {model_width + left + right:.0f} x {model_height + bottom + EDGE_CLEARANCE_PAPER_MM:.0f} mm, "
            f"viewport is {rect[2]:.0f} x {rect[3]:.0f} mm"
        )
    def transform(point: list[float]) -> tuple[float, float]:
        return paper_center[0] + (point[0] - model_center[0]) / scale, paper_center[1] + (point[1] - model_center[1]) / scale
    return transform


def _sheet_content(ir: dict[str, Any], sheet: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    views = [item for item in ir["views"] if item["viewId"] in sheet["viewIds"]]
    requirements = {item["id"]: item for item in ir["viewRequirements"]}
    return views, requirements


# 图签固定在右下角，占 x 从右边距起 221 mm、y 从下边距起 30 mm。
TITLE_BLOCK_WIDTH_MM = 221.0
TITLE_BLOCK_HEIGHT_MM = 30.0
SHEET_MARGIN_MM = 5.0
TITLE_BLOCK_CLEARANCE_MM = 3.0


def _title_block_rect(page_width: float) -> tuple[float, float, float, float]:
    left = page_width - SHEET_MARGIN_MM - TITLE_BLOCK_WIDTH_MM
    return left, SHEET_MARGIN_MM, page_width - SHEET_MARGIN_MM, SHEET_MARGIN_MM + TITLE_BLOCK_HEIGHT_MM


# 标注排布的共用规则。三个渲染器（SVG、PDF、PNG）都从这里取纸面图元，
# 各自只负责把图元翻成自己的输出格式，不再各写一遍该标什么、标在哪。
#
# 标注内容与模型坐标锚点来自 IR，这里只做两件事：把锚点按视图变换换算到
# 纸面，再按制图惯例加纸面偏移。
#
# 图形下沿之外自上而下依次是：轴间尺寸链、图形总尺寸、轴号圈、图名。
# 视口按本视图实际会画的标注预留边带，图形在余下的范围里居中，不再简单
# 居中后往外画——那样标注会越出视口落到图签上。边带按需留：没有轴网的
# 视图不必白留轴号圈的位置，否则每张图都要为不存在的标注放大一圈。
CHAIN_OFFSET_PAPER_MM = 8.0
DIMENSION_OFFSET_PAPER_MM = 16.0
AXIS_BUBBLE_OFFSET_PAPER_MM = 26.0
AXIS_BUBBLE_RADIUS_PAPER_MM = 3.5
TITLE_OFFSET_PAPER_MM = 36.0
ANNOTATION_BAND_PAPER_MM = 42.0
DIMENSION_TICK_PAPER_MM = 2.0
# 标高符号排在图形右沿之外
LEVEL_OFFSET_PAPER_MM = 4.0
LEVEL_BAND_PAPER_MM = 30.0
# 图形与视口边的最小净距
EDGE_CLEARANCE_PAPER_MM = 4.0


class PaperPrimitive(NamedTuple):
    kind: str                                  # line、circle 或 text
    points: tuple[tuple[float, float], ...]    # 纸面毫米，y 自页底向上
    text: str | None
    height_mm: float                           # text 用字高，circle 用半径
    align: str                                 # start 或 middle
    tone: str                                  # ink、dim、axis 或 condition


def _annotation_rows(view: dict[str, Any], requirement: dict[str, Any], page_width: float) -> tuple[float, float, float, float]:
    """图形下沿的纸面位置与两条标注行的高度。视口已含标注带，无需再避让图签。"""
    bounds = view["boundsMm"]
    rect = requirement["viewportRectMm"]
    transform = _view_transform(view, requirement)
    x1, drawn_bottom = transform([bounds[0][0], bounds[0][1]])
    x2 = transform([bounds[1][0], bounds[0][1]])[0]
    title_left, _title_bottom, title_right, title_top = _title_block_rect(page_width)
    # 视口若落在图签带内属于版面定义错误，交由可打印区检查报出，这里只断言
    if rect[1] < title_top + TITLE_BLOCK_CLEARANCE_MM and rect[0] + rect[2] > title_left and rect[0] < title_right:
        raise ValueError(f"view {view['viewKey']} viewport overlaps the title block")
    return x1, x2, drawn_bottom - DIMENSION_OFFSET_PAPER_MM, drawn_bottom - TITLE_OFFSET_PAPER_MM


def annotation_primitives(
    annotation: dict[str, Any], view: dict[str, Any], requirement: dict[str, Any], page_width: float,
) -> list[PaperPrimitive]:
    """把一条 IR 标注换算成纸面图元。space 为 modelSpaceOnly 的返回空列表。"""
    if annotation.get("space") == "modelSpaceOnly":
        # 资格声明只画在模型空间：纸面成果由图签承载同一句话，不重复画
        return []
    kind = annotation["kind"]
    height = float(annotation["paperTextHeightMm"])
    x1, x2, dimension_y, label_y = _annotation_rows(view, requirement, page_width)
    drawn_bottom = dimension_y + DIMENSION_OFFSET_PAPER_MM

    if kind == "overallDimension":
        tick = DIMENSION_TICK_PAPER_MM
        return [
            PaperPrimitive("line", ((x1, dimension_y), (x2, dimension_y)), None, 0.0, "start", "dim"),
            PaperPrimitive("line", ((x1, dimension_y - tick), (x1, dimension_y + tick)), None, 0.0, "start", "dim"),
            PaperPrimitive("line", ((x2, dimension_y - tick), (x2, dimension_y + tick)), None, 0.0, "start", "dim"),
            PaperPrimitive("text", (((x1 + x2) / 2, dimension_y + 1.5),), annotation["text"], height, "middle", "ink"),
        ]

    if kind == "viewTitle":
        label_x = min(x1, requirement["viewportRectMm"][0])
        return [PaperPrimitive("text", ((label_x, label_y),), annotation["text"], height, "start", "ink")]

    if kind == "axisGrid":
        transform = _view_transform(view, requirement)
        far, near = (transform(point) for point in annotation["anchorMm"])
        along = annotation["along"]
        if along == "u":
            end = (near[0], drawn_bottom - AXIS_BUBBLE_OFFSET_PAPER_MM + AXIS_BUBBLE_RADIUS_PAPER_MM)
            bubble = (near[0], drawn_bottom - AXIS_BUBBLE_OFFSET_PAPER_MM)
        else:
            left = min(x1, x2) - AXIS_BUBBLE_OFFSET_PAPER_MM
            end = (left + AXIS_BUBBLE_RADIUS_PAPER_MM, near[1])
            bubble = (left, near[1])
        return [
            PaperPrimitive("line", (far, end), None, 0.0, "start", "axis"),
            PaperPrimitive("circle", (bubble,), None, AXIS_BUBBLE_RADIUS_PAPER_MM, "middle", "axis"),
            PaperPrimitive("text", ((bubble[0], bubble[1] - height / 3),), annotation["text"], height, "middle", "axis"),
        ]

    if kind == "axisDimensionChain":
        transform = _view_transform(view, requirement)
        first, second = (transform(point) for point in annotation["anchorMm"])
        tick = DIMENSION_TICK_PAPER_MM
        if annotation["along"] == "u":
            row = drawn_bottom - CHAIN_OFFSET_PAPER_MM
            ends = ((first[0], row), (second[0], row))
            ticks = [
                PaperPrimitive("line", ((value, row - tick), (value, row + tick)), None, 0.0, "start", "dim")
                for value in (first[0], second[0])
            ]
            label = PaperPrimitive("text", (((first[0] + second[0]) / 2, row + 1.0),), annotation["text"], height, "middle", "dim")
        else:
            column = min(x1, x2) - CHAIN_OFFSET_PAPER_MM
            ends = ((column, first[1]), (column, second[1]))
            ticks = [
                PaperPrimitive("line", ((column - tick, value), (column + tick, value)), None, 0.0, "start", "dim")
                for value in (first[1], second[1])
            ]
            label = PaperPrimitive("text", ((column - 1.0, (first[1] + second[1]) / 2),), annotation["text"], height, "middle", "dim")
        return [PaperPrimitive("line", ends, None, 0.0, "start", "dim"), *ticks, label]

    if kind == "levelMark":
        transform = _view_transform(view, requirement)
        point = transform(annotation["anchorMm"][0])
        base = max(x1, x2) + LEVEL_OFFSET_PAPER_MM
        arrow = AXIS_BUBBLE_RADIUS_PAPER_MM
        return [
            PaperPrimitive("line", ((point[0], point[1]), (base, point[1])), None, 0.0, "start", "dim"),
            PaperPrimitive("line", ((base, point[1]), (base + arrow, point[1] + arrow)), None, 0.0, "start", "dim"),
            PaperPrimitive("line", ((base, point[1]), (base + arrow, point[1] - arrow)), None, 0.0, "start", "dim"),
            PaperPrimitive("text", ((base + arrow + 1.0, point[1] + 0.5),), annotation["text"], height, "start", "dim"),
        ]

    if kind == "conditionCandidate":
        rect = requirement["viewportRectMm"]
        return [PaperPrimitive("text", ((rect[0] + 3, rect[1] + rect[3] - 6),), annotation["text"], height, "start", "condition")]

    raise ValueError(f"unsupported annotation kind: {kind}")


def sheet_primitives(ir: dict[str, Any], sheet: dict[str, Any], page_width: float) -> list[PaperPrimitive]:
    """本张图纸的全部纸面标注图元，按 IR 的标注顺序。"""
    views = {item["viewId"]: item for item in ir["views"] if item["viewId"] in sheet["viewIds"]}
    requirements = {item["id"]: item for item in ir["viewRequirements"]}
    out: list[PaperPrimitive] = []
    for annotation in ir["annotations"]:
        view = views.get(annotation["viewId"])
        if view is None:
            continue
        out.extend(annotation_primitives(annotation, view, requirements[annotation["viewId"]], page_width))
    return out

# 本张图实际用到的字符。从已拼好的图形里取，不另维护一份清单，
# 免得图上加了新文字而清单没跟上，裁出来的字体缺字。
def _svg_text_characters(markup: str) -> set[str]:
    found: set[str] = set()
    for chunk in re.findall(r">([^<]*)</text>", markup):
        found.update(html.unescape(chunk))
    return found


# 字体按本张图用到的字符裁剪后再内嵌。整份字体三万零八百九十字，
# 一张图只用到几十字；不裁剪时每张 SVG 要背十三兆多的无用字形，
# 用户下载的每一张图都在背这个包袱。
def _subset_font_base64(font_path: Path, characters: set[str]) -> str:
    wanted = {ord(item) for item in characters if item.strip()}
    if not wanted:
        return base64.b64encode(font_path.read_bytes()).decode("ascii")
    # 时间戳与包围盒都不重算：同一输入必须产出逐字节相同的包，
    # 重算会把当前时刻写进 head 表，两次构建就对不上。
    font = FontToolsFont(str(font_path), recalcTimestamp=False, recalcBBoxes=False)
    available: set[int] = set()
    for table in font["cmap"].tables:
        available.update(table.cmap.keys())
    missing = sorted(wanted - available)
    if missing:
        # 缺字不能静默出豆腐块：图面上显示为空白方块而没人察觉
        font.close()
        raise ValueError("font is missing glyphs for: " + "".join(chr(item) for item in missing))
    options = subset.Options()
    options.notdef_outline = True
    options.recalc_bounds = False
    options.recalc_timestamp = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=sorted(wanted))
    subsetter.subset(font)
    buffer = io.BytesIO()
    font.save(buffer)
    font.close()
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class SheetArtifactWriter:
    def __init__(self, ir: dict[str, Any], font_path: Path):
        self.ir = ir
        self.font_path = font_path
        if not font_path.is_file():
            raise ValueError("bound drawing font is missing")

    def _svg(self, sheet: dict[str, Any], output_path: Path) -> None:
        width, height = sheet["pageMm"]
        views, requirements = _sheet_content(self.ir, sheet)
        # 字体在正文拼好之后再按实际用字裁剪内嵌，这里先占位
        parts = [
            "@@SVG_HEAD@@",
            '.cut{stroke:#111;stroke-width:.5}.outline{stroke:#111;stroke-width:.35}.projection{stroke:#4b514d;stroke-width:.18}.hatch{fill:url(#hatch);stroke:none}.frame{fill:none;stroke:#111;stroke-width:.35}.condition{fill:none;stroke:#a43c32;stroke-width:.3}.axis{stroke:#7a6a52;stroke-width:.18;fill:none;stroke-dasharray:6 2 1 2}.text{font-family:"Gujian Sans SC";fill:#111}',
            '</style><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#999" stroke-width=".12"/></pattern>',
            '</defs>',
            f'<rect class="frame" x="5" y="5" width="{width-10}" height="{height-10}"/>',
        ]
        for view in views:
            requirement = requirements[view["viewId"]]
            transform = _view_transform(view, requirement)
            rect = requirement["viewportRectMm"]
            clip_id = f"clip-{view['drawingRef']}"
            parts.append(f'<clipPath id="{clip_id}"><rect x="{rect[0]}" y="{height-(rect[1]+rect[3])}" width="{rect[2]}" height="{rect[3]}"/></clipPath>')
            parts.append(f'<g data-view-ref="{html.escape(view["drawingRef"])}" clip-path="url(#{clip_id})">')
            for region in view["materialRegions"]:
                points = [transform(point) for point in region["boundaryMm"]]
                paper = " ".join(f"{x:.4f},{height-y:.4f}" for x, y in points)
                parts.append(f'<polygon class="hatch" points="{paper}" data-source-entity="{region["sourceEntityId"]}"/>')
            for line in view["lines"]:
                first, last = (transform(point) for point in line["pointsMm"])
                css = "cut" if line["lineClass"] == "cut" else "outline" if line["lineClass"] == "silhouette" else "projection"
                parts.append(f'<line class="{css}" x1="{first[0]:.4f}" y1="{height-first[1]:.4f}" x2="{last[0]:.4f}" y2="{height-last[1]:.4f}" data-source-entity="{line["sourceEntityId"]}"/>')
            parts.append('</g>')
        # 标注从共用图元取，不在此另算一遍
        for item in sheet_primitives(self.ir, sheet, width):
            if item.kind == "line":
                (ax, ay), (bx, by) = item.points
                css = "axis" if item.tone == "axis" else "projection"
                parts.append(f'<line class="{css}" x1="{ax:.4f}" y1="{height-ay:.4f}" x2="{bx:.4f}" y2="{height-by:.4f}"/>')
                continue
            if item.kind == "circle":
                (cx, cy) = item.points[0]
                parts.append(f'<circle cx="{cx:.4f}" cy="{height-cy:.4f}" r="{item.height_mm:g}" fill="none" stroke="#7a6a52" stroke-width=".25"/>')
                continue
            (tx, ty) = item.points[0]
            anchor = ' text-anchor="middle"' if item.align == "middle" else ""
            fill = ' fill="#a43c32"' if item.tone == "condition" else ""
            parts.append(
                f'<text class="text" x="{tx:.4f}" y="{height-ty:.4f}"{anchor} font-size="{item.height_mm:g}"{fill}>'
                f'{html.escape(item.text or "")}</text>'
            )
        title_x, title_y = width - 226, height - 35
        parts.extend([
            f'<rect class="frame" x="{title_x}" y="{title_y}" width="221" height="30"/>',
            f'<text class="text" x="{title_x+3}" y="{title_y+8}" font-size="4">{html.escape(self.ir["titleZh"])}</text>',
            f'<text class="text" x="{title_x+3}" y="{title_y+16}" font-size="4">{html.escape(sheet["displayLabelZh"])}</text>',
            f'<text class="text" x="{title_x+3}" y="{title_y+24}" font-size="3">{html.escape(sheet["drawingNumber"])}　代理成果·未签发　{html.escape(self.ir["revisionLabel"])}　日期：未签发</text>',
        ])
        parts.append('</svg>')
        body = "".join(parts)
        head = "".join([
            '<?xml version="1.0" encoding="UTF-8"?>',
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}mm" height="{height}mm" viewBox="0 0 {width} {height}">',
            '<defs><style>',
            f'@font-face{{font-family:"Gujian Sans SC";'
            f'src:url(data:font/ttf;base64,{_subset_font_base64(self.font_path, _svg_text_characters(body))})'
            f' format("truetype");font-weight:400;}}',
        ])
        output_path.write_text(body.replace("@@SVG_HEAD@@", head, 1), encoding="utf-8", newline="\n")

    def _pdf(self, output_path: Path) -> None:
        pdfmetrics.registerFont(TTFont("GujianSansSC", str(self.font_path)))
        first = self.ir["sheets"][0]
        pdf = canvas.Canvas(str(output_path), pagesize=(first["pageMm"][0] * MM_TO_POINT, first["pageMm"][1] * MM_TO_POINT), pageCompression=1, invariant=1)
        pdf.setAuthor("古建保护成果工作台")
        pdf.setTitle("代理成果·未签发")
        for sheet_index, sheet in enumerate(self.ir["sheets"]):
            width, height = sheet["pageMm"]
            if sheet_index:
                pdf.setPageSize((width * MM_TO_POINT, height * MM_TO_POINT))
            views, requirements = _sheet_content(self.ir, sheet)
            pdf.setLineWidth(0.35 * MM_TO_POINT)
            pdf.rect(5 * MM_TO_POINT, 5 * MM_TO_POINT, (width - 10) * MM_TO_POINT, (height - 10) * MM_TO_POINT)
            for view in views:
                transform = _view_transform(view, requirements[view["viewId"]])
                for region in view["materialRegions"]:
                    points = [transform(point) for point in region["boundaryMm"]]
                    path = pdf.beginPath()
                    path.moveTo(points[0][0] * MM_TO_POINT, points[0][1] * MM_TO_POINT)
                    for point in points[1:]:
                        path.lineTo(point[0] * MM_TO_POINT, point[1] * MM_TO_POINT)
                    path.close()
                    pdf.setFillColorRGB(0.92, 0.92, 0.92)
                    pdf.drawPath(path, fill=1, stroke=0)
                pdf.setFillColorRGB(0.05, 0.05, 0.05)
                for line in view["lines"]:
                    first_point, last_point = (transform(point) for point in line["pointsMm"])
                    width_mm = 0.5 if line["lineClass"] == "cut" else 0.35 if line["lineClass"] == "silhouette" else 0.18
                    pdf.setLineWidth(width_mm * MM_TO_POINT)
                    pdf.setStrokeColorRGB(0.05, 0.05, 0.05)
                    pdf.line(first_point[0] * MM_TO_POINT, first_point[1] * MM_TO_POINT, last_point[0] * MM_TO_POINT, last_point[1] * MM_TO_POINT)
            # 标注从共用图元取，与 SVG、PNG 同一份来源
            for item in sheet_primitives(self.ir, sheet, width):
                if item.kind in ("line", "circle"):
                    pdf.setLineWidth(0.18 * MM_TO_POINT)
                    pdf.setStrokeColorRGB(*((0.48, 0.42, 0.32) if item.tone == "axis" else (0.05, 0.05, 0.05)))
                    if item.kind == "circle":
                        (cx, cy) = item.points[0]
                        pdf.circle(cx * MM_TO_POINT, cy * MM_TO_POINT, item.height_mm * MM_TO_POINT, stroke=1, fill=0)
                    else:
                        (ax, ay), (bx, by) = item.points
                        pdf.line(ax * MM_TO_POINT, ay * MM_TO_POINT, bx * MM_TO_POINT, by * MM_TO_POINT)
                    continue
                tx, ty = item.points[0]
                pdf.setFillColorRGB(*(
                    (0.64, 0.16, 0.12) if item.tone == "condition"
                    else (0.48, 0.42, 0.32) if item.tone == "axis"
                    else (0.05, 0.05, 0.05)
                ))
                pdf.setFont("GujianSansSC", item.height_mm * MM_TO_POINT)
                if item.align == "middle":
                    pdf.drawCentredString(tx * MM_TO_POINT, ty * MM_TO_POINT, item.text or "")
                else:
                    pdf.drawString(tx * MM_TO_POINT, ty * MM_TO_POINT, item.text or "")
            pdf.setFillColorRGB(0.05, 0.05, 0.05)
            title_x = width - 226
            pdf.setLineWidth(0.35 * MM_TO_POINT)
            pdf.rect(title_x * MM_TO_POINT, 5 * MM_TO_POINT, 221 * MM_TO_POINT, 30 * MM_TO_POINT)
            pdf.setFont("GujianSansSC", 4 * MM_TO_POINT)
            pdf.drawString((title_x + 3) * MM_TO_POINT, 27 * MM_TO_POINT, self.ir["titleZh"])
            pdf.drawString((title_x + 3) * MM_TO_POINT, 19 * MM_TO_POINT, sheet["displayLabelZh"])
            pdf.setFont("GujianSansSC", 3 * MM_TO_POINT)
            pdf.drawString((title_x + 3) * MM_TO_POINT, 11 * MM_TO_POINT, f"{sheet['drawingNumber']}　代理成果·未签发　{self.ir['revisionLabel']}　日期：未签发")
            pdf.showPage()
        pdf.save()

    def _png(self, sheet: dict[str, Any], output_path: Path) -> None:
        width_mm, height_mm = sheet["pageMm"]
        width_px, height_px = round(width_mm * PX_PER_MM_300), round(height_mm * PX_PER_MM_300)
        image = Image.new("RGB", (width_px, height_px), "white")
        draw = ImageDraw.Draw(image)
        title_font = ImageFont.truetype(str(self.font_path), round(4 * PX_PER_MM_300))
        small_font = ImageFont.truetype(str(self.font_path), round(3 * PX_PER_MM_300))
        scale = PX_PER_MM_300
        draw.rectangle((5 * scale, 5 * scale, (width_mm - 5) * scale, (height_mm - 5) * scale), outline="#111111", width=max(1, round(.35 * scale)))
        views, requirements = _sheet_content(self.ir, sheet)
        for view in views:
            transform = _view_transform(view, requirements[view["viewId"]])
            for region in view["materialRegions"]:
                points = [(x * scale, (height_mm - y) * scale) for x, y in (transform(point) for point in region["boundaryMm"])]
                draw.polygon(points, fill="#e9e9e9")
            for line in view["lines"]:
                first, last = (transform(point) for point in line["pointsMm"])
                y1, y2 = height_mm - first[1], height_mm - last[1]
                line_width = .5 if line["lineClass"] == "cut" else .35 if line["lineClass"] == "silhouette" else .18
                draw.line((first[0] * scale, y1 * scale, last[0] * scale, y2 * scale), fill="#111111", width=max(1, round(line_width * scale)))
        # 标注从共用图元取，与 SVG、PDF 同一份来源
        fonts: dict[float, Any] = {}
        for item in sheet_primitives(self.ir, sheet, width_mm):
            stroke = "#7a6a52" if item.tone == "axis" else "#444444"
            if item.kind == "line":
                (ax, ay), (bx, by) = item.points
                draw.line((ax * scale, (height_mm - ay) * scale, bx * scale, (height_mm - by) * scale),
                          fill=stroke, width=max(1, round(.18 * scale)))
                continue
            if item.kind == "circle":
                (cx, cy) = item.points[0]
                radius = item.height_mm * scale
                draw.ellipse(
                    (cx * scale - radius, (height_mm - cy) * scale - radius,
                     cx * scale + radius, (height_mm - cy) * scale + radius),
                    outline=stroke, width=max(1, round(.25 * scale)))
                continue
            tx, ty = item.points[0]
            if item.height_mm not in fonts:
                fonts[item.height_mm] = ImageFont.truetype(str(self.font_path), round(item.height_mm * PX_PER_MM_300))
            item_font = fonts[item.height_mm]
            text = item.text or ""
            colour = "#a43c32" if item.tone == "condition" else "#7a6a52" if item.tone == "axis" else "#111111"
            box = draw.textbbox((0, 0), text, font=item_font)
            left = tx * scale - ((box[2] - box[0]) / 2 if item.align == "middle" else 0)
            draw.text((left, (height_mm - ty) * scale - (box[3] - box[1]) - 1.5 * scale), text, fill=colour, font=item_font)
        title_x = width_mm - 226
        title_top = height_mm - 35
        draw.rectangle((title_x * scale, title_top * scale, (width_mm - 5) * scale, (height_mm - 5) * scale), outline="#111111", width=max(1, round(.35 * scale)))
        draw.text(((title_x + 3) * scale, (title_top + 3) * scale), self.ir["titleZh"], fill="#111111", font=title_font)
        draw.text(((title_x + 3) * scale, (title_top + 11) * scale), sheet["displayLabelZh"], fill="#111111", font=title_font)
        draw.text(((title_x + 3) * scale, (title_top + 21) * scale), f"{sheet['drawingNumber']}　代理成果·未签发　{self.ir['revisionLabel']}　日期：未签发", fill="#111111", font=small_font)
        image.save(output_path, dpi=(300, 300), optimize=True)

    def write(self, output_dir: Path) -> dict[str, Any]:
        output_dir.mkdir(parents=True, exist_ok=True)
        assets: list[dict[str, Any]] = []
        for sheet in self.ir["sheets"]:
            svg_path = output_dir / f"{sheet['drawingNumber']}.svg"
            png_path = output_dir / f"{sheet['drawingNumber']}.png"
            self._svg(sheet, svg_path)
            self._png(sheet, png_path)
            for kind, path, mime in (("svg", svg_path, "image/svg+xml"), ("preview", png_path, "image/png")):
                assets.append({"kind": kind, "fileName": path.name, "mimeType": mime, "sha256": _hash(path), "byteLength": path.stat().st_size, "sheetId": sheet["id"]})
        pdf_path = output_dir / "drawings.pdf"
        self._pdf(pdf_path)
        assets.append({"kind": "pdf", "fileName": pdf_path.name, "mimeType": "application/pdf", "sha256": _hash(pdf_path), "byteLength": pdf_path.stat().st_size})
        return {"assets": assets}
