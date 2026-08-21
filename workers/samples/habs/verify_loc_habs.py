from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from PIL import Image
from pypdf import PdfReader


ALLOWED_HOSTS = {"www.loc.gov", "cdn.loc.gov", "tile.loc.gov"}
REQUIRED_COVERAGE = {
    "componentCloseups",
    "dimensionChains",
    "elevations",
    "floorPlan",
    "multiDirectionPhotos",
    "sections",
    "sitePlan",
    "structuralDetails",
}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_metadata(manifest: dict[str, Any], record: dict[str, Any], sheets: dict[str, Any], candidates: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def check(check_id: str, passed: bool, detail: str) -> None:
        checks.append({"checkId": check_id, "passed": bool(passed), "detail": detail})

    assets = manifest.get("assets", [])
    counts = {category: sum(item.get("category") == category for item in assets) for category in {"photo", "measuredDrawing", "surveyData"}}
    check("asset-counts", manifest.get("assetCount") == 21 and counts == {"photo": 9, "measuredDrawing": 10, "surveyData": 2}, str(counts))
    check("record-identity", record.get("officialRecord") == manifest.get("officialRecord") and record.get("callNumber") == "HABS LA-1294", "official record and survey number")
    check("record-medium", record.get("medium") == {"measuredDrawings": 10, "photoCaptionPages": 1, "photos": 9}, "official medium counts")
    rights = str(record.get("rightsAdvisory", ""))
    check("rights-advisory", "No known restrictions" in rights and rights == manifest.get("rightsAdvisory"), "rights copied without broadening")
    hosts = {urlparse(item.get("sourceUrl", "")).hostname for item in assets}
    check("official-hosts", hosts.issubset(ALLOWED_HOSTS) and None not in hosts, ",".join(sorted(str(host) for host in hosts)))
    asset_ids = {item.get("assetId") for item in assets}
    sheet_ids = {item.get("assetId") for item in sheets.get("sheets", [])}
    check("sheet-coverage", sheet_ids == {f"sheet-{index:02d}" for index in range(1, 11)} and sheet_ids.issubset(asset_ids), "ten reviewed measured drawing sheets")
    coverage = {key for key, value in sheets.get("minimumCoverage", {}).items() if value}
    check("minimum-coverage", coverage == REQUIRED_COVERAGE, ",".join(sorted(coverage)))
    photo_titles = " ".join(item.get("title", "").lower() for item in assets if item.get("category") == "photo")
    check("photo-directions-and-closeups", all(term in photo_titles for term in ("northeast", "southeast", "north elevation", "door detail", "bousillage detail")), "multi-direction and component-closeup titles")
    facts = candidates.get("facts", [])
    fact_refs = {ref for fact in facts for ref in fact.get("evidenceRefs", [])}
    normalized = all(fact.get("producerRef", {}).get("producerType") == "model" and fact.get("reviewStatus") == "unreviewed" and fact.get("normalized", {}).get("unit") == "mm" and isinstance(fact.get("normalized", {}).get("value"), (int, float)) for fact in facts)
    check("dimension-candidates", len(facts) >= 7 and normalized and fact_refs.issubset(sheet_ids), "model candidates remain unreviewed and cite measured drawings")
    unknowns = record.get("unknowns", [])
    check("unknown-field-notes", any(item.get("reasonCode") == "FIELD_NOTES_NOT_DIGITIZED" and item.get("blocksFormalEligibility") for item in unknowns), "field notes remain an explicit formal blocker")
    check("qualification-boundary", not manifest.get("l1Eligible") and not manifest.get("formalEligibility") and record.get("qualification") == "proxy-engineering-benchmark-only", "proxy-only and not formally eligible")
    return checks


def verify(manifest_path: Path, raw_root: Path, record_path: Path, sheets_path: Path, candidates_path: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    record = json.loads(record_path.read_text(encoding="utf-8"))
    sheets = json.loads(sheets_path.read_text(encoding="utf-8"))
    candidates = json.loads(candidates_path.read_text(encoding="utf-8"))
    checks = validate_metadata(manifest, record, sheets, candidates)

    for asset in manifest["assets"]:
        path = raw_root / asset["relativePath"]
        passed = path.is_file() and path.stat().st_size == asset["byteLength"] and _hash(path) == asset["sha256"]
        checks.append({"checkId": f'asset-hash:{asset["assetId"]}', "passed": passed, "detail": asset["relativePath"]})
        if passed and asset["mediaType"] == "image/tiff":
            with Image.open(path) as image:
                inspection = asset["inspection"]
                valid_image = image.format == "TIFF" and image.width == inspection["widthPx"] and image.height == inspection["heightPx"]
            checks.append({"checkId": f'image:{asset["assetId"]}', "passed": valid_image, "detail": f'{inspection["widthPx"]}x{inspection["heightPx"]}'})
        if passed and asset["mediaType"] == "application/pdf":
            actual_pages = len(PdfReader(path).pages)
            expected_pages = 1 if asset["assetId"] == "caption-page" else 2
            checks.append({"checkId": f'pdf:{asset["assetId"]}', "passed": actual_pages == expected_pages, "detail": f"{actual_pages} pages"})

    unsigned = dict(manifest)
    claimed_manifest_hash = unsigned.pop("manifestSha256", None)
    checks.append({"checkId": "manifest-hash", "passed": claimed_manifest_hash == hashlib.sha256(_canonical(unsigned)).hexdigest(), "detail": str(claimed_manifest_hash)})
    failed = [item for item in checks if not item["passed"]]
    return {
        "schemaVersion": "1.0",
        "status": "passed-licensed-proxy-benchmark" if not failed else "failed-sample-freeze",
        "decision": "accept-habs-proxy-benchmark-only" if not failed else "reject-habs-success-path",
        "sampleId": manifest.get("sampleId"),
        "checks": checks,
        "checkCount": len(checks),
        "failedCount": len(failed),
        "p0Count": len(failed),
        "l1Eligible": False,
        "formalEligibility": False,
        "qualification": "proxy-engineering-benchmark-only",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--raw-root", required=True, type=Path)
    parser.add_argument("--record", required=True, type=Path)
    parser.add_argument("--sheets", required=True, type=Path)
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.manifest, args.raw_root, args.record, args.sheets, args.candidates)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(_canonical(result) + b"\n")
    print(json.dumps({key: result[key] for key in ("status", "checkCount", "failedCount")}, sort_keys=True))
    return 0 if result["failedCount"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
