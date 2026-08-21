from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import unittest
from uuid import uuid5

from workers.cad.t0b_v2.drawing_contract import (
    DRAWING_PACKAGE_REVISION_NAMESPACE,
    DrawingContractError,
    drawing_contract_signature,
    load_drawing_package_contract,
    prepare_drawing_generation_input,
    validate_drawing_package_contract,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CONTRACT_PATH = next(ROOT.rglob("t0b-v2-drawing-package-contract.json"))


def _resign(contract: dict) -> dict:
    contract["contractSignature"] = drawing_contract_signature(contract)
    contract["contractRevisionId"] = str(uuid5(DRAWING_PACKAGE_REVISION_NAMESPACE, contract["contractSignature"]))
    return contract


class T0BV2DrawingPackageContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = load_drawing_package_contract(CONTRACT_PATH)

    def test_signature_revision_and_ten_committed_views_are_frozen(self) -> None:
        self.assertEqual(self.contract["contractSignature"], drawing_contract_signature(self.contract))
        self.assertEqual(
            self.contract["contractRevisionId"],
            str(uuid5(DRAWING_PACKAGE_REVISION_NAMESPACE, self.contract["contractSignature"])),
        )
        self.assertEqual(len(self.contract["viewGeometryBindings"]), 10)
        for binding in self.contract["viewGeometryBindings"]:
            path = CONTRACT_PATH.parent / Path(*binding["relativePath"].split("/"))
            self.assertTrue(path.is_file())
            self.assertEqual(len(binding["fileSha256"]), 64)
            self.assertEqual(len(binding["viewGeometrySha256"]), 64)

    def test_twelve_p0_items_map_to_contract_fields(self) -> None:
        p0 = self.contract["p0Requirements"]
        self.assertEqual([item["id"] for item in p0], [f"DP-P0-{index:02d}" for index in range(1, 13)])
        self.assertTrue(all(item["contractFields"] for item in p0))

    def test_sanitized_input_contains_no_fixture_or_oracle(self) -> None:
        generation_input = prepare_drawing_generation_input(self.contract)
        serialized = json.dumps(generation_input, ensure_ascii=False)
        self.assertNotIn("knownAnswers", serialized)
        self.assertNotIn("viewOracle", serialized)
        self.assertFalse(generation_input["dependencies"]["fixtureReadableByIrBuilder"])
        self.assertFalse(generation_input["dependencies"]["geometryRecalculationAllowed"])
        self.assertFalse(generation_input["dependencies"]["structuralLineSupplementAllowed"])

    def test_model_space_is_one_to_one_and_staging_is_translation_only(self) -> None:
        self.assertEqual(self.contract["modelSpacePolicy"]["insunits"], 4)
        self.assertEqual(self.contract["modelSpacePolicy"]["scale"], "1:1")
        stages = self.contract["viewStages"]
        for stage in stages:
            self.assertEqual([row[:2] for row in stage["viewToModelSpace"]], [[1, 0], [0, 1], [0, 0]])
            self.assertEqual([row[:2] for row in stage["modelSpaceToView"]], [[1, 0], [0, 1], [0, 0]])
        for index, first in enumerate(stages):
            for second in stages[index + 1 :]:
                a, b = first["stagedBoundsMm"], second["stagedBoundsMm"]
                self.assertTrue(a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])

    def test_two_a1_layouts_freeze_five_viewports_each(self) -> None:
        layouts = self.contract["layouts"]
        self.assertEqual([layout["layoutName"] for layout in layouts], ["T0B-01", "T0B-02"])
        for layout in layouts:
            self.assertEqual(layout["pageMm"], [841, 594])
            self.assertEqual(len(layout["viewports"]), 5)
            self.assertTrue(all(viewport["locked"] and viewport["cadType"] == "VIEWPORT" for viewport in layout["viewports"]))
            self.assertEqual(layout["frameSpace"], "paperSpace")
            self.assertEqual(layout["titleBlockSpace"], "paperSpace")

    def test_native_objects_layers_material_and_provenance_are_closed(self) -> None:
        self.assertEqual(
            set(self.contract["nativeCadPolicy"]["requiredTypes"]),
            {"DIMENSION", "TEXT", "MTEXT", "HATCH", "INSERT", "LAYOUT", "VIEWPORT"},
        )
        self.assertEqual(self.contract["layerPolicy"]["baseClassLayerMap"]["feature"], "GJ-PROJECTION")
        self.assertEqual(self.contract["layerPolicy"]["visibilityLayerOverride"]["hidden"], "GJ-HIDDEN")
        self.assertTrue(self.contract["layerPolicy"]["hiddenOverrideOnly"])
        self.assertEqual(self.contract["materialPolicy"]["boundarySourceKinds"], ["ViewGeometry.cutRegion", "ViewGeometry.materialRegion"])
        self.assertEqual(self.contract["materialPolicy"]["patternOwnership"], "team-owned")
        ceramic = self.contract["materialPolicy"]["patterns"]["ceramic"]
        self.assertEqual(ceramic["patternId"], "GJ-CERAMIC-DEMO")
        self.assertEqual(ceramic["appliesToMaterialCodes"], ["ceramic-demo", "ceramic"])
        self.assertEqual((ceramic["angleDeg"], ceramic["spacingMm"], ceramic["scale"], ceramic["unit"]), (45, 18, 1.0, "mm"))
        self.assertEqual(ceramic["source"], "team-owned-demo")
        self.assertIs(ceramic["externalSourceDerived"], False)
        self.assertEqual(self.contract["provenancePolicy"]["structuralCoverage"], 1.0)
        self.assertEqual(self.contract["provenancePolicy"]["annotationCoverage"], 1.0)
        self.assertEqual(self.contract["provenancePolicy"]["sidecarFormat"], "ndjson")

    def test_four_detail_visual_gates_and_bracket_blocker_are_explicit(self) -> None:
        gates = self.contract["detailGates"]
        self.assertTrue(gates["eaveDetail"]["isolatedUpperPurlinCalloutRequired"])
        self.assertTrue(gates["eaveDetail"]["breakAtEveryCropTermination"])
        self.assertEqual(gates["bracketDetail"]["mandatoryNote"], "团队演示承托构造，非实测/非正式节点")
        self.assertEqual(gates["bracketDetail"]["l1BlockerCode"], "BRACKET_DETAIL_SIMPLIFIED_GEOMETRY")
        self.assertEqual(gates["columnBaseDetail"]["requiredHatches"], ["timber", "stone", "earth"])
        self.assertEqual(gates["columnBaseDetail"]["requiredLevelsMm"], [-800, 0, 600])
        self.assertEqual(gates["columnBaseDetail"]["requiredDimensionsMm"], [560, 400, 240, 800])
        self.assertEqual(gates["doorWindowDetail"]["requiredDimensionsMm"], [1800, 2700, 720, 1500])
        self.assertEqual(gates["doorWindowDetail"]["requiredCallouts"], ["frame", "leaf", "lattice"])

    def test_every_dimension_and_level_requirement_freezes_source_values(self) -> None:
        for view_id, categories in self.contract["annotationRequirements"]["views"].items():
            for category in ("dimensions", "levels"):
                for record in categories[category]:
                    with self.subTest(view_id=view_id, category=category, requirement_id=record["requirementId"]):
                        self.assertIn("valuesMm", record)
                        self.assertIsInstance(record["valuesMm"], (list, dict))
                        self.assertTrue(record["valuesMm"])

    def test_outputs_bound_font_and_compatibility_remain_qualification_gates(self) -> None:
        outputs = self.contract["outputMatrix"]
        self.assertTrue(all(outputs[name]["sourceIrRequired"] for name in ("dxf", "svg", "pdf", "reviewPng")))
        self.assertEqual(outputs["reviewPng"]["pixelSize"], [9933, 7016])
        self.assertEqual(outputs["reviewPng"]["dpi"], 300)
        font = self.contract["fontPolicy"]
        self.assertEqual(font["currentBindingStatus"], "bound-licensed-static-instance")
        self.assertIsNone(font["blockerCode"])
        self.assertEqual(len(font["boundFonts"]), 1)
        self.assertEqual(font["boundFonts"][0]["instanceWeight"], 400)
        self.assertEqual(font["boundFonts"][0]["family"], "Gujian Sans SC")
        self.assertEqual(font["boundFonts"][0]["cadStyleName"], "GJ-GUJIAN-SANS-SC")
        self.assertEqual(font["boundFonts"][0]["licenseSpdx"], "OFL-1.1")
        self.assertEqual(set(font["forbiddenFamilies"]), {"SimHei", "LiSu", "NEW-ROMD"})
        self.assertEqual(set(self.contract["compatibilityMatrix"]), {"AutoCAD", "QCAD"})
        self.assertFalse(self.contract["compatibilityMatrix"]["QCAD"]["roundtripCopyIsCanonical"])
        self.assertEqual(self.contract["compatibilityMatrix"]["QCAD"]["supportStatus"], "unsupported-lossless-roundtrip")
        self.assertEqual(self.contract["compatibilityMatrix"]["QCAD"]["qualificationBlocker"], "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED")

    def test_qualification_and_determinism_cannot_be_relaxed(self) -> None:
        boundary = self.contract["qualificationBoundary"]
        self.assertEqual(boundary["status"], "generated-not-qualified")
        self.assertIs(boundary["L1"], False)
        self.assertEqual(boundary["useBoundary"], ["demo-only", "not-for-formal-signoff"])
        self.assertFalse(boundary["generatorMaySetEligible"])
        self.assertNotIn("FONT_ASSET_NOT_BOUND", boundary["requiredBlockers"])
        self.assertNotIn("DRAWING_OUTPUTS_NOT_BUILT", boundary["requiredBlockers"])
        self.assertIn("BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", boundary["requiredBlockers"])
        self.assertIn("QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED", boundary["requiredBlockers"])
        self.assertIn("AUTOCAD_REAUDIT_REQUIRED", boundary["requiredBlockers"])
        self.assertEqual(self.contract["determinismPolicy"]["fixedTimestamp"], "2000-01-01T00:00:00Z")
        self.assertTrue(self.contract["determinismPolicy"]["temporaryDirectoryDoubleBuildRequired"])
        invalid = deepcopy(self.contract)
        invalid["qualificationBoundary"]["L1"] = True
        with self.assertRaisesRegex(DrawingContractError, "qualification"):
            validate_drawing_package_contract(_resign(invalid))

    def test_external_scheme_paths_dwg_assets_and_dependency_hashes_are_rejected(self) -> None:
        variants = [
            "external:forbidden",
            "D:/Downloads/forbidden.json.gz",
            "t0b-v2-outputs/寺庙古建筑设计方案图.dwg",
            "t0b-v2-outputs/一套完整的古建施工图.dwg",
            "t0b-v2-outputs/xref.view-geometry.json.gz",
            "t0b-v2-outputs/image.view-geometry.json.gz",
            "t0b-v2-outputs/underlay.view-geometry.json.gz",
            "t0b-v2-outputs/proxy.view-geometry.json.gz",
        ]
        for index, value in enumerate(variants):
            invalid = deepcopy(self.contract)
            invalid["viewGeometryBindings"][0]["relativePath"] = value
            with self.subTest(index=index), self.assertRaisesRegex(DrawingContractError, "path|forbidden|committed"):
                validate_drawing_package_contract(_resign(invalid))
        invalid = deepcopy(self.contract)
        invalid["externalAssetHash"] = "a" * 64
        with self.assertRaisesRegex(DrawingContractError, "root"):
            validate_drawing_package_contract(_resign(invalid))

    def test_annotation_payload_rejects_external_references_paths_names_and_hashes(self) -> None:
        variants = [
            "external:forbidden",
            "D:/Downloads/forbidden.json",
            "寺庙古建筑设计方案图.dwg",
            "一套完整的古建施工图.dwg",
            "a" * 64,
        ]
        for value in variants:
            invalid = deepcopy(self.contract)
            invalid["annotationRequirements"]["views"]["floorPlan"]["dimensions"][0]["sourceRefs"] = [value]
            with self.subTest(value=value), self.assertRaisesRegex(DrawingContractError, "sourceRefs|forbidden|absolute|hash"):
                validate_drawing_package_contract(_resign(invalid))

        invalid = deepcopy(self.contract)
        invalid["annotationRequirements"]["views"]["bracketDetail"]["notes"][0]["text"] = "xref:forbidden"
        with self.assertRaisesRegex(DrawingContractError, "forbidden"):
            validate_drawing_package_contract(_resign(invalid))

    def test_external_hatch_name_path_hash_and_unknown_material_map_are_rejected(self) -> None:
        variants = [
            ("patternId", "ACAD_ISO02W100"),
            ("definition", "D:/Downloads/external-pattern.pat"),
            ("definition", "a" * 64),
        ]
        for field, value in variants:
            invalid = deepcopy(self.contract)
            invalid["materialPolicy"]["patterns"]["ceramic"][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(DrawingContractError, "forbidden|absolute|hash|invalid"):
                validate_drawing_package_contract(_resign(invalid))

        invalid = deepcopy(self.contract)
        invalid["materialPolicy"]["materialCodePatternMap"]["unknown"] = "ceramic"
        with self.assertRaisesRegex(DrawingContractError, "resolution map"):
            validate_drawing_package_contract(_resign(invalid))

    def test_bound_font_path_hash_weight_and_reserved_name_policy_are_frozen(self) -> None:
        variants = [
            ("relativeFontPath", "D:/Downloads/font.ttf"),
            ("relativeFontPath", "workers/cad/t0b_v2/assets/fonts/external.dwg"),
            ("relativeManifestPath", "../font-manifest.json"),
            ("sha256", "a" * 64),
            ("sourceFontSha256", "b" * 64),
            ("manifestSha256", "c" * 64),
            ("instanceWeight", 100),
        ]
        for field, value in variants:
            invalid = deepcopy(self.contract)
            invalid["fontPolicy"]["boundFonts"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(DrawingContractError, "font|path|hash|weight|dependency"):
                validate_drawing_package_contract(_resign(invalid))
        invalid = deepcopy(self.contract)
        invalid["fontPolicy"]["boundFonts"][0]["namingCompliance"]["reservedNamesUsedByDerivedFamily"] = ["Source"]
        with self.assertRaisesRegex(DrawingContractError, "reserved-name"):
            validate_drawing_package_contract(_resign(invalid))

    def test_contract_change_requires_new_signature_and_revision(self) -> None:
        invalid = deepcopy(self.contract)
        invalid["layerPolicy"]["minimumTextHeightMm"] = 3.0
        with self.assertRaisesRegex(DrawingContractError, "signature"):
            validate_drawing_package_contract(invalid)
        resigned = _resign(invalid)
        self.assertNotEqual(resigned["contractSignature"], self.contract["contractSignature"])
        self.assertNotEqual(resigned["contractRevisionId"], self.contract["contractRevisionId"])


if __name__ == "__main__":
    unittest.main()
