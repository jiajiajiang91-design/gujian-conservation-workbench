from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIXTURE = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v2-resolved-local-assembly.json"
sys.path.insert(0, str(HERE))

from contracts import ContractError, load_fixture, prepare_view_generation_input, validate_fixture


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

    def test_each_view_freezes_frame_depth_and_paper_transform(self) -> None:
        for view in self.fixture["views"]:
            self.assertEqual(len(view["viewFrame"]["modelToView"]), 4)
            self.assertEqual(len(view["viewFrame"]["clipRectMm"]), 4)
            self.assertEqual(len(view["viewFrame"]["clipDepthMm"]), 2)
            self.assertEqual(len(view["paperPlacement"]["viewToPaper"]), 3)
            self.assertEqual(view["hiddenLineMode"], "remove")
            self.assertIn("annotationSafeRectMm", view["paperPlacement"])

    def test_transverse_section_passes_through_a_complete_column_frame(self) -> None:
        view = next(item for item in self.fixture["views"] if item["id"] == "transverseSection")
        self.assertEqual(view["section"]["planeOrigin"], [-1750, 0, 0])
        self.assertEqual(view["section"]["anchorEntityId"], "094027ab-3397-5117-bad8-81c07d961879")
        oracle = self.fixture["knownAnswers"]["viewOracle"]["views"]["transverseSection"]
        self.assertEqual(oracle["cutOpenOrDangleCount"], 0)
        self.assertIn("foundation", oracle["cutClosedRegionsByType"])
        self.assertIn("column", oracle["cutClosedRegionsByType"])
        self.assertIn("purlin", oracle["cutClosedRegionsByType"])

    def test_details_bind_one_instance_and_reversible_crop(self) -> None:
        details = [item for item in self.fixture["views"] if item["id"].endswith("Detail")]
        self.assertEqual(len(details), 4)
        for view in details:
            self.assertEqual(view["detail"]["anchorEntityId"], self.fixture["knownAnswers"]["viewOracle"]["views"][view["id"]]["anchorEntityId"])
            self.assertEqual(len(view["detail"]["cropBoundsModelMm"]), 2)
            self.assertIn(view["detail"]["mode"], {"section-projection", "occlusion-projection"})

    def test_missing_view_oracle_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        del invalid["knownAnswers"]["viewOracle"]["views"]["roofPlan"]
        with self.assertRaisesRegex(ContractError, "oracle matrix is incomplete"):
            validate_fixture(invalid)

    def test_ambiguous_projection_direction_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "southElevation")
        view["directionSemantics"] = "unspecified"
        with self.assertRaisesRegex(ContractError, "direction semantics are ambiguous"):
            validate_fixture(invalid)

    def test_non_unit_section_normal_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "transverseSection")
        view["section"]["planeNormal"] = [1, 1, 0]
        with self.assertRaisesRegex(ContractError, "normal must be a unit vector"):
            validate_fixture(invalid)

    def test_view_generation_input_cannot_read_oracle_answers(self) -> None:
        generation_input = prepare_view_generation_input(self.fixture)
        self.assertNotIn("knownAnswers", generation_input)
        self.assertEqual(
            set(generation_input),
            {"geometryRevisionId", "viewContractRevisionId", "views", "drawingSheets", "drawingRequirements"},
        )

    def test_annotation_margin_cannot_be_removed(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "eaveDetail")
        view["paperPlacement"]["minimumAnnotationMarginMm"] = 30
        with self.assertRaisesRegex(ContractError, "annotation margin"):
            validate_fixture(invalid)

    def test_duplicate_view_id_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "axonometric")
        view["id"] = "roofPlan"
        with self.assertRaisesRegex(ContractError, "view ids must be unique"):
            validate_fixture(invalid)

    def test_title_block_cannot_overlap_printable_area(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["drawingSheets"][0]["titleBlockRectMm"] = [10, 10, 831, 584]
        with self.assertRaisesRegex(ContractError, "printable area and title block"):
            validate_fixture(invalid)

    def test_a1_sheet_and_300_dpi_output_are_frozen(self) -> None:
        for sheet in self.fixture["drawingSheets"]:
            self.assertEqual(sheet["pageMm"], [841, 594])
            self.assertEqual(sheet["render300DpiPx"], [9933, 7016])
        output = self.fixture["drawingRequirements"]["outputMatrix"]
        self.assertEqual(output["dxf"]["layouts"], ["T0B-01", "T0B-02"])
        self.assertEqual(output["pdf"]["pages"], 2)

    def test_overlapping_viewports_are_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "columnBaseDetail")
        view["paperPlacement"]["viewportRectMm"] = [180, 65, 150, 270]
        view["paperPlacement"]["annotationSafeRectMm"] = [183, 68, 144, 264]
        view["paperPlacement"]["viewToPaper"] = [[0.1, 0, -45], [0, 0.1, 170], [0, 0, 1]]
        with self.assertRaisesRegex(ContractError, "paper viewports overlap"):
            validate_fixture(invalid)


if __name__ == "__main__":
    unittest.main()
