from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from PIL import Image
from pypdf import PdfReader


ALLOWED_HOSTS = {"www.loc.gov", "cdn.loc.gov", "tile.loc.gov"}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password:
        raise ValueError(f"unsupported source URL: {url}")


def _download(url: str, target: Path, expected_bytes: int | None) -> None:
    _validate_url(url)
    transport_url = url.replace(
        "https://cdn.loc.gov/master/",
        "https://tile.loc.gov/storage-services/master/",
        1,
    )
    if target.is_file() and (expected_bytes is None or target.stat().st_size == expected_bytes):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_suffix(target.suffix + ".part")
    staging.unlink(missing_ok=True)
    for attempt in range(5):
        request = urllib.request.Request(transport_url, headers={"User-Agent": "GujianWorkbenchResearch/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response, staging.open("wb") as output:
                shutil.copyfileobj(response, output)
            break
        except urllib.error.HTTPError as error:
            staging.unlink(missing_ok=True)
            if error.code != 429 or attempt == 4:
                raise
            retry_after = error.headers.get("Retry-After")
            time.sleep(max(5, min(int(retry_after) if retry_after and retry_after.isdigit() else 5 * (attempt + 1), 30)))
    else:
        raise RuntimeError(f"download retry exhausted: {url}")
    if expected_bytes is not None and staging.stat().st_size != expected_bytes:
        actual_bytes = staging.stat().st_size
        staging.unlink(missing_ok=True)
        raise ValueError(f"download size differs for {target.name}: expected {expected_bytes}, got {actual_bytes}")
    staging.replace(target)


def _inspect(path: Path, media_type: str) -> dict[str, Any]:
    if media_type == "image/tiff":
        with Image.open(path) as image:
            return {"format": image.format, "widthPx": image.width, "heightPx": image.height, "mode": image.mode}
    if media_type == "application/pdf":
        reader = PdfReader(path)
        return {"format": "PDF", "pageCount": len(reader.pages), "extractableTextLength": sum(len(page.extract_text() or "") for page in reader.pages)}
    if media_type == "application/json":
        value = json.loads(path.read_text(encoding="utf-8"))
        return {"format": "JSON", "topLevelKeys": sorted(value)}
    raise ValueError(f"unsupported media type: {media_type}")


def freeze(plan_path: Path, output_dir: Path, manifest_path: Path) -> dict[str, Any]:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    assets: list[dict[str, Any]] = []
    for item in plan["assets"]:
        relative = Path(item["relativePath"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"unsafe relative path: {relative}")
        target = output_dir / relative
        _download(item["url"], target, item.get("expectedBytes"))
        assets.append({
            "assetId": item["assetId"],
            "category": item["category"],
            "title": item["title"],
            "relativePath": relative.as_posix(),
            "sourceUrl": item["url"],
            "mediaType": item["mediaType"],
            "byteLength": target.stat().st_size,
            "sha256": _hash(target),
            "inspection": _inspect(target, item["mediaType"]),
        })
    manifest = {
        "schemaVersion": "1.0",
        "status": "frozen-licensed-proxy-sample",
        "sampleId": plan["sampleId"],
        "officialRecord": plan["officialRecord"],
        "callNumber": plan["callNumber"],
        "rightsAdvisory": plan["rightsAdvisory"],
        "retrievedAt": plan["retrievedAt"],
        "assetCount": len(assets),
        "assets": sorted(assets, key=lambda item: item["assetId"]),
        "qualification": "proxy-engineering-benchmark-only",
        "l1Eligible": False,
        "formalEligibility": False,
        "unknowns": plan["unknowns"],
    }
    manifest["manifestSha256"] = hashlib.sha256(_canonical(manifest)).hexdigest()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_bytes(_canonical(manifest) + b"\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze an official LOC HABS sample without changing its files.")
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    result = freeze(args.plan, args.output, args.manifest)
    print(json.dumps({"status": result["status"], "assetCount": result["assetCount"], "manifestSha256": result["manifestSha256"]}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
