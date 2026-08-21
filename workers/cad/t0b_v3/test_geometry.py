from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import trimesh

from workers.cad.t0b_v3.build_geometry import build_outputs, candidate_answers
from workers.cad.t0b_v3.contracts import REQUIRED_COMPONENT_TYPES, REQUIRED_INTERFACE_ROLES, load_fixture
from workers.cad.t0b_v3.geometry import GeometryModel, build_geometry, canonical_mesh_hash, export_glb, validate_model


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIXTURE = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v3-local-construction-fixture.json"


class T0BV3GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE, allow_unfrozen=True)
        cls.model = build_geometry(cls.fixture)
        cls.manifest = cls.model.manifest()

    def test_generation_is_deterministic_and_complete(self) -> None:
        second = build_geometry(self.fixture).manifest()
        self.assertEqual(self.manifest["geometrySignature"], second["geometrySignature"])
        self.assertEqual({item.component_type for item in self.model.entities}, REQUIRED_COMPONENT_TYPES)
        self.assertEqual({item["role"] for item in self.model.interfaces}, REQUIRED_INTERFACE_ROLES)
        self.assertEqual(len(self.model.entities), len({item.entity_id for item in self.model.entities}))

    def test_every_entity_participates_in_the_expanded_interface_graph(self) -> None:
        connected = {
            entity_id
            for item in self.model.interfaces
            for entity_id in (item["fromEntityId"], item["toEntityId"])
        }
        self.assertEqual(connected, {item.entity_id for item in self.model.entities})
        self.assertGreater(len(self.model.interfaces), len(self.model.entities))

    def test_interfaces_bind_mesh_faces_and_dimension_facts(self) -> None:
        known_dimension_ids = {
            item["dimensionFactId"] for item in self.manifest["dimensionFacts"]
        }
        for item in self.model.interfaces:
            witness = item["surfaceWitness"]
            self.assertTrue(witness["fromFaceIndices"], item["interfaceId"])
            self.assertTrue(witness["toFaceIndices"], item["interfaceId"])
            self.assertLessEqual(
                witness["minimumSampledSurfaceDistanceMm"],
                item["maximumGapMm"] + 1e-6
                if item["contactMode"] != "clearance"
                else item["expectedGapMm"] + self.fixture["geometryValidation"]["clearanceToleranceMm"],
                item["interfaceId"],
            )
            self.assertTrue(set(item["dimensionFactIds"]) <= known_dimension_ids)
            self.assertNotIn("dimensionRefs", item)
            self.assertEqual(
                item["surfaceWitness"]["surfaceRefResolution"]["selectionBasis"],
                "nearest-mesh-surface-patch",
            )
            self.assertTrue(item["surfaceWitness"]["fromPatch"]["patchHash"])
            self.assertTrue(item["surfaceWitness"]["toPatch"]["patchHash"])

    def test_entities_keep_geometry_and_construction_resolution_separate(self) -> None:
        for entity in self.manifest["entities"]:
            self.assertEqual(entity["resolution"]["geometric"], "resolved")
            self.assertIn(entity["resolution"]["construction"], {"demoDefined", "unknown"})
            self.assertEqual(entity["resolution"]["l1DemoEligibility"], "blocked")
            self.assertTrue(entity["watertight"], entity["key"])
            self.assertTrue(entity["windingConsistent"], entity["key"])
            self.assertEqual(entity["producerType"], "demo")
            self.assertEqual(entity["formalEligibility"], "ineligible")

    def test_count_parameters_are_not_millimetre_dimensions(self) -> None:
        count_names = {"count", "courses", "facets", "longitudinalSegments", "countPerLeaf", "rows", "columns", "panelsPerLeaf"}
        found = 0
        for entity in self.manifest["entities"]:
            parameter_by_name = {item["stableKey"]: item for item in entity["parameterFacts"]}
            dimension_names = {item["category"] for item in entity["dimensionFacts"]}
            for name in count_names & set(parameter_by_name):
                found += 1
                self.assertEqual(parameter_by_name[name]["valueType"], "count")
                self.assertEqual(parameter_by_name[name]["unit"], "1")
                self.assertNotIn(name, dimension_names)
        self.assertGreater(found, 0)

    def test_unknowns_are_structured_and_block_professional_qualification(self) -> None:
        unknowns = [item for entity in self.manifest["entities"] for item in entity["unknowns"]]
        self.assertGreater(len(unknowns), 0)
        for item in unknowns:
            self.assertTrue(item["reasonCode"])
            self.assertTrue(item["requiredEvidence"])
            self.assertTrue(item["affectedEntityId"])
            self.assertTrue(item["blocksFormalEligibility"])
            self.assertTrue(item["blocksL1"])

    def test_neutral_support_terms_do_not_claim_typology(self) -> None:
        by_type = {item["componentType"]: item for item in self.manifest["entities"]}
        for component_type, expected in {
            "bracketSeat": "承托座（团队演示）",
            "bracketArm": "承托臂（团队演示）",
            "bearingBlock": "檩下承块（团队演示）",
        }.items():
            domain = by_type[component_type]["domainTerm"]
            self.assertEqual(domain["displayNameZh"], expected)
            self.assertIsNone(domain["typologyClaim"])
            self.assertEqual(domain["typologyEvidenceRefs"], [])

    def test_support_half_lap_and_opening_members_are_explicit(self) -> None:
        by_key = {item["key"]: item for item in self.manifest["entities"]}
        arm_features = {item["featureName"] for item in by_key["bracket-arm-x:0:0"]["featureIds"]}
        self.assertIn("central-half-lap", arm_features)
        self.assertIn("arm-x-half-lap-top", arm_features)
        self.assertEqual(next(item for item in self.model.interfaces if item["role"] == "arm-cross-half-lap")["interfaceKind"], "halfLap")
        for key in (
            "door-frame:left-stile",
            "door-leaf:0:stile:left",
            "door-leaf:0:rail:0",
            "door-leaf:0:panel:0",
            "lattice:left:frame:left",
            "lattice:left:vbar:1",
            "lattice:left:hbar:1",
        ):
            self.assertIn(key, by_key)

    def test_ground_bearing_and_directed_support_flow_are_explicit(self) -> None:
        by_key = {item.key: item for item in self.model.entities}
        for x_index in range(2):
            for y_index in range(2):
                pad = by_key[f"ground:bearing:{x_index}:{y_index}"].mesh
                foundation = by_key[f"foundation:{x_index}:{y_index}:course:0"].mesh
                self.assertAlmostEqual(float(pad.bounds[1, 2]), float(foundation.bounds[0, 2]), places=6)
        bearing_edges = [
            item for item in self.model.interfaces if item["role"] == "foundation-bearing-ground"
        ]
        self.assertEqual(len(bearing_edges), 4)
        self.assertTrue(all(item["direction"] == [0, 0, -1] for item in bearing_edges))

    def test_door_panel_and_rail_are_single_continuous_solids(self) -> None:
        by_key = {item.key: item for item in self.model.entities}
        for leaf in range(2):
            for panel in range(4):
                self.assertEqual(
                    len(by_key[f"door-leaf:{leaf}:panel:{panel}"].mesh.split(only_watertight=False)),
                    1,
                )
            for rail in range(5):
                self.assertEqual(
                    len(by_key[f"door-leaf:{leaf}:rail:{rail}"].mesh.split(only_watertight=False)),
                    1,
                )

    def test_door_threshold_bears_on_terrace_without_penetration(self) -> None:
        by_key = {item.key: item for item in self.model.entities}
        threshold = by_key["door-frame:threshold"].mesh
        terrace = by_key["terrace:course:2"].mesh
        self.assertAlmostEqual(float(threshold.bounds[0, 2]), float(terrace.bounds[1, 2]), places=6)
        overlap = np.maximum(
            np.minimum(threshold.bounds[1], terrace.bounds[1])
            - np.maximum(threshold.bounds[0], terrace.bounds[0]),
            0,
        )
        self.assertAlmostEqual(float(np.prod(overlap)), 0.0, places=6)

    def test_observation_is_bound_without_diagnosis(self) -> None:
        item = self.manifest["observationCandidates"][0]
        self.assertTrue(item["targetEntityId"])
        self.assertTrue(item["targetSurfaceRef"])
        self.assertEqual(item["locationGeometry"]["type"], "polyline3d")
        self.assertIsNone(item["diagnosis"])
        self.assertIsNone(item["cause"])
        self.assertIsNone(item["severity"])

    def test_roof_finish_covers_the_fly_rafter_extent(self) -> None:
        by_key = {item.key: item for item in self.model.entities}
        south_fly = by_key["fly-rafter:south:0"].mesh.bounds
        south_board = by_key["roof-board:south:0"].mesh.bounds
        south_pan = [item.mesh.bounds for item in self.model.entities if item.key.startswith("pan-tile:south:")]
        self.assertLessEqual(south_board[0][1], south_fly[0][1] + 1.0)
        self.assertLessEqual(min(item[0][1] for item in south_pan), south_fly[0][1] + 1.0)

    def test_glb_keeps_one_mesh_per_entity_and_orientation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-v3-glb-") as directory:
            path = Path(directory) / "sample.glb"
            export_glb(self.model, str(path))
            scene = trimesh.load(path, force="scene")
            self.assertEqual(len(scene.geometry), len(self.model.entities))
            source_min = np.min([item.mesh.bounds[0] for item in self.model.entities], axis=0)
            source_max = np.max([item.mesh.bounds[1] for item in self.model.entities], axis=0)
            expected = np.asarray(
                [
                    [source_min[0], source_min[2], -source_max[1]],
                    [source_max[0], source_max[2], -source_min[1]],
                ]
            ) * 0.001
            np.testing.assert_allclose(scene.bounds, expected, atol=1e-6)
            self.assertGreater(path.stat().st_size, 0)

    def test_mesh_hash_changes_when_oriented_topology_changes(self) -> None:
        entity = self.model.entities[0]
        changed = entity.mesh.copy()
        before = canonical_mesh_hash(changed)
        changed.faces[0] = changed.faces[0][::-1]
        self.assertNotEqual(before, canonical_mesh_hash(changed))

    def test_external_dependency_is_rejected(self) -> None:
        model = GeometryModel(deepcopy(self.model.fixture), self.model.entities, self.model.interfaces)
        model.fixture["sourceRefs"] = ["file:D:/Downloads/reference.dwg"]
        with self.assertRaisesRegex(ValueError, "demo fixture"):
            validate_model(model)

    def test_candidate_answers_match_frozen_fields_when_frozen(self) -> None:
        known = self.fixture["knownAnswers"]
        if known["geometrySignature"] == "UNFROZEN":
            self.skipTest("fixture is not frozen yet")
        answers = candidate_answers(FIXTURE)
        self.assertEqual(answers["geometrySignature"], known["geometrySignature"])
        self.assertEqual(answers["sourceMeshBundleSha256"], known["sourceMeshBundleSha256"])

    def test_frozen_build_is_byte_deterministic(self) -> None:
        if self.fixture["knownAnswers"]["geometrySignature"] == "UNFROZEN":
            self.skipTest("fixture is not frozen yet")
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-v3-build-") as directory:
            root = Path(directory)
            first = build_outputs(FIXTURE, root / "first")
            second = build_outputs(FIXTURE, root / "second")
            self.assertEqual(first["outputs"], second["outputs"])
            self.assertFalse(first["qualification"]["localProfessionalSampleEligible"])
            self.assertFalse(first["qualification"]["L1"])


if __name__ == "__main__":
    unittest.main()
