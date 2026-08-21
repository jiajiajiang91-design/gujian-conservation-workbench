from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import trimesh

from workers.cad.t0b_v2.build_geometry import build_outputs
from workers.cad.t0b_v2.contracts import REQUIRED_COMPONENT_TYPES, load_fixture
from workers.cad.t0b_v2.geometry import build_geometry, export_glb, validate_geometry
from workers.cad.t0b_v2.verify_geometry import verify_geometry


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIXTURE = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v2-resolved-local-assembly.json"


class T0BV2GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE)
        cls.model = build_geometry(cls.fixture)

    def test_geometry_is_stable_and_complete(self) -> None:
        second = build_geometry(self.fixture)
        self.assertEqual(self.model.manifest()["geometrySignature"], second.manifest()["geometrySignature"])
        self.assertEqual({item.component_type for item in self.model.entities}, REQUIRED_COMPONENT_TYPES)
        self.assertEqual(len({item.entity_id for item in self.model.entities}), len(self.model.entities))

    def test_every_entity_has_resolved_semantics(self) -> None:
        for entity in self.model.entities:
            self.assertEqual(entity.geometry_status, "resolved")
            self.assertTrue(entity.type_id)
            self.assertTrue(entity.material_id)
            self.assertTrue(entity.source_refs)
            self.assertTrue(entity.mesh.is_watertight, entity.key)

    def test_manifest_keeps_revision_and_instance_relations(self) -> None:
        manifest = self.model.manifest()
        self.assertEqual(manifest["geometryRevisionId"], self.fixture["geometryRevisionId"])
        self.assertTrue(manifest["relations"])
        entity_ids = {item["entityId"] for item in manifest["entities"]}
        self.assertTrue(all(item["fromEntityId"] in entity_ids and item["toEntityId"] in entity_ids for item in manifest["relations"]))

    def test_glb_preserves_one_node_per_semantic_entity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-v2-") as directory:
            path = Path(directory) / "resolved-local-assembly.glb"
            export_glb(self.model, path)
            scene = trimesh.load(path, force="scene")
            self.assertEqual(len(scene.geometry), len(self.model.entities))
            self.assertGreater(path.stat().st_size, 0)
            original_min = np.min([item.mesh.bounds[0] for item in self.model.entities], axis=0)
            original_max = np.max([item.mesh.bounds[1] for item in self.model.entities], axis=0)
            expected_bounds = np.asarray(
                [
                    [original_min[0], original_min[2], -original_max[1]],
                    [original_max[0], original_max[2], -original_min[1]],
                ]
            ) * 0.001
            np.testing.assert_allclose(scene.bounds, expected_bounds, atol=1e-6)

    def test_manifest_round_trips_as_json(self) -> None:
        encoded = json.dumps(self.model.manifest(), ensure_ascii=False, sort_keys=True)
        self.assertEqual(json.loads(encoded)["geometryRevisionId"], self.fixture["geometryRevisionId"])

    def test_build_record_does_not_claim_qualification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-v2-build-") as directory:
            first_directory = Path(directory) / "first"
            second_directory = Path(directory) / "second"
            record = build_outputs(FIXTURE, first_directory)
            second = build_outputs(FIXTURE, second_directory)
            self.assertEqual(record["status"], "generated-not-qualified")
            self.assertEqual(record["verificationStatus"], "passed-geometry-only")
            self.assertEqual(
                {item["path"] for item in record["outputs"]},
                {"geometry-manifest.json", "source-meshes.ndjson.gz", "resolved-local-assembly.glb", "geometry-verification.json"},
            )
            self.assertEqual(record["geometrySignature"], second["geometrySignature"])
            self.assertEqual(record["outputs"], second["outputs"])

            report = verify_geometry(
                FIXTURE,
                first_directory / "geometry-manifest.json",
                first_directory / "source-meshes.ndjson.gz",
                first_directory / "resolved-local-assembly.glb",
            )
            self.assertFalse(report["qualification"]["localProfessionalSampleEligible"])
            self.assertTrue(all(item["passed"] for item in report["checks"]))
            self.assertTrue(all(item["passed"] for item in report["negativeCases"]))

    def test_renamed_box_cannot_replace_a_curved_tile(self) -> None:
        model = build_geometry(self.fixture)
        target = next(item for item in model.entities if item.component_type == "panTile")
        replacement = trimesh.creation.box(extents=[260, 360, 18])
        replacement.apply_translation(target.mesh.centroid)
        target.mesh = replacement
        with self.assertRaisesRegex(ValueError, "curved tile section"):
            validate_geometry(model, self.fixture)

    def test_external_reference_cannot_enter_geometry_sources(self) -> None:
        model = build_geometry(self.fixture)
        model.source_refs = ["file:external-reference"]
        with self.assertRaisesRegex(ValueError, "isolated to the demo fixture"):
            validate_geometry(model, self.fixture)

    def test_external_reference_cannot_enter_one_entity(self) -> None:
        model = build_geometry(self.fixture)
        model.entities[0].source_refs = ["file:external-reference"]
        with self.assertRaisesRegex(ValueError, "not isolated to the demo fixture"):
            validate_geometry(model, self.fixture)

    def test_mesh_hash_locks_vertex_geometry(self) -> None:
        model = build_geometry(self.fixture)
        target = model.entities[0]
        before = target.record()["meshHash"]
        target.mesh.vertices[0, 0] += 1
        self.assertNotEqual(before, target.record()["meshHash"])


if __name__ == "__main__":
    unittest.main()
