from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


VIEW_IDS = ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail")
MODES = ("clean", "lineClass", "material-source")
CANVAS = (2400, 1800)
MARGIN_X = 150
MARGIN_TOP = 145
MARGIN_BOTTOM = 135
MATERIAL_COLORS = {
    "timber-demo": (166, 105, 64),
    "stone-demo": (111, 128, 143),
    "earth-demo": (174, 134, 88),
    "ceramic-demo": (78, 120, 127),
}


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _transform(clip: list[float]):
    left, bottom, right, top = map(float, clip)
    width, height = CANVAS
    available_width = width - MARGIN_X * 2
    available_height = height - MARGIN_TOP - MARGIN_BOTTOM
    scale = min(available_width / (right - left), available_height / (top - bottom))
    offset_x = (width - (right - left) * scale) / 2
    offset_y = MARGIN_TOP + (available_height - (top - bottom) * scale) / 2

    def point(value: list[float]) -> tuple[int, int]:
        return (
            round(offset_x + (float(value[0]) - left) * scale),
            round(height - offset_y - (float(value[1]) - bottom) * scale),
        )

    return point


def _source_color(material_code: str, entity_id: str) -> tuple[int, int, int]:
    base = MATERIAL_COLORS.get(material_code, (95, 95, 95))
    variation = (int(sha256(entity_id.encode("utf-8")).hexdigest()[:2], 16) - 128) / 128
    factor = 1.0 + variation * 0.18
    return tuple(max(35, min(220, round(channel * factor))) for channel in base)


def _draw_material_regions(draw: ImageDraw.ImageDraw, view: dict, transform, mode: str) -> None:
    if mode == "lineClass":
        return
    for region in view.get("materialRegions", []):
        base = MATERIAL_COLORS.get(region["materialCode"], (180, 180, 180))
        fill = tuple(round(channel * 0.30 + 255 * 0.70) for channel in base)
        if mode == "clean":
            fill = tuple(round(channel * 0.18 + 255 * 0.82) for channel in base)
        draw.polygon([transform(point) for point in region["outerMm"]], fill=fill)
        for hole in region["holesMm"]:
            draw.polygon([transform(point) for point in hole], fill=(252, 252, 250))


def _draw_lines(draw: ImageDraw.ImageDraw, view: dict, transform, metadata: dict[str, dict], mode: str) -> None:
    all_lines = [*view.get("projectionLines", []), *view.get("cutLines", [])]
    if mode == "clean":
        styles = {
            "feature": ((110, 110, 110), 1),
            "componentBoundary": ((48, 48, 48), 2),
            "silhouette": ((10, 10, 10), 4),
            "cut": ((8, 8, 8), 4),
        }
        for line_class in ("feature", "componentBoundary", "silhouette", "cut"):
            color, width = styles[line_class]
            for line in all_lines:
                if line["lineClass"] == line_class:
                    draw.line([transform(point) for point in line["pointsMm"]], fill=color, width=width)
        return
    if mode == "lineClass":
        styles = {
            "feature": ((211, 76, 48), 2),
            "componentBoundary": ((33, 112, 181), 3),
            "silhouette": ((20, 20, 20), 5),
            "cut": ((150, 36, 44), 5),
        }
        for line_class in ("feature", "componentBoundary", "silhouette", "cut"):
            color, width = styles[line_class]
            for line in all_lines:
                if line["lineClass"] == line_class:
                    draw.line([transform(point) for point in line["pointsMm"]], fill=color, width=width)
        for line in view.get("cropLimitLines", []):
            draw.line([transform(point) for point in line["pointsMm"]], fill=(139, 63, 152), width=4)
        return
    for line in all_lines:
        entity = metadata[line["sourceEntityId"]]
        color = _source_color(entity["materialCode"], line["sourceEntityId"])
        width = 4 if line["lineClass"] in {"cut", "silhouette"} else 2
        draw.line([transform(point) for point in line["pointsMm"]], fill=color, width=width)
    for line in view.get("cropLimitLines", []):
        draw.line([transform(point) for point in line["pointsMm"]], fill=(139, 63, 152), width=3)


def _legend(draw: ImageDraw.ImageDraw, view: dict, metadata: dict[str, dict], mode: str, font) -> None:
    x = 1540
    y = 45
    if mode == "lineClass":
        items = (
            ("cut", (150, 36, 44)),
            ("silhouette", (20, 20, 20)),
            ("componentBoundary", (33, 112, 181)),
            ("feature", (211, 76, 48)),
            ("cropLimit / non-structural", (139, 63, 152)),
        )
    elif mode == "material-source":
        source_ids = {
            line["sourceEntityId"]
            for line in [*view.get("cutLines", []), *view.get("projectionLines", [])]
        }
        material_codes = sorted({metadata[entity_id]["materialCode"] for entity_id in source_ids})
        items = tuple((code, MATERIAL_COLORS.get(code, (95, 95, 95))) for code in material_codes)
    else:
        items = (("structural visible/cut line", (20, 20, 20)), ("material section region", (184, 184, 184)))
    for label, color in items:
        draw.line((x, y + 7, x + 38, y + 7), fill=color, width=6)
        draw.text((x + 50, y), label, fill=(42, 45, 48), font=font)
        y += 28


def render(view: dict, output_path: Path, metadata: dict[str, dict], mode: str) -> None:
    image = Image.new("RGB", CANVAS, (252, 252, 250))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    transform = _transform(view["viewFrame"]["clipRectMm"])
    _draw_material_regions(draw, view, transform, mode)
    _draw_lines(draw, view, transform, metadata, mode)
    draw.rectangle((18, 18, CANVAS[0] - 18, CANVAS[1] - 18), outline=(193, 197, 199), width=2)
    draw.text(
        (42, 38),
        f"{view['viewId']} | {mode} | independent review evidence only",
        fill=(28, 31, 34),
        font=font,
    )
    source_count = len(
        {
            line["sourceEntityId"]
            for line in [*view.get("cutLines", []), *view.get("projectionLines", [])]
        }
    )
    draw.text(
        (42, CANVAS[1] - 62),
        f"geometry {view['geometryRevisionId'][:8]} | contract {view['viewContractRevisionId'][:8]} | "
        f"{source_count} source entities | generated-not-qualified | not drawing output | L1=false",
        fill=(76, 80, 84),
        font=font,
    )
    _legend(draw, view, metadata, mode, font)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, dpi=(300, 300), optimize=True)


def render_details(details_dir: Path, manifest_path: Path, output_dir: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    metadata = {entity["entityId"]: entity for entity in manifest["entities"]}
    previews = []
    for view_id in VIEW_IDS:
        source_path = details_dir / f"{view_id}.view-geometry.json.gz"
        view = _load(source_path)
        for mode in MODES:
            filename = f"t0b-v2-{view_id}-{mode}.png"
            output_path = output_dir / filename
            render(view, output_path, metadata, mode)
            with Image.open(output_path) as image:
                dimensions = list(image.size)
                dpi = [round(float(value)) for value in image.info.get("dpi", (0, 0))]
            previews.append(
                {
                    "viewId": view_id,
                    "mode": mode,
                    "path": filename,
                    "sha256": _file_hash(output_path),
                    "dimensionsPx": dimensions,
                    "dpi": dpi,
                    "source": {
                        "path": source_path.name,
                        "sha256": _file_hash(source_path),
                        "viewGeometrySha256": view["viewGeometrySha256"],
                    },
                    "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
                }
            )
    record = {
        "schemaVersion": "t0b-v2-detail-preview-1",
        "status": "review-evidence-only",
        "qualification": "not-drawing-output",
        "L1": False,
        "renderer": {"source": Path(__file__).name, "sha256": _file_hash(Path(__file__).resolve())},
        "reviewStatus": "pending-independent-visual-review",
        "previews": previews,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    record_path = output_dir / "detail-preview-record.json"
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="Render non-qualifying detail review previews in clean, line-class and material-source modes.")
    parser.add_argument("--details-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    record = render_details(args.details_dir, args.manifest, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
