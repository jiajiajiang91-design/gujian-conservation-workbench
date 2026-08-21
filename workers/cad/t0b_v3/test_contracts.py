from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import unittest

from .contracts import ContractError, load_fixture, sanitized_generation_input, validate_fixture


FIXTURE = Path(__file__).parents[3] / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v3-local-construction-fixture.json"


class V3GeometryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE, allow_unfrozen=True)

    def test_demo_fixture_contract_is_complete(self) -> None:
        self.assertEqual(len(self.fixture["componentTemplates"]), 27)
        self.assertEqual(
            {item["role"] for item in self.fixture["interfaceTemplates"]},
            set(self.fixture["requiredInterfaceRoles"]),
        )
        self.assertEqual(self.fixture["formalEligibility"], "ineligible")
        self.assertEqual(
            {item["resolution"]["l1DemoEligibility"] for item in self.fixture["componentTemplates"].values()},
            {"blocked"},
        )

    def test_all_template_parameters_have_explicit_value_types(self) -> None:
        declared = {
            name: value_type
            for value_type, definition in self.fixture["parameterTypeRegistry"].items()
            for name in definition["parameters"]
        }
        used = {
            name
            for template in self.fixture["componentTemplates"].values()
            for name in template["parameters"]
        }
        self.assertEqual(set(declared), used)
        for name in ("courses", "facets", "longitudinalSegments", "countPerLeaf", "rows", "columns"):
            self.assertEqual(declared[name], "count")

    def test_unknown_registry_is_structured_and_blocks_qualification(self) -> None:
        used = {
            stable_key
            for template in self.fixture["componentTemplates"].values()
            for stable_key in template["unknowns"]
        }
        self.assertTrue(used <= set(self.fixture["unknownRegistry"]))
        for stable_key in used:
            item = self.fixture["unknownRegistry"][stable_key]
            self.assertTrue(item["requiredEvidence"])
            self.assertTrue(item["blocksFormalEligibility"])
            self.assertTrue(item["blocksL1"])

    def test_generation_input_does_not_receive_known_answers(self) -> None:
        payload = sanitized_generation_input(self.fixture)
        self.assertNotIn("knownAnswers", payload)
        self.assertEqual(payload["referenceIsolation"]["externalAssetsAllowed"], False)

    def test_neutral_support_terms_cannot_claim_a_typology(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["componentTemplates"]["bracketArm"]["domainTerm"].update(
            {"displayNameZh": "斗栱构件", "typologyStatus": "evidenceConfirmed", "typologyClaim": "某类型"}
        )
        with self.assertRaisesRegex(ContractError, "frozen neutral term"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_geometry_and_construction_resolution_are_independent(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["componentTemplates"]["doorFrameMember"]["resolution"] = {
            "geometric": "simplified",
            "construction": "demoDefined",
            "l1DemoEligibility": "blocked",
        }
        with self.assertRaisesRegex(ContractError, "must be resolved"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_required_interface_role_cannot_be_removed(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["interfaceTemplates"] = [
            item for item in invalid["interfaceTemplates"] if item["role"] != "arm-cross-half-lap"
        ]
        with self.assertRaisesRegex(ContractError, "coverage is incomplete"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_interface_must_bind_surfaces(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["interfaceTemplates"][0]["fromSurfaceRef"] = ""
        with self.assertRaisesRegex(ContractError, "must bind two surfaces"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_interface_dimension_reference_must_resolve(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["interfaceTemplates"][0]["dimensionRefs"] = ["DIM-NOT-DECLARED"]
        with self.assertRaisesRegex(ContractError, "unknown dimension fact"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_foundation_material_and_name_are_neutral(self) -> None:
        template = self.fixture["componentTemplates"]["foundationLayer"]
        self.assertEqual(template["materialCode"], "earth-demo")
        self.assertNotIn("stone", template["domainTerm"]["stableKey"].lower())
        self.assertIn("做法未判定", template["domainTerm"]["displayNameZh"])

    def test_observation_candidate_binds_entity_surface_and_location(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["observationCandidates"][0]["targetSurfaceRef"] = ""
        with self.assertRaisesRegex(ContractError, "bind an entity surface"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_demo_observation_cannot_contain_diagnosis(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["observationCandidates"][0]["diagnosis"] = "开裂"
        with self.assertRaisesRegex(ContractError, "cannot contain a diagnosis"):
            validate_fixture(invalid, allow_unfrozen=True)

    def test_external_source_scheme_is_rejected(self) -> None:
        invalid = deepcopy(self.fixture)
        invalid["sourceRefs"] = ["file:D:/Downloads/reference.dwg"]
        with self.assertRaisesRegex(ContractError, "demo scheme"):
            validate_fixture(invalid, allow_unfrozen=True)


if __name__ == "__main__":
    unittest.main()
