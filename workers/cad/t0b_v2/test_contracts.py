from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIXTURE = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v2-resolved-local-assembly.json"
sys.path.insert(0, str(HERE))

from contracts import ContractError, load_fixture, validate_fixture


class T0BV2ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = load_fixture(FIXTURE)

    def test_frozen_fixture_is_complete(self) -> None:
        self.assertEqual(self.fixture["scope"], "resolved-local-assembly")
        self.assertEqual(self.fixture["acceptance"]["structuralSourceEntityCoverage"], 1.0)
        self.assertEqual(len(self.fixture["views"]), 10)
        self.assertEqual({item["drawingNumber"] for item in self.fixture["drawingSheets"]}, {"T0B-01", "T0B-02"})

    def test_placeholder_cannot_satisfy_required_component(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["componentTemplates"]["bracketArm"]["geometryStatus"] = "placeholder"
        with self.assertRaisesRegex(ContractError, "bracketArm must be resolved"):
            validate_fixture(invalid)

    def test_independent_2d_geometry_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "transverseSection")
        view["derivation"] = "independentDrawing"
        with self.assertRaisesRegex(ContractError, "unsupported derivation"):
            validate_fixture(invalid)

    def test_roof_must_have_support_path_to_foundation(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["connections"] = [
            item for item in invalid["connections"]
            if item["fromType"] != "roofBoard"
        ]
        with self.assertRaisesRegex(ContractError, "must have a support path"):
            validate_fixture(invalid)

    def test_object_and_file_counts_cannot_be_quality_gates(self) -> None:
        self.assertEqual(
            set(self.fixture["acceptance"]["forbiddenPassMetrics"]),
            {"objectCount", "primitiveCount", "fileSize"},
        )

    def test_visible_line_policy_rejects_triangle_mesh_edges(self) -> None:
        policy = self.fixture["drawingRequirements"]["projectionPolicy"]
        self.assertTrue(policy["hiddenLineRemoval"])
        self.assertEqual(policy["triangleInteriorEdges"], "forbidden")

    def test_external_source_scheme_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["sourceRefs"] = ["file:external-reference"]
        with self.assertRaisesRegex(ContractError, "demo scheme"):
            validate_fixture(invalid)

    def test_geometry_feature_gate_cannot_be_omitted(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["geometryValidation"]["requiredFeatureAssertions"].remove("oppositeTileCurvature")
        with self.assertRaisesRegex(ContractError, "feature assertions are incomplete"):
            validate_fixture(invalid)

    def test_frozen_revision_cannot_point_to_a_second_geometry_signature(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["knownAnswers"]["geometrySignature"] = "0" * 64
        with self.assertRaisesRegex(ContractError, "revision must be derived"):
            validate_fixture(invalid)

    def test_roof_requires_a_non_zero_ridge_break_and_declared_tile_lap(self) -> None:
        self.assertEqual(self.fixture["assembly"]["roofCurve"]["family"], "pairedCubicC0")
        self.assertGreater(self.fixture["assembly"]["roofCurve"]["ridgeSlopeJump"], 0)
        self.assertEqual(
            self.fixture["componentTemplates"]["panTile"]["parameters"]["lapTailDepth"],
            self.fixture["componentTemplates"]["panTile"]["parameters"]["thickness"],
        )


if __name__ == "__main__":
    unittest.main()
