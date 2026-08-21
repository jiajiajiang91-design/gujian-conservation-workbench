from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIXTURE = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v2-resolved-local-assembly.json"
sys.path.insert(0, str(HERE))

from contracts import ContractError, _view_oracle_signature, load_fixture, prepare_view_generation_input, validate_fixture


class T0BV2ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = load_fixture(FIXTURE)

    @staticmethod
    def _resign_view_oracle(fixture: dict) -> None:
        oracle = fixture["knownAnswers"]["viewOracle"]
        oracle["viewOracleSignature"] = _view_oracle_signature(oracle)

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

    def test_section_depth_projection_uses_frozen_semantic_types(self) -> None:
        for view_id in ("floorPlan", "transverseSection", "longitudinalSection"):
            view = next(item for item in self.fixture["views"] if item["id"] == view_id)
            self.assertTrue(view["section"]["depthProjectionTypes"])
            self.assertNotIn("panTile", view["section"]["depthProjectionTypes"])
            self.assertNotIn("coverTile", view["section"]["depthProjectionTypes"])

    def test_cad_layer_mapping_separates_base_class_and_visibility(self) -> None:
        requirements = self.fixture["drawingRequirements"]
        self.assertEqual(requirements["baseClassLayerMap"]["feature"], "GJ-PROJECTION")
        self.assertIsNone(requirements["visibilityLayerOverride"]["visible"])
        self.assertEqual(requirements["visibilityLayerOverride"]["hidden"], "GJ-HIDDEN")

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

    def test_section_details_freeze_cut_projection_and_material_priority(self) -> None:
        for view_id in ("eaveDetail", "columnBaseDetail"):
            view = next(item for item in self.fixture["views"] if item["id"] == view_id)
            self.assertTrue(view["detail"]["cutTargetTypes"])
            self.assertTrue(view["detail"]["depthProjectionTypes"])
            self.assertIn(view["detail"]["materialOverlapPriority"]["field"], {"componentType", "materialCode"})
            section = view["detail"]["section"]
            self.assertEqual(section["cutSourceDepthMm"], [-0.5, 0.5])
            self.assertEqual(section["retainedProjectionDepthMm"], [0.5, view["viewFrame"]["clipDepthMm"][1]])
            self.assertEqual(section["allowedPaddingMm"], 0.5)

        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "eaveDetail")
        del view["detail"]["depthProjectionTypes"]
        with self.assertRaisesRegex(ContractError, "depth projection types"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "columnBaseDetail")
        del view["detail"]["materialOverlapPriority"]
        with self.assertRaisesRegex(ContractError, "material overlap priority"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "eaveDetail")
        del view["detail"]["section"]["cutSourceDepthMm"]
        with self.assertRaisesRegex(ContractError, "cut source depth"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "columnBaseDetail")
        view["detail"]["section"]["retainedProjectionDepthMm"][-1] = 799
        with self.assertRaisesRegex(ContractError, "retained projection depth"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "columnBaseDetail")
        view["detail"]["section"]["allowedPaddingMm"] = 1
        with self.assertRaisesRegex(ContractError, "section depth padding"):
            validate_fixture(invalid)

    def test_detail_oracle_freezes_full_lines_materials_and_relationships(self) -> None:
        for view_id in ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"):
            answer = self.fixture["knownAnswers"]["viewOracle"]["views"][view_id]
            self.assertEqual(len(answer["visibleLineSetSha256"]), 64)
            self.assertTrue(answer["requiredVisibleEntityIds"])
            self.assertTrue(answer["requiredEntityChains"])
            self.assertEqual(set(answer["materialCodeByType"]), set(answer["requiredTypes"]))

        invalid = deepcopy(self.fixture)
        invalid["knownAnswers"]["viewOracle"]["views"]["bracketDetail"]["requiredEntityChains"] = {}
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "relationship chains"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        invalid["knownAnswers"]["viewOracle"]["views"]["doorWindowDetail"]["topologyCounts"]["latticeCells"] = 12
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "panel and lattice topology"):
            validate_fixture(invalid)

    def test_bracket_detail_includes_the_selected_column(self) -> None:
        answer = self.fixture["knownAnswers"]["viewOracle"]["views"]["bracketDetail"]
        self.assertIn("094027ab-3397-5117-bad8-81c07d961879", answer["requiredVisibleEntityIds"])
        view = next(item for item in self.fixture["views"] if item["id"] == "bracketDetail")
        self.assertEqual(view["detail"]["scopeBoundary"], "ends-at-bearingBlock; purlin-to-bearingBlock continuity is verified in eaveDetail")

    def test_detail_relationship_scope_is_explicit_and_auditable(self) -> None:
        oracle_views = self.fixture["knownAnswers"]["viewOracle"]["views"]
        for view_id in ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"):
            required_visible = set(oracle_views[view_id]["requiredVisibleEntityIds"])
            for relations in oracle_views[view_id]["requiredEntityChains"].values():
                for relation in relations:
                    endpoints = {relation["fromEntityId"], relation["toEntityId"]}
                    if relation["relationScope"] == "inView":
                        self.assertLessEqual(endpoints, required_visible)
                    else:
                        self.assertEqual(endpoints - required_visible, {relation["externalEndpointEntityId"]})

        bracket_cross_view = oracle_views["bracketDetail"]["requiredEntityChains"]["crossViewPurlinBoundary"][0]
        self.assertEqual(bracket_cross_view["continuationViewId"], "eaveDetail")
        door_cross_view = oracle_views["doorWindowDetail"]["requiredEntityChains"]["frameConnectedToWestColumn"][0]
        self.assertEqual(door_cross_view["continuationViewId"], "southElevation")

        invalid = deepcopy(self.fixture)
        relation = invalid["knownAnswers"]["viewOracle"]["views"]["eaveDetail"]["requiredEntityChains"]["rafterToPurlin"][0]
        relation["fromEntityId"] = "00000000-0000-0000-0000-000000000001"
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "endpoints must both be visible"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        relation = invalid["knownAnswers"]["viewOracle"]["views"]["bracketDetail"]["requiredEntityChains"]["crossViewPurlinBoundary"][0]
        del relation["externalEndpointEntityId"]
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "cross-view relationship fields"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        relation = invalid["knownAnswers"]["viewOracle"]["views"]["doorWindowDetail"]["requiredEntityChains"]["frameConnectedToWestColumn"][0]
        relation["continuationViewId"] = "eaveDetail"
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "continuation view"):
            validate_fixture(invalid)

    def test_view_oracle_version_and_signature_are_frozen(self) -> None:
        oracle = self.fixture["knownAnswers"]["viewOracle"]
        self.assertEqual(oracle["oracleAlgorithmVersion"], "t0b-v2-detail-oracle-1")
        self.assertEqual(oracle["viewOracleSignature"], _view_oracle_signature(oracle))

        invalid = deepcopy(self.fixture)
        invalid["knownAnswers"]["viewOracle"]["oracleAlgorithmVersion"] = "t0b-v2-detail-oracle-2"
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "algorithm version"):
            validate_fixture(invalid)

        invalid = deepcopy(self.fixture)
        invalid["knownAnswers"]["viewOracle"]["viewOracleSignature"] = "0" * 64
        with self.assertRaisesRegex(ContractError, "canonical payload"):
            validate_fixture(invalid)

    def test_missing_view_oracle_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        del invalid["knownAnswers"]["viewOracle"]["views"]["roofPlan"]
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "oracle matrix is incomplete"):
            validate_fixture(invalid)

    def test_ambiguous_projection_direction_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "southElevation")
        view["directionSemantics"] = "unspecified"
        with self.assertRaisesRegex(ContractError, "direction semantics are ambiguous"):
            validate_fixture(invalid)

    def test_projection_display_boundary_is_frozen(self) -> None:
        invalid = deepcopy(self.fixture)
        view = next(item for item in invalid["views"] if item["id"] == "roofPlan")
        view["projection"]["displayTypes"].append("groundLayer")
        with self.assertRaisesRegex(ContractError, "projection display types"):
            validate_fixture(invalid)

    def test_projection_oracle_requires_visible_sources(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["knownAnswers"]["viewOracle"]["views"]["axonometric"]["requiredVisibleEntityIds"] = []
        self._resign_view_oracle(invalid)
        with self.assertRaisesRegex(ContractError, "required visible entities"):
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
        self.assertNotIn("oracle", str(generation_input).lower())
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
