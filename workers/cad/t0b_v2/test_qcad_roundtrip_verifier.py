from __future__ import annotations

import ast
from copy import deepcopy
from pathlib import Path
import unittest

from workers.cad.t0b_v2.verify_qcad_roundtrip import assess_contract


def passing_facts() -> dict:
    return {
        "header": {"roundtripVersion": "AC1032", "roundtripInsunits": 4},
        "trackedClosure": {
            "missingIds": 0,
            "newTrackedIds": 0,
            "typeMismatches": 0,
            "handleMismatches": 0,
            "xdataMismatches": 0,
            "sidecarAssociationMismatches": 0,
        },
        "structural": {"overTolerance": 0},
        "hatches": {"geometryMismatches": 0, "patternMismatches": 0},
        "dimensions": {"objects": 33, "styleChanges": 0, "geometryReferencesLost": 0, "sourceGeometryBlocksMissing": 0},
        "text": {"contentMismatches": 0},
        "layoutsAndViewports": {
            "sourceLayouts": ["Model", "T0B-01", "T0B-02"],
            "roundtripLayouts": ["Model", "T0B-01", "T0B-02"],
            "trackedUserViewports": 10,
            "geometryMismatches": 0,
            "flagChanges": 0,
            "sourceLocked": 10,
            "roundtripLocked": 10,
        },
    }


class QCADRoundtripThresholdTests(unittest.TestCase):
    def assert_rejected(self, facts: dict, finding_id: str) -> None:
        result = assess_contract(facts)
        self.assertFalse(result["passed"])
        self.assertIn(finding_id, {item["id"] for item in result["P0"]})

    def test_accepts_only_a_semantically_unchanged_roundtrip(self) -> None:
        result = assess_contract(passing_facts())
        self.assertTrue(result["passed"])
        self.assertEqual(result["P0"], [])

    def test_rejects_dimension_style_and_geometry_rebuild(self) -> None:
        facts = passing_facts()
        facts["dimensions"].update({"styleChanges": 33, "geometryReferencesLost": 33, "sourceGeometryBlocksMissing": 33})
        self.assert_rejected(facts, "P0-QCAD-DIMENSION-REBUILD")

    def test_rejects_viewport_lock_loss(self) -> None:
        facts = passing_facts()
        facts["layoutsAndViewports"].update({"flagChanges": 10, "roundtripLocked": 0})
        self.assert_rejected(facts, "P0-QCAD-VIEWPORT-LOCK-LOSS")

    def test_rejects_layout_or_viewport_geometry_change(self) -> None:
        facts = passing_facts()
        facts["layoutsAndViewports"]["roundtripLayouts"] = ["Model", "T0B-01"]
        self.assert_rejected(facts, "P0-QCAD-LAYOUT-VIEWPORT-GEOMETRY")

    def test_rejects_xdata_handle_or_sidecar_break(self) -> None:
        for key in ("missingIds", "typeMismatches", "handleMismatches", "xdataMismatches", "sidecarAssociationMismatches"):
            with self.subTest(key=key):
                facts = passing_facts()
                facts["trackedClosure"][key] = 1
                self.assert_rejected(facts, "P0-QCAD-PROVENANCE-CLOSURE")

    def test_rejects_structural_coordinate_change(self) -> None:
        facts = passing_facts()
        facts["structural"]["overTolerance"] = 1
        self.assert_rejected(facts, "P0-QCAD-STRUCTURAL-GEOMETRY")

    def test_rejects_hatch_geometry_or_pattern_change(self) -> None:
        for key in ("geometryMismatches", "patternMismatches"):
            with self.subTest(key=key):
                facts = passing_facts()
                facts["hatches"][key] = 1
                self.assert_rejected(facts, "P0-QCAD-HATCH-SEMANTICS")

    def test_rejects_text_or_unit_change(self) -> None:
        facts = passing_facts()
        facts["text"]["contentMismatches"] = 1
        self.assert_rejected(facts, "P0-QCAD-TEXT-CONTENT")
        facts = passing_facts()
        facts["header"]["roundtripInsunits"] = 0
        self.assert_rejected(facts, "P0-QCAD-HEADER-UNIT-LOSS")

    def test_verifier_has_no_generator_or_contract_import(self) -> None:
        path = Path(__file__).with_name("verify_qcad_roundtrip.py")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertFalse({"generate_dxf", "drawing_ir", "drawing_contract"} & imported)


if __name__ == "__main__":
    unittest.main()
