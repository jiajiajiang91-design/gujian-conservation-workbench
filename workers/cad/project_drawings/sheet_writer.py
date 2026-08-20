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


def _view_transform(view: dict[str, Any], requirement: dict[str, Any]) -> Callable[[list[float]], tuple[float, float]]:
    bounds = view["boundsMm"]
    rect = requirement["viewportRectMm"]
    scale = float(requirement["scaleDenominator"])
    model_center = ((bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2)
    paper_center = (rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
    model_width = (bounds[1][0] - bounds[0][0]) / scale
    model_height = (bounds[1][1] - bounds[0][1]) / scale
    if model_width > rect[2] - 8 or model_height > rect[3] - 12:
        raise ValueError(f"view {view['viewKey']} does not fit its frozen viewport at 1:{int(scale)}")
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
# 纸面，再按制图惯例加纸面偏移。尺寸线在图形下方 8 mm，图名再下 7 mm；
# 两者与图签横向重叠时抬到图签之上，否则会压在图签文字上。
DIMENSION_OFFSET_PAPER_MM = 8.0
TITLE_OFFSET_PAPER_MM = 15.0
DIMENSION_TICK_PAPER_MM = 2.0


class PaperPrimitive(NamedTuple):
    kind: str                                  # line 或 text
    points: tuple[tuple[float, float], ...]    # 纸面毫米，y 自页底向上
    text: str | None
    height_mm: float
    align: str                                 # start 或 middle
    tone: str                                  # ink、dim 或 condition


def _annotation_rows(view: dict[str, Any], requirement: dict[str, Any], page_width: float) -> tuple[float, float, float, float]:
    bounds = view["boundsMm"]
    rect = requirement["viewportRectMm"]
    scale = float(requirement["scaleDenominator"])
    drawn_height = (bounds[1][1] - bounds[0][1]) / scale
    drawn_bottom = rect[1] + rect[3] / 2 - drawn_height / 2
    transform = _view_transform(view, requirement)
    x1 = transform([bounds[0][0], bounds[0][1]])[0]
    x2 = transform([bounds[1][0], bounds[0][1]])[0]

    title_left, _title_bottom, title_right, title_top = _title_block_rect(page_width)
    floor = title_top + TITLE_BLOCK_CLEARANCE_MM
    label_x = min(x1, rect[0])

    def overlaps(left: float, right: float) -> bool:
        return right > title_left and left < title_right

    label_y = drawn_bottom - TITLE_OFFSET_PAPER_MM
    if overlaps(label_x, label_x + 60.0) and label_y < floor:
        label_y = floor
    dimension_y = max(drawn_bottom - DIMENSION_OFFSET_PAPER_MM, label_y + 7.0)
    if overlaps(x1, x2) and dimension_y < floor:
        dimension_y = floor
    if dimension_y >= drawn_bottom:
        raise ValueError(f"view {view['viewKey']} leaves no room for its dimension row above the title block")
    return x1, x2, dimension_y, label_y


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
            '.cut{stroke:#111;stroke-width:.5}.outline{stroke:#111;stroke-width:.35}.projection{stroke:#4b514d;stroke-width:.18}.hatch{fill:url(#hatch);stroke:none}.frame{fill:none;stroke:#111;stroke-width:.35}.condition{fill:none;stroke:#a43c32;stroke-width:.3}.text{font-family:"Gujian Sans SC";fill:#111}',
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
                parts.append(f'<line class="projection" x1="{ax:.4f}" y1="{height-ay:.4f}" x2="{bx:.4f}" y2="{height-by:.4f}"/>')
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
                if item.kind == "line":
                    (ax, ay), (bx, by) = item.points
                    pdf.setLineWidth(0.18 * MM_TO_POINT)
                    pdf.setStrokeColorRGB(0.05, 0.05, 0.05)
                    pdf.line(ax * MM_TO_POINT, ay * MM_TO_POINT, bx * MM_TO_POINT, by * MM_TO_POINT)
                    continue
                tx, ty = item.points[0]
                pdf.setFillColorRGB(*((0.64, 0.16, 0.12) if item.tone == "condition" else (0.05, 0.05, 0.05)))
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
            if item.kind == "line":
                (ax, ay), (bx, by) = item.points
                draw.line((ax * scale, (height_mm - ay) * scale, bx * scale, (height_mm - by) * scale),
                          fill="#444444", width=max(1, round(.18 * scale)))
                continue
            tx, ty = item.points[0]
            if item.height_mm not in fonts:
                fonts[item.height_mm] = ImageFont.truetype(str(self.font_path), round(item.height_mm * PX_PER_MM_300))
            item_font = fonts[item.height_mm]
            text = item.text or ""
            colour = "#a43c32" if item.tone == "condition" else "#111111"
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
