from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from uuid import uuid5


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = ROOT / "验证材料" / "06_T0_CAD可行性验证"
FIXTURE = BASE / "t0b-v2-resolved-local-assembly.json"
MANIFEST = BASE / "t0b-v2-outputs" / "geometry-manifest.json"
SOURCE_MESHES = BASE / "t0b-v2-outputs" / "source-meshes.ndjson.gz"
sys.path.insert(0, str(HERE))

from verify_view_contract import VIEW_CONTRACT_REVISION_NAMESPACE, _view_contract_signature, verify_view_contract


class T0BV2ViewContractVerifierTests(unittest.TestCase):
    def test_frozen_view_oracles_recompute_from_source_meshes(self) -> None:
        report = verify_view_contract(FIXTURE, MANIFEST, SOURCE_MESHES)
        self.assertEqual(report["status"], "passed-contract-only")
        self.assertTrue(all(item["passed"] for item in report["checks"]))

    def test_changed_section_oracle_fails(self) -> None:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        invalid = deepcopy(fixture)
        invalid["knownAnswers"]["viewOracle"]["views"]["transverseSection"]["cutSegmentSha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(invalid, ensure_ascii=False), encoding="utf-8")
            report = verify_view_contract(path, MANIFEST, SOURCE_MESHES)
        self.assertEqual(report["status"], "failed")
        failed = {item["name"] for item in report["checks"] if not item["passed"]}
        self.assertIn("transverseSection cutSegmentSha256", failed)

    def test_section_plane_on_mesh_boundary_fails_stability_probe(self) -> None:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        invalid = deepcopy(fixture)
        view = next(item for item in invalid["views"] if item["id"] == "transverseSection")
        view["viewFrame"]["origin"] = [-1760, 0, 0]
        view["viewFrame"]["modelToView"][2][3] = 1760
        view["section"]["planeOrigin"] = [-1760, 0, 0]
        signature = _view_contract_signature(invalid)
        invalid["viewContractSignature"] = signature
        invalid["viewContractRevisionId"] = str(uuid5(VIEW_CONTRACT_REVISION_NAMESPACE, signature))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(invalid, ensure_ascii=False), encoding="utf-8")
            report = verify_view_contract(path, MANIFEST, SOURCE_MESHES)
        failed = {item["name"] for item in report["checks"] if not item["passed"]}
        self.assertTrue(
            {"transverseSection negative section stability", "transverseSection positive section stability"} & failed
        )

    def test_nonexistent_detail_anchor_fails_independent_binding(self) -> None:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        invalid = deepcopy(fixture)
        view = next(item for item in invalid["views"] if item["id"] == "eaveDetail")
        view["detail"]["anchorEntityId"] = "00000000-0000-0000-0000-000000000001"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(invalid, ensure_ascii=False), encoding="utf-8")
            report = verify_view_contract(path, MANIFEST, SOURCE_MESHES)
        failed = {item["name"] for item in report["checks"] if not item["passed"]}
        self.assertIn("eaveDetail anchor exists", failed)


if __name__ == "__main__":
    unittest.main()
