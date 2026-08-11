from __future__ import annotations

import ast
from copy import deepcopy
import gzip
from hashlib import sha256
import json
from pathlib import Path
import unittest
from uuid import uuid5

from workers.cad.t0b_v2.verify_drawing_ir import (
    DRAWING_PACKAGE_REVISION_NAMESPACE,
    DrawingIRVerificationError,
    build_report,
    default_paths,
    load_bundle,
    verify_bound_inputs,
    verify_contract,
    verify_hashes_record_and_determinism,
    verify_ir_semantics,
    verify_material_and_crop_execution,
)


ROOT = Path(__file__).resolve().parents[3]
CONTRACT_PATH, IR_PATH, RECORD_PATH, _REPORT_PATH = default_paths(ROOT)
VERIFIER_PATH = Path(__file__).with_name("verify_drawing_ir.py")


def _canonical_hash(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def _resign(contract: dict) -> None:
    payload = {key: value for key, value in contract.items() if key not in {"contractSignature", "contractRevisionId"}}
    contract["contractSignature"] = _canonical_hash(payload)
    contract["contractRevisionId"] = str(uuid5(DRAWING_PACKAGE_REVISION_NAMESPACE, contract["contractSignature"]))


def _rebind_ir_bytes(bundle) -> None:
    payload = deepcopy(bundle.ir)
    payload.pop("drawingPackageIrSha256", None)
    bundle.ir["drawingPackageIrSha256"] = _canonical_hash(payload)
    raw = (json.dumps(bundle.ir, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    bundle.ir_file_bytes = gzip.compress(raw, compresslevel=9, mtime=0)
    bundle.ir_file_sha256 = sha256(bundle.ir_file_bytes).hexdigest()
    bundle.record["output"]["sha256"] = bundle.ir_file_sha256
    bundle.record["output"]["drawingPackageIrSha256"] = bundle.ir["drawingPackageIrSha256"]
    bundle.record["output"]["statistics"] = bundle.ir["statistics"]


class DrawingPackageIRIndependentVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle = load_bundle(CONTRACT_PATH, IR_PATH, RECORD_PATH)

    def fresh(self):
        return deepcopy(self.bundle)

    def test_verifier_imports_no_contract_ir_or_generation_module(self) -> None:
        tree = ast.parse(VERIFIER_PATH.read_text(encoding="utf-8"))
        imports: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
        forbidden = {"workers.cad.t0b_v2.drawing_contract", "workers.cad.t0b_v2.drawing_ir", "workers.cad.t0b_v2.view_geometry", "workers.cad.t0b_v2.detail_oracle"}
        self.assertTrue(imports.isdisjoint(forbidden))
        self.assertFalse(any(name.startswith("workers.cad.t0b_v2.build_") for name in imports))

    def test_current_contract_bound_inputs_ir_and_determinism_recompute(self) -> None:
        self.assertEqual(verify_contract(self.bundle)["p0Mappings"], 12)
        self.assertEqual(verify_bound_inputs(self.bundle)["views"], 10)
        self.assertEqual(verify_ir_semantics(self.bundle)["provenanceSidecarRowCount"], 51492)
        self.assertTrue(verify_hashes_record_and_determinism(self.bundle)["doubleBuildByteIdentical"])

    def test_current_material_outcome_matches_report(self) -> None:
        report = build_report(self.bundle, VERIFIER_PATH)
        material_check = next(item for item in report["checks"] if item["id"] == "DIR-004")
        self.assertTrue(material_check["passed"])
        self.assertEqual(material_check["evidence"]["resolvedTargetHatches"], 315)
        self.assertEqual(material_check["evidence"]["ceramicRegions"], 124)
        self.assertEqual(material_check["evidence"]["sourceMaterialHatchNullPreserved"], 118)
        self.assertFalse(report["findings"]["P0"])

    def test_contract_signature_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.contract["contractSignature"] = "0" * 64
        with self.assertRaisesRegex(DrawingIRVerificationError, "signature"):
            verify_contract(bundle)

    def test_contract_revision_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.contract["contractRevisionId"] = "00000000-0000-0000-0000-000000000000"
        with self.assertRaisesRegex(DrawingIRVerificationError, "revision"):
            verify_contract(bundle)

    def test_contract_p0_mapping_to_missing_field_fails(self) -> None:
        bundle = self.fresh()
        bundle.contract["p0Requirements"][0]["contractFields"] = ["missing.field"]
        _resign(bundle.contract)
        with self.assertRaisesRegex(DrawingIRVerificationError, "missing contract field"):
            verify_contract(bundle)

    def test_manifest_hash_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.manifest_file_sha256 = "0" * 64
        with self.assertRaisesRegex(DrawingIRVerificationError, "manifest file hash"):
            verify_bound_inputs(bundle)

    def test_view_compressed_hash_tamper_fails(self) -> None:
        bundle = self.fresh()
        view_id = bundle.contract["viewGeometryBindings"][0]["viewId"]
        bundle.view_file_sha256[view_id] = "0" * 64
        with self.assertRaisesRegex(DrawingIRVerificationError, "compressed file hash"):
            verify_bound_inputs(bundle)

    def test_view_internal_hash_tamper_fails(self) -> None:
        bundle = self.fresh()
        view = bundle.views["roofPlan"]
        view["projectionLines"][0]["pointsMm"][0][0] += 0.01
        with self.assertRaisesRegex(DrawingIRVerificationError, "internal ViewGeometry hash"):
            verify_bound_inputs(bundle)

    def test_staging_transform_tamper_fails_even_after_resign(self) -> None:
        bundle = self.fresh()
        bundle.contract["viewStages"][0]["viewToModelSpace"][0][2] += 10
        _resign(bundle.contract)
        with self.assertRaisesRegex(DrawingIRVerificationError, "staging inverse|staged bounds"):
            verify_contract(bundle)

    def test_structural_line_coordinate_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir["modelSpace"]["viewStages"][0]["structuralLines"][0]["modelSpacePointsMm"][0][0] += 0.01
        with self.assertRaisesRegex(DrawingIRVerificationError, "staged line"):
            verify_ir_semantics(bundle)

    def test_line_class_and_layer_tamper_fails(self) -> None:
        bundle = self.fresh()
        line = bundle.ir["modelSpace"]["viewStages"][0]["structuralLines"][0]
        line["lineClass"] = "feature"
        line["layer"] = "GJ-CUT"
        with self.assertRaisesRegex(DrawingIRVerificationError, "staged line"):
            verify_ir_semantics(bundle)

    def test_crop_classification_tamper_fails(self) -> None:
        bundle = self.fresh()
        stage = next(item for item in bundle.ir["modelSpace"]["viewStages"] if item["cropLimitLines"])
        stage["cropLimitLines"][0]["objectClass"] = "structural"
        with self.assertRaisesRegex(DrawingIRVerificationError, "staged line"):
            verify_ir_semantics(bundle)

    def test_material_boundary_tamper_fails(self) -> None:
        bundle = self.fresh()
        stage = next(item for item in bundle.ir["modelSpace"]["viewStages"] if any("boundaryCadObjectIds" in region for region in item["materialRegions"]))
        region = next(item for item in stage["materialRegions"] if "boundaryCadObjectIds" in item)
        region["boundaryCadObjectIds"][0] = "00000000-0000-0000-0000-000000000000"
        with self.assertRaisesRegex(DrawingIRVerificationError, "material records"):
            verify_ir_semantics(bundle)

    def test_material_pattern_gate_detects_new_unowned_pattern(self) -> None:
        bundle = self.fresh()
        stage = next(item for item in bundle.ir["modelSpace"]["viewStages"] if item["materialRegions"])
        stage["materialRegions"][0]["targetHatchPatternKey"] = "external-pattern"
        with self.assertRaisesRegex(DrawingIRVerificationError, "material regions"):
            verify_material_and_crop_execution(bundle)

    def test_unknown_material_code_is_rejected(self) -> None:
        bundle = self.fresh()
        stage = next(item for item in bundle.ir["modelSpace"]["viewStages"] if item["materialRegions"])
        stage["materialRegions"][0]["materialCode"] = "unknown-external-material"
        with self.assertRaisesRegex(DrawingIRVerificationError, "material regions"):
            verify_material_and_crop_execution(bundle)

    def test_external_ceramic_pattern_is_rejected_after_resign(self) -> None:
        bundle = self.fresh()
        bundle.contract["materialPolicy"]["patterns"]["ceramic"]["source"] = "external-dwg"
        bundle.contract["materialPolicy"]["patterns"]["ceramic"]["externalSourceDerived"] = True
        _resign(bundle.contract)
        with self.assertRaisesRegex(DrawingIRVerificationError, "ceramic hatch"):
            verify_contract(bundle)

    def test_source_material_hatch_null_tamper_fails(self) -> None:
        bundle = self.fresh()
        region = next(
            region
            for stage in bundle.ir["modelSpace"]["viewStages"]
            for region in stage["materialRegions"]
            if region["materialCode"] == "ceramic-demo" and region["sourceMaterialHatch"] is None
        )
        region["sourceMaterialHatch"] = "ceramic"
        with self.assertRaisesRegex(DrawingIRVerificationError, "material records"):
            verify_ir_semantics(bundle)

    def test_sidecar_deletion_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir["provenanceSidecarRows"].pop()
        with self.assertRaisesRegex(DrawingIRVerificationError, "sidecar"):
            verify_ir_semantics(bundle)

    def test_sidecar_provenance_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir["provenanceSidecarRows"][0]["provenance"]["viewId"] = "tampered-view"
        with self.assertRaisesRegex(DrawingIRVerificationError, "sidecar"):
            verify_ir_semantics(bundle)

    def test_annotation_requirement_id_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir["annotations"][0]["requirementId"] = "DR-TAMPER"
        with self.assertRaisesRegex(DrawingIRVerificationError, "annotations"):
            verify_ir_semantics(bundle)

    def test_annotation_source_refs_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir["annotations"][0]["sourceRefs"] = []
        with self.assertRaisesRegex(DrawingIRVerificationError, "annotations"):
            verify_ir_semantics(bundle)

    def test_layout_and_viewport_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir["paperSpace"]["layouts"][0]["viewports"][0]["locked"] = False
        with self.assertRaisesRegex(DrawingIRVerificationError, "layouts"):
            verify_ir_semantics(bundle)

    def test_external_absolute_path_fails_even_after_resign(self) -> None:
        bundle = self.fresh()
        bundle.contract["viewGeometryBindings"][0]["relativePath"] = "D:/Downloads/forbidden.json.gz"
        _resign(bundle.contract)
        with self.assertRaisesRegex(DrawingIRVerificationError, "escaped|external CAD"):
            verify_contract(bundle)

    def test_external_dwg_path_fails_even_after_resign(self) -> None:
        bundle = self.fresh()
        bundle.contract["viewGeometryBindings"][0]["relativePath"] = "t0b-v2-outputs/external-reference.dwg"
        _resign(bundle.contract)
        with self.assertRaisesRegex(DrawingIRVerificationError, "external CAD"):
            verify_contract(bundle)

    def test_external_hash_field_injection_fails_even_after_resign(self) -> None:
        bundle = self.fresh()
        bundle.contract["externalReferenceHash"] = "a" * 64
        _resign(bundle.contract)
        with self.assertRaisesRegex(DrawingIRVerificationError, "root schema"):
            verify_contract(bundle)

    def test_qualification_elevation_fails_after_attacker_rehash(self) -> None:
        bundle = self.fresh()
        bundle.ir["L1"] = True
        bundle.ir["status"] = "qualified"
        _rebind_ir_bytes(bundle)
        with self.assertRaisesRegex(DrawingIRVerificationError, "qualification"):
            verify_ir_semantics(bundle)

    def test_ir_gzip_byte_tamper_fails(self) -> None:
        bundle = self.fresh()
        bundle.ir_file_bytes = bundle.ir_file_bytes[:-1] + bytes([bundle.ir_file_bytes[-1] ^ 1])
        bundle.ir_file_sha256 = sha256(bundle.ir_file_bytes).hexdigest()
        bundle.record["output"]["sha256"] = bundle.ir_file_sha256
        with self.assertRaisesRegex(DrawingIRVerificationError, "double serialization"):
            verify_hashes_record_and_determinism(bundle)


if __name__ == "__main__":
    unittest.main()
