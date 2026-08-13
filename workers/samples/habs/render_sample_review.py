from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _preview(source: Path, max_size: tuple[int, int]) -> Image.Image:
    with Image.open(source) as image:
        image.draft("RGB", max_size)
        rendered = image.convert("RGB")
        rendered.thumbnail(max_size, Image.Resampling.LANCZOS)
        return rendered.copy()


def _contact(items: list[tuple[str, Image.Image]], target: Path, columns: int, cell: tuple[int, int]) -> None:
    rows = (len(items) + columns - 1) // columns
    page = Image.new("RGB", (columns * cell[0], rows * cell[1]), "white")
    draw = ImageDraw.Draw(page)
    font = ImageFont.load_default()
    for index, (label, image) in enumerate(items):
        x = (index % columns) * cell[0]
        y = (index // columns) * cell[1]
        thumb = image.copy()
        thumb.thumbnail((cell[0] - 24, cell[1] - 46), Image.Resampling.LANCZOS)
        page.paste(thumb, (x + (cell[0] - thumb.width) // 2, y + 28 + (cell[1] - 46 - thumb.height) // 2))
        draw.text((x + 12, y + 8), label, fill="black", font=font)
    target.parent.mkdir(parents=True, exist_ok=True)
    page.save(target, "PNG", optimize=True, dpi=(150, 150))


def render(manifest_path: Path, raw_root: Path, output_root: Path) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    drawings: list[tuple[str, Image.Image]] = []
    photos: list[tuple[str, Image.Image]] = []
    previews: list[dict[str, object]] = []
    for asset in manifest["assets"]:
        if asset["category"] not in {"measuredDrawing", "photo"}:
            continue
        source = raw_root / asset["relativePath"]
        max_size = (2600, 2000) if asset["category"] == "measuredDrawing" else (1800, 1400)
        rendered = _preview(source, max_size)
        item = (asset["assetId"], rendered)
        (drawings if asset["category"] == "measuredDrawing" else photos).append(item)
        previews.append({"assetId": asset["assetId"], "widthPx": rendered.width, "heightPx": rendered.height})
    _contact(drawings, output_root / "badin-roque-drawings-contact.png", 2, (1300, 950))
    _contact(photos, output_root / "badin-roque-photos-contact.png", 3, (800, 650))
    record = {"schemaVersion": "1.0", "sourceManifestSha256": manifest["manifestSha256"], "previews": previews}
    (output_root / "badin-roque-preview-record.json").write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--raw-root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    args = parser.parse_args()
    result = render(args.manifest, args.raw_root, args.output_root)
    print(json.dumps({"previewCount": len(result["previews"])}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
