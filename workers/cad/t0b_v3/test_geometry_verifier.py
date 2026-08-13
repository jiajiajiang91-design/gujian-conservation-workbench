from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import unittest

from .build_geometry import build_outputs
from .verify_geometry import (
    VerificationError,
    _load_source_bundle,
    _verify_dimensions,
    _verify_entities,
    _verify_glb,
    _verify_interfaces,
    _verify_local_construction,
    _verify_roof_coverage,
    _verify_tile_laps,
    _verify_unexpected_overlap,
)


ROOT = Path(__file__).parents[3]
OUTPUT = ROOT / "apps" / "server" / ".data" / "acceptance" / "milestone-two" / "t8a-demo"


class V3IndependentGeometryVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        fixture_path = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v3-local-construction-fixture.json"
        build_outputs(fixture_path, OUTPUT)
        cls.manifest = json.loads((OUTPUT / "geometry-manifest.json").read_text(encoding="utf-8"))
        _, cls.meshes = _load_source_bundle(OUTPUT / "source-meshes.ndjson.gz")
        cls.fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    def test_verifier_does_not_import_the_generator(self) -> None:
        source = (Path(__file__).with_name("verify_geometry.py")).read_text(encoding="utf-8")
        self.assertNotIn("from .geometry import", source)
        self.assertNotIn("from .contracts import", source)

    def test_entity_mesh_hash_tamper_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        invalid["entities"][0]["meshHash"] = "0" * 64
        with self.assertRaisesRegex(VerificationError, "manifest mesh hash differs"):
            _verify_entities(invalid, self.meshes, self.fixture)

    def test_dimension_fact_id_tamper_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        invalid["dimensionFacts"][0]["dimensionFactId"] = "00000000-0000-0000-0000-000000000000"
        with self.assertRaisesRegex(VerificationError, "cannot be reproduced"):
            _verify_dimensions(invalid)

    def test_count_parameter_cannot_be_disguised_as_millimetres(self) -> None:
        invalid = deepcopy(self.manifest)
        entity = next(item for item in invalid["entities"] if any(fact["valueType"] == "count" for fact in item["parameterFacts"]))
        fact = next(fact for fact in entity["parameterFacts"] if fact["valueType"] == "count")
        fact["valueType"] = "length"
        fact["unit"] = "mm"
        with self.assertRaisesRegex(VerificationError, "parameter value type differs"):
            _verify_entities(invalid, self.meshes, self.fixture)

    def test_l1_eligibility_tamper_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        invalid["entities"][0]["resolution"]["l1DemoEligibility"] = "eligible"
        with self.assertRaisesRegex(VerificationError, "incorrectly claims L1"):
            _verify_entities(invalid, self.meshes, self.fixture)

    def test_surface_patch_topology_tamper_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        invalid["interfaces"][0]["surfaceWitness"]["fromFaceIndices"] = [10**9]
        with self.assertRaisesRegex(VerificationError, "exceeds mesh topology"):
            _verify_interfaces(invalid, self.meshes, self.fixture)

    def test_valid_but_wrong_surface_patch_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        interface = next(item for item in invalid["interfaces"] if item["role"] == "foundation-bearing-ground")
        interface["surfaceWitness"]["fromFaceIndices"] = [0]
        interface["surfaceWitness"]["toFaceIndices"] = [0]
        with self.assertRaisesRegex(
            VerificationError,
            "surface witness differs|surface gap differs|patch descriptor differs",
        ):
            _verify_interfaces(invalid, self.meshes, self.fixture)

    def test_surface_patch_descriptor_tamper_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        invalid["interfaces"][0]["surfaceWitness"]["fromPatch"]["patchHash"] = "0" * 64
        with self.assertRaisesRegex(VerificationError, "source patch descriptor differs"):
            _verify_interfaces(invalid, self.meshes, self.fixture)

    def test_side_containment_cannot_replace_the_directed_ground_bearing_path(self) -> None:
        invalid = deepcopy(self.manifest)
        invalid["interfaces"] = [
            item for item in invalid["interfaces"] if item["role"] != "foundation-bearing-ground"
        ]
        with self.assertRaisesRegex(VerificationError, "role counts cannot be reconstructed"):
            _verify_interfaces(invalid, self.meshes, self.fixture)

    def test_role_count_preserving_interface_rewire_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        first = next(item for item in invalid["interfaces"] if item["role"] == "foundation-bearing-ground")
        second = next(
            item
            for item in invalid["interfaces"]
            if item["role"] == "foundation-bearing-ground" and item["interfaceId"] != first["interfaceId"]
        )
        first["toEntityKey"], second["toEntityKey"] = second["toEntityKey"], first["toEntityKey"]
        first["toEntityId"], second["toEntityId"] = second["toEntityId"], first["toEntityId"]
        with self.assertRaisesRegex(VerificationError, "instance bindings cannot be reconstructed"):
            _verify_interfaces(invalid, self.meshes, self.fixture)

    def test_door_panel_feature_tamper_is_rejected(self) -> None:
        invalid = deepcopy(self.manifest)
        panel = next(item for item in invalid["entities"] if item["key"] == "door-leaf:0:panel:0")
        panel["featureIds"] = [
            item for item in panel["featureIds"] if item["featureName"] != "panel-top-tongue"
        ]
        with self.assertRaisesRegex(VerificationError, "edge tongues are incomplete"):
            _verify_local_construction(invalid, self.meshes, self.fixture)

    def test_glb_topology_tamper_is_rejected(self) -> None:
        invalid_meshes = dict(self.meshes)
        entity_id = next(iter(invalid_meshes))
        changed = invalid_meshes[entity_id].copy()
        changed.faces[0] = changed.faces[0][::-1]
        invalid_meshes[entity_id] = changed
        with self.assertRaisesRegex(VerificationError, "topology differs"):
            _verify_glb(OUTPUT / "local-construction-sample.glb", invalid_meshes)

    def test_coplanar_tile_lap_is_rejected(self) -> None:
        changed_meshes = dict(self.meshes)
        record = next(
            item for item in self.manifest["entities"] if item["key"] == "pan-tile:north:0:1"
        )
        changed = changed_meshes[record["entityId"]].copy()
        changed.apply_translation([0.0, 0.0, -18.0])
        changed_meshes[record["entityId"]] = changed
        with self.assertRaisesRegex(VerificationError, "tile lap"):
            _verify_tile_laps(self.fixture, self.manifest, changed_meshes)

    def test_missing_roof_finish_is_rejected(self) -> None:
        changed_meshes = dict(self.meshes)
        ceramic_types = {"panTile", "coverTile", "ridgeTile"}
        for record in self.manifest["entities"]:
            if record["componentType"] not in ceramic_types:
                continue
            changed = changed_meshes[record["entityId"]].copy()
            changed.apply_translation([0.0, 0.0, -2000.0])
            changed_meshes[record["entityId"]] = changed
        with self.assertRaisesRegex(VerificationError, "roof finish exposes"):
            _verify_roof_coverage(self.fixture, self.manifest, changed_meshes)

    def test_declared_interfaces_have_no_unexpected_material_overlap(self) -> None:
        result = _verify_unexpected_overlap(self.manifest, self.meshes)
        self.assertEqual(result["checkedInterfaces"], 561)
        self.assertEqual(result["maximumEstimatedUnexpectedOverlapMm3"], 0.0)


if __name__ == "__main__":
    unittest.main()
