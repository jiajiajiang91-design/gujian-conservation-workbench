from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


PAGE_MM = (841.0, 594.0)


def file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mm_crop(image: Image.Image, rect_mm: tuple[float, float, float, float]) -> Image.Image:
    x, y, width, height = rect_mm
    left = round(x / PAGE_MM[0] * image.width)
    top = round(y / PAGE_MM[1] * image.height)
    right = round((x + width) / PAGE_MM[0] * image.width)
    bottom = round((y + height) / PAGE_MM[1] * image.height)
    return image.crop((left, top, right, bottom))


def save_review(source: Path, target: Path, rect_mm: tuple[float, float, float, float] | None) -> dict:
    with Image.open(source) as image:
        review = image.copy() if rect_mm is None else mm_crop(image, rect_mm)
    if review.width > 2400:
        height = round(review.height * 2400 / review.width)
        review = review.resize((2400, height), Image.Resampling.LANCZOS)
    review.save(target, format="PNG", compress_level=9)
    return {
        "name": target.name,
        "source": source.name,
        "sourceSha256": file_hash(source),
        "cropSvgMm": list(rect_mm) if rect_mm is not None else [0, 0, 841, 594],
        "pixelSize": list(review.size),
        "sha256": file_hash(target),
    }


def main() -> int:
    root = Path(__file__).resolve().parents[3]
    artifact_dir = next(root.rglob("drawing-package-artifacts"))
    review_dir = artifact_dir / "independent-review"
    review_dir.mkdir(parents=True, exist_ok=True)
    requests = [
        ("T0B-01-300dpi.png", "T0B-01-review-full.png", None),
        ("T0B-01-300dpi.png", "T0B-01-floor-plan-indices.png", (10, 5, 235, 265)),
        ("T0B-01-300dpi.png", "T0B-01-transverse-annotations.png", (245, 275, 260, 265)),
        ("T0B-01-300dpi.png", "T0B-01-title-block.png", (600, 525, 238, 66)),
        ("T0B-02-300dpi.png", "T0B-02-review-full.png", None),
        ("T0B-02-300dpi.png", "T0B-02-longitudinal-annotations.png", (10, 295, 200, 240)),
        ("T0B-02-300dpi.png", "T0B-02-eave-bracket-details.png", (10, 5, 385, 230)),
        ("T0B-02-300dpi.png", "T0B-02-column-door-details.png", (205, 250, 630, 290)),
        ("T0B-02-300dpi.png", "T0B-02-title-block.png", (600, 525, 238, 66)),
    ]
    outputs = [save_review(artifact_dir / source, review_dir / target, rect) for source, target, rect in requests]
    record = {
        "schemaVersion": "t0b-v2-sheet-output-independent-review-1",
        "status": "visual-review-evidence-only",
        "sourceBoundary": "canonical-300dpi-png-only",
        "outputs": outputs,
    }
    record_path = review_dir / "sheet-output-review-record.json"
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"record": str(record_path), "outputs": len(outputs)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
