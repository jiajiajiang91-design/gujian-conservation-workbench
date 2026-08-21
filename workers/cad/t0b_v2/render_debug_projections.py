from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageDraw


VIEW_IDS = ("roofPlan", "southElevation", "axonometric")


def _load(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _transform(clip: list[float], width: int, height: int, margin: int = 80):
    minimum_x, minimum_y, maximum_x, maximum_y = map(float, clip)
    scale = min((width - margin * 2) / (maximum_x - minimum_x), (height - margin * 2) / (maximum_y - minimum_y))
    offset_x = (width - (maximum_x - minimum_x) * scale) / 2
    offset_y = (height - (maximum_y - minimum_y) * scale) / 2

    def point(value: list[float]) -> tuple[int, int]:
        return (
            round(offset_x + (float(value[0]) - minimum_x) * scale),
            round(height - offset_y - (float(value[1]) - minimum_y) * scale),
        )

    return point


def render(view: dict, output_path: Path, debug: bool) -> None:
    width, height = 2400, 1800
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    transform = _transform(view["viewFrame"]["clipRectMm"], width, height)
    clean_styles = {
        "silhouette": ((10, 10, 10), 4),
        "componentBoundary": ((45, 45, 45), 2),
        "feature": ((105, 105, 105), 1),
    }
    debug_styles = {
        "silhouette": ((5, 5, 5), 4),
        "componentBoundary": ((0, 95, 190), 2),
        "feature": ((205, 55, 40), 1),
    }
    styles = debug_styles if debug else clean_styles
    for line_class in ("feature", "componentBoundary", "silhouette"):
        color, line_width = styles[line_class]
        for line in view["projectionLines"]:
            if line["lineClass"] != line_class:
                continue
            points = [transform(point) for point in line["pointsMm"]]
            draw.line(points, fill=color, width=line_width)
    label = f"{view['viewId']} | {view['status']} | {'debug line classes' if debug else 'clean visible lines'}"
    draw.text((36, 30), label, fill=(25, 25, 25))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, dpi=(300, 300))


def main() -> int:
    parser = argparse.ArgumentParser(description="Render clean and line-class debug previews for projection ViewGeometry.")
    parser.add_argument("--projections-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    previews: list[dict] = []
    for view_id in VIEW_IDS:
        source_path = args.projections_dir / f"{view_id}.view-geometry.json.gz"
        view = _load(source_path)
        for mode, debug in (("clean", False), ("classes", True)):
            filename = f"t0b-v2-{view_id}-{mode}.png"
            output_path = args.output_dir / filename
            render(view, output_path, debug=debug)
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
                }
            )
    record = {
        "schemaVersion": "t0b-v2-projection-preview-1",
        "status": "review-evidence-only",
        "qualification": "not-drawing-output",
        "previews": previews,
    }
    (args.output_dir / "projection-preview-record.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
