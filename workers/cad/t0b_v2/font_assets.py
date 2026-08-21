from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile

import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


SCHEMA_VERSION = "t0b-v2-font-asset-manifest-1"
SOURCE_COMMIT = "038b637da7b3fd956a4ed93ffc607c3d5e4ce172"
SOURCE_BASE_URL = f"https://raw.githubusercontent.com/google/fonts/{SOURCE_COMMIT}/ofl/notosanssc"
SOURCE_FILE = "NotoSansSC[wght].ttf"
SOURCE_URL_FILE = "NotoSansSC%5Bwght%5D.ttf"
SOURCE_SHA256 = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
LICENSE_FILE = "OFL.txt"
LICENSE_SHA256 = "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9"
METADATA_FILE = "METADATA.pb"
METADATA_SHA256 = "c6c4bdb785793b2de1da177caeeffcd0c90d7680bdab2de8f88ab45007bc59bc"
CORPUS_FILE = "font-corpus.txt"
OUTPUT_FILE = "GujianSansSC-Regular.ttf"
MANIFEST_FILE = "font-manifest.json"
OUTPUT_FAMILY = "Gujian Sans SC"
OUTPUT_FULL_NAME = "Gujian Sans SC Regular"
OUTPUT_POSTSCRIPT_NAME = "GujianSansSC-Regular"
OUTPUT_WEIGHT = 400.0
FIXED_FONT_TIMESTAMP = 0
RETRIEVED_AT = "2026-08-11T15:26:49Z"


class FontAssetError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise FontAssetError(message)


def _file_hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def _canonical_hash(value: object) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _name_values(font: TTFont, name_id: int) -> list[str]:
    values: list[str] = []
    for record in font["name"].names:
        if record.nameID != name_id:
            continue
        value = record.toUnicode()
        if value not in values:
            values.append(value)
    return values


def _set_name(font: TTFont, name_id: int, value: str) -> None:
    table = font["name"]
    table.removeNames(nameID=name_id)
    table.setName(value, name_id, 3, 1, 0x409)


def _font_metadata(font: TTFont) -> dict:
    return {
        "family": _name_values(font, 16) or _name_values(font, 1),
        "subfamily": _name_values(font, 17) or _name_values(font, 2),
        "fullName": _name_values(font, 4),
        "postScriptName": _name_values(font, 6),
        "fsType": int(font["OS/2"].fsType),
    }


def _source_axes(font: TTFont) -> list[dict]:
    _require("fvar" in font, "source font is not variable")
    return [
        {
            "tag": axis.axisTag,
            "min": float(axis.minValue),
            "default": float(axis.defaultValue),
            "max": float(axis.maxValue),
        }
        for axis in font["fvar"].axes
    ]


def _corpus_codepoints(path: Path) -> tuple[str, list[int]]:
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    codepoints = sorted({ord(character) for character in text if not character.isspace()})
    _require(codepoints, "font corpus is empty")
    return sha256(raw).hexdigest(), codepoints


def _build_static_instance(source_path: Path, output_path: Path) -> None:
    source = TTFont(source_path, recalcTimestamp=False, lazy=False)
    _require(_source_axes(source) == [{"tag": "wght", "min": 100.0, "default": 100.0, "max": 900.0}], "source variable axes differ")
    static = instantiateVariableFont(source, {"wght": OUTPUT_WEIGHT}, inplace=False, optimize=True)
    for name_id, value in {
        1: OUTPUT_FAMILY,
        2: "Regular",
        3: "1.000;GJ;GujianSansSC-Regular",
        4: OUTPUT_FULL_NAME,
        5: "Version 1.000; deterministic wght 400 instance",
        6: OUTPUT_POSTSCRIPT_NAME,
        16: OUTPUT_FAMILY,
        17: "Regular",
        25: "GujianSansSC",
    }.items():
        _set_name(static, name_id, value)
    static["OS/2"].usWeightClass = 400
    static["head"].created = FIXED_FONT_TIMESTAMP
    static["head"].modified = FIXED_FONT_TIMESTAMP
    static.recalcTimestamp = False
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=".font-instance-", suffix=".ttf", dir=output_path.parent, delete=False) as stream:
        temporary_path = Path(stream.name)
    try:
        static.save(temporary_path, reorderTables=True)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def build_font_asset_manifest(asset_dir: Path) -> dict:
    source_path = asset_dir / SOURCE_FILE
    license_path = asset_dir / LICENSE_FILE
    metadata_path = asset_dir / METADATA_FILE
    corpus_path = asset_dir / CORPUS_FILE
    output_path = asset_dir / OUTPUT_FILE
    for path in (source_path, license_path, metadata_path, corpus_path):
        _require(path.is_file(), f"required font asset is missing: {path.name}")
    _require(_file_hash(source_path) == SOURCE_SHA256, "source font hash differs")
    _require(_file_hash(license_path) == LICENSE_SHA256, "OFL hash differs")
    _require(_file_hash(metadata_path) == METADATA_SHA256, "Google Fonts metadata hash differs")
    license_text = license_path.read_text(encoding="utf-8")
    _require("SIL OPEN FONT LICENSE Version 1.1" in license_text, "OFL 1.1 text is missing")
    _require("Reserved Font Name 'Source'" in license_text, "reserved font name declaration is missing")

    source_font = TTFont(source_path, recalcTimestamp=False, lazy=False)
    source_axes = _source_axes(source_font)
    source_metadata = _font_metadata(source_font)
    _require(source_metadata["fsType"] == 0, "source font embedding permission differs")
    _build_static_instance(source_path, output_path)

    output_font = TTFont(output_path, recalcTimestamp=False, lazy=False)
    output_metadata = _font_metadata(output_font)
    _require("fvar" not in output_font, "static instance still contains fvar")
    _require(output_metadata == {
        "family": [OUTPUT_FAMILY],
        "subfamily": ["Regular"],
        "fullName": [OUTPUT_FULL_NAME],
        "postScriptName": [OUTPUT_POSTSCRIPT_NAME],
        "fsType": 0,
    }, "static instance metadata differs")
    _require("Source" not in OUTPUT_FAMILY and "Source" not in OUTPUT_POSTSCRIPT_NAME, "derived font uses the reserved font name")

    corpus_sha256, codepoints = _corpus_codepoints(corpus_path)
    cmap = output_font.getBestCmap()
    missing = [codepoint for codepoint in codepoints if codepoint not in cmap]
    _require(not missing, f"font corpus has missing glyphs: {missing}")
    script_path = Path(__file__).resolve()
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "fontId": "gujian-sans-sc-regular-400-v1",
        "family": OUTPUT_FAMILY,
        "fullName": OUTPUT_FULL_NAME,
        "postScriptName": OUTPUT_POSTSCRIPT_NAME,
        "fileName": OUTPUT_FILE,
        "sha256": _file_hash(output_path),
        "fsType": 0,
        "redistributionAllowed": True,
        "pdfEmbeddingAllowed": True,
        "licenseSpdx": "OFL-1.1",
        "licenseFile": LICENSE_FILE,
        "licenseFileSha256": LICENSE_SHA256,
        "licenseReservedFontNames": ["Source"],
        "namingCompliance": {
            "isModifiedVersion": True,
            "derivedFamilyRenamed": True,
            "derivedFamily": OUTPUT_FAMILY,
            "reservedNamesUsedByDerivedFamily": [],
            "attributionRetained": True,
        },
        "derivedFrom": {
            "family": "Noto Sans SC",
            "upstreamOriginal": False,
            "modification": "deterministic-static-instance-and-family-rename",
        },
        "source": {
            "repository": "google/fonts",
            "commit": SOURCE_COMMIT,
            "retrievedAt": RETRIEVED_AT,
            "fontUrl": f"{SOURCE_BASE_URL}/{SOURCE_URL_FILE}",
            "licenseUrl": f"{SOURCE_BASE_URL}/{LICENSE_FILE}",
            "metadataUrl": f"{SOURCE_BASE_URL}/{METADATA_FILE}",
            "sourceFontSha256": SOURCE_SHA256,
            "metadataSha256": METADATA_SHA256,
            "family": source_metadata["family"],
            "postScriptName": source_metadata["postScriptName"],
            "fullName": source_metadata["fullName"],
            "axes": source_axes,
            "fsType": source_metadata["fsType"],
        },
        "instance": {
            "axisLocation": {"wght": int(OUTPUT_WEIGHT)},
            "isStatic": True,
            "usWeightClass": int(output_font["OS/2"].usWeightClass),
        },
        "glyphCoverage": {
            "corpusFile": CORPUS_FILE,
            "corpusSha256": corpus_sha256,
            "requiredCodepointCount": len(codepoints),
            "coveredCodepointCount": len(codepoints),
            "missingCodepoints": [],
            "cmapCodepointCount": len(cmap),
        },
        "build": {
            "fontToolsVersion": fontTools.__version__,
            "scriptFile": script_path.name,
            "scriptSha256": _file_hash(script_path),
            "fixedFontTimestamp": FIXED_FONT_TIMESTAMP,
            "deterministic": True,
        },
    }
    payload["manifestPayloadSha256"] = _canonical_hash(payload)
    manifest_path = asset_dir / MANIFEST_FILE
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")
    return payload


def validate_font_asset_manifest(asset_dir: Path) -> dict:
    manifest_path = asset_dir / MANIFEST_FILE
    _require(manifest_path.is_file(), "font manifest is missing")
    expected_bytes = manifest_path.read_bytes()
    with tempfile.TemporaryDirectory() as directory:
        temporary_asset_dir = Path(directory)
        for name in (SOURCE_FILE, LICENSE_FILE, METADATA_FILE, CORPUS_FILE):
            (temporary_asset_dir / name).write_bytes((asset_dir / name).read_bytes())
        rebuilt = build_font_asset_manifest(temporary_asset_dir)
        _require((temporary_asset_dir / MANIFEST_FILE).read_bytes() == expected_bytes, "font manifest is not reproducible")
        _require((temporary_asset_dir / OUTPUT_FILE).read_bytes() == (asset_dir / OUTPUT_FILE).read_bytes(), "static font instance is not reproducible")
    manifest = json.loads(expected_bytes.decode("utf-8"))
    _require(manifest == rebuilt, "font manifest payload differs")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and validate the licensed deterministic wght=400 drawing font asset.")
    parser.add_argument("--asset-dir", type=Path, required=True)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    manifest = validate_font_asset_manifest(args.asset_dir) if args.validate_only else build_font_asset_manifest(args.asset_dir)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
