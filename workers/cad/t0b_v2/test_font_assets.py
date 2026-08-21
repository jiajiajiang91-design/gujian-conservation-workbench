from __future__ import annotations

import gzip
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest

from fontTools.ttLib import TTFont

from workers.cad.t0b_v2.font_assets import (
    CORPUS_FILE,
    LICENSE_FILE,
    MANIFEST_FILE,
    METADATA_FILE,
    OUTPUT_FILE,
    SOURCE_COMMIT,
    SOURCE_FILE,
    build_font_asset_manifest,
    validate_font_asset_manifest,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ASSET_DIR = HERE / "assets" / "fonts" / "noto-sans-sc"
IR_PATH = next(ROOT.rglob("drawing-package.ir.json.gz"))


class T0BV2FontAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = validate_font_asset_manifest(ASSET_DIR)
        with gzip.open(IR_PATH, "rt", encoding="utf-8") as stream:
            cls.ir = json.load(stream)

    def test_source_commit_hash_license_axes_and_embedding_permission_are_frozen(self) -> None:
        source = self.manifest["source"]
        self.assertEqual(source["commit"], SOURCE_COMMIT)
        self.assertEqual(source["retrievedAt"], "2026-08-11T15:26:49Z")
        self.assertEqual(source["sourceFontSha256"], "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da")
        self.assertEqual(source["axes"], [{"tag": "wght", "min": 100.0, "default": 100.0, "max": 900.0}])
        self.assertEqual(source["fsType"], 0)
        self.assertEqual(source["fontUrl"], f"https://raw.githubusercontent.com/google/fonts/{SOURCE_COMMIT}/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf")
        self.assertEqual(self.manifest["licenseSpdx"], "OFL-1.1")
        self.assertEqual(self.manifest["licenseReservedFontNames"], ["Source"])
        self.assertTrue(self.manifest["redistributionAllowed"])
        self.assertTrue(self.manifest["pdfEmbeddingAllowed"])

    def test_weight_400_instance_is_static_renamed_and_not_reserved(self) -> None:
        font = TTFont(ASSET_DIR / OUTPUT_FILE, recalcTimestamp=False)
        self.assertNotIn("fvar", font)
        self.assertEqual(font["OS/2"].usWeightClass, 400)
        self.assertEqual(font["OS/2"].fsType, 0)
        self.assertEqual(self.manifest["instance"]["axisLocation"], {"wght": 400})
        self.assertEqual(self.manifest["family"], "Gujian Sans SC")
        self.assertEqual(self.manifest["postScriptName"], "GujianSansSC-Regular")
        self.assertEqual(self.manifest["derivedFrom"], {"family": "Noto Sans SC", "upstreamOriginal": False, "modification": "deterministic-static-instance-and-family-rename"})
        self.assertNotIn("Source", self.manifest["family"])
        self.assertEqual(self.manifest["namingCompliance"]["reservedNamesUsedByDerivedFamily"], [])

    def test_frozen_corpus_covers_all_rendered_ir_and_title_block_text(self) -> None:
        corpus = (ASSET_DIR / CORPUS_FILE).read_text(encoding="utf-8")
        visible_strings = [
            "T0-B 古建局部专业样板",
            "综合图",
            "构造详图",
            "见图",
            "mm",
            "generated-not-qualified",
            "团队演示/非正式签发",
            "项目名称图名图号比例单位状态版本日期使用责任边界",
        ]
        for annotation in self.ir["annotations"]:
            payload = annotation["semanticPayload"]
            for key in ("text", "label", "targetViewId"):
                value = payload.get(key)
                if isinstance(value, str):
                    visible_strings.append(value)
            visible_strings.extend(value for value in payload.get("labels", []) if isinstance(value, str))
        required = {character for value in visible_strings for character in value if not character.isspace()}
        frozen = {character for character in corpus if not character.isspace()}
        self.assertEqual(required - frozen, set())
        cmap = TTFont(ASSET_DIR / OUTPUT_FILE, recalcTimestamp=False).getBestCmap()
        self.assertEqual({ord(character) for character in required if ord(character) not in cmap}, set())
        self.assertEqual(self.manifest["glyphCoverage"]["missingCodepoints"], [])

    def test_manifest_and_instance_are_reproducible_in_an_empty_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in (SOURCE_FILE, LICENSE_FILE, METADATA_FILE, CORPUS_FILE):
                (target / name).write_bytes((ASSET_DIR / name).read_bytes())
            rebuilt = build_font_asset_manifest(target)
            self.assertEqual((target / OUTPUT_FILE).read_bytes(), (ASSET_DIR / OUTPUT_FILE).read_bytes())
            self.assertEqual((target / MANIFEST_FILE).read_bytes(), (ASSET_DIR / MANIFEST_FILE).read_bytes())
            self.assertEqual(rebuilt["sha256"], sha256((ASSET_DIR / OUTPUT_FILE).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
