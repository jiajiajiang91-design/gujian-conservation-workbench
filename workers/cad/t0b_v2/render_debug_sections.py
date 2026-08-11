from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


VIEW_IDS = ("floorPlan", "transverseSection", "longitudinalSection")
CANVAS = (2400, 1600)
MARGIN = 120


def _load(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _transform(clip: list[float]):
    left, bottom, right, top = clip
    width, height = CANVAS
    scale = min((width - 2 * MARGIN) / (right - left), (height - 2 * MARGIN) / (top - bottom))
    offset_x = (width - (right - left) * scale) / 2
    offset_y = (height - (top - bottom) * scale) / 2

    def transform(point: list[float]) -> tuple[float, float]:
        return offset_x + (point[0] - left) * scale, height - offset_y - (point[1] - bottom) * scale

    return transform


def render_sections(sections_dir: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default()
    for view_id in VIEW_IDS:
        view = _load(sections_dir / f"{view_id}.view-geometry.json.gz")
        image = Image.new("RGB", CANVAS, "#fbfbfa")
        draw = ImageDraw.Draw(image)
        transform = _transform(view["viewFrame"]["clipRectMm"])
        for line in view["projectionLines"]:
            draw.line([transform(point) for point in line["pointsMm"]], fill="#7f8790", width=1)
        for line in view["cutLines"]:
            draw.line([transform(point) for point in line["pointsMm"]], fill="#8c2f24", width=3, joint="curve")
        draw.rectangle((18, 18, CANVAS[0] - 18, CANVAS[1] - 18), outline="#c4c7ca", width=2)
        draw.text((36, 32), f"{view_id} | true cut + exact hidden-line removal | debug only", fill="#25282b", font=font)
        draw.text(
            (36, CANVAS[1] - 54),
            f"geometry {view['geometryRevisionId'][:8]} | contract {view['viewContractRevisionId'][:8]} | not drawing output",
            fill="#555b61",
            font=font,
        )
        image.save(output_dir / f"t0b-v2-{view_id}-debug.png", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render non-qualifying debug previews from section ViewGeometry.")
    parser.add_argument("--sections-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    render_sections(args.sections_dir, args.output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
