from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from workers.samples.habs.verify_loc_habs import validate_metadata, verify


ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "验证材料" / "10_T9a_HABS样本验证"
RAW = ROOT / "apps" / "server" / ".data" / "acceptance" / "milestone-two" / "samples" / "habs-la0415" / "raw"


def _load(name: str) -> dict:
    return json.loads((EVIDENCE / name).read_text(encoding="utf-8"))


class LocHabsSampleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = _load("badin-roque-asset-manifest.json")
        self.record = _load("badin-roque-record-review.json")
        self.sheets = _load("badin-roque-sheet-review.json")
        self.candidates = _load("badin-roque-dimension-candidates.json")

    def test_full_sample_verifies(self) -> None:
        result = verify(EVIDENCE / "badin-roque-asset-manifest.json", RAW, EVIDENCE / "badin-roque-record-review.json", EVIDENCE / "badin-roque-sheet-review.json", EVIDENCE / "badin-roque-dimension-candidates.json")
        self.assertEqual(result["failedCount"], 0)

    def test_external_source_is_rejected(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["assets"][0]["sourceUrl"] = "https://example.com/forged.tif"
        self.assertTrue(any(not item["passed"] and item["checkId"] == "official-hosts" for item in validate_metadata(manifest, self.record, self.sheets, self.candidates)))

    def test_missing_measured_drawing_is_rejected(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["assets"] = [item for item in manifest["assets"] if item["assetId"] != "sheet-10"]
        manifest["assetCount"] = len(manifest["assets"])
        self.assertTrue(any(not item["passed"] and item["checkId"] == "asset-counts" for item in validate_metadata(manifest, self.record, self.sheets, self.candidates)))

    def test_unreviewed_candidate_cannot_be_labeled_human(self) -> None:
        candidates = copy.deepcopy(self.candidates)
        candidates["facts"][0]["producerRef"]["producerType"] = "human"
        self.assertTrue(any(not item["passed"] and item["checkId"] == "dimension-candidates" for item in validate_metadata(self.manifest, self.record, self.sheets, candidates)))


if __name__ == "__main__":
    unittest.main()
