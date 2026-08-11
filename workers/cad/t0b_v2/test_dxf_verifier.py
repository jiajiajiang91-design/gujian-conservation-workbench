from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import unittest

from workers.cad.t0b_v2.verify_dxf import (
    DXFVerificationError,
    build_report,
    default_paths,
    load_bundle,
    parse_autocad_audit,
    verify_annotations_and_details,
    verify_hashes_and_determinism,
    verify_inputs_header_status,
    verify_layouts_and_viewports,
    verify_material_hatches,
    verify_provenance_sidecar,
    verify_security_font_qualification,
    verify_structural_geometry,
)


ROOT = Path(__file__).resolve().parents[3]
AUDIT_SUMMARY = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "t0b-v2-outputs" / "native-dxf" / "T0B-autocad-audit-summary.json"


@contextmanager
def changed(mapping: dict, key: str, value):
    original = mapping[key]
    mapping[key] = value
    try:
        yield
    finally:
        mapping[key] = original


@contextmanager
def removed(mapping: dict, key: str):
    original = mapping.pop(key)
    try:
        yield original
    finally:
        mapping[key] = original


class IndependentDXFVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.paths = default_paths(ROOT)
        cls.bundle = load_bundle(cls.paths)
        cls.bundle.double_build = {"status": "passed", "allByteIdentical": True, "scope": "unit-test-fixture"}

    def assert_rejected(self, function) -> None:
        with self.assertRaises(DXFVerificationError):
            function(self.bundle)

    def _row(self, object_class: str) -> dict:
        return next(row for row in self.bundle.sidecar if row["objectClass"] == object_class)

    def _entity_for_row(self, row: dict) -> dict:
        return self.bundle.state["entities"][str(row["handle"]).upper()]

    def test_baseline_and_autocad_audit_pass(self) -> None:
        audit = parse_autocad_audit(AUDIT_SUMMARY, self.bundle.hashes["dxf"])
        report = build_report(self.bundle, ROOT / "workers" / "cad" / "t0b_v2" / "verify_dxf.py", audit)
        self.assertEqual(report["summary"]["failed"], 0)
        self.assertEqual(report["submissionDecision"], "accept-native-dxf-task-only")
        self.assertFalse(report["L1"])

    def test_rejects_contract_hash_and_unit_tampering(self) -> None:
        with changed(self.bundle.contract, "contractSignature", "0" * 64):
            self.assert_rejected(verify_inputs_header_status)
        with changed(self.bundle.state, "insunits", 0):
            self.assert_rejected(verify_inputs_header_status)

    def test_rejects_structural_coordinate_and_xdata_tampering(self) -> None:
        row = self._row("structural")
        entity = self._entity_for_row(row)
        original_points = entity["data"]["points"]
        altered = [list(point) for point in original_points]
        altered[0][0] += 2.0
        with changed(entity["data"], "points", altered):
            self.assert_rejected(verify_structural_geometry)
        with changed(entity, "xdata", None):
            self.assert_rejected(verify_structural_geometry)

    def test_rejects_hatch_boundary_and_pattern_tampering(self) -> None:
        row = self._row("material-region")
        entity = self._entity_for_row(row)
        rings = entity["data"]["rings"]
        altered = [{**ring, "points": [list(point) for point in ring["points"]]} for ring in rings]
        altered[0]["points"][0][0] += 2.0
        with changed(entity["data"], "rings", altered):
            self.assert_rejected(verify_material_hatches)
        with changed(entity["data"], "patternName", "EXTERNAL_UNKNOWN_PATTERN"):
            self.assert_rejected(verify_material_hatches)

    def test_rejects_deleted_and_exploded_dimension(self) -> None:
        row = next(row for row in self.bundle.sidecar if row["objectClass"] == "annotation" and row["dxftype"] == "DIMENSION")
        handle = str(row["handle"]).upper()
        with removed(self.bundle.state["entities"], handle):
            self.assert_rejected(verify_annotations_and_details)
        entity = self.bundle.state["entities"][handle]
        with changed(entity, "dxftype", "LINE"):
            self.assert_rejected(verify_provenance_sidecar)

    def test_rejects_missing_annotation_and_override(self) -> None:
        row = next(row for row in self.bundle.sidecar if row["objectClass"] == "annotation")
        index = self.bundle.sidecar.index(row)
        self.bundle.sidecar.pop(index)
        try:
            self.assert_rejected(verify_annotations_and_details)
        finally:
            self.bundle.sidecar.insert(index, row)
        annotation = self.bundle.ir["annotations"][0]
        payload = annotation["semanticPayload"]
        with changed(payload, "overrideAllowed", True):
            self.assert_rejected(verify_annotations_and_details)

    def test_rejects_layout_viewport_scale_and_lock_tampering(self) -> None:
        with changed(self.bundle.state, "layoutNames", ["Model", "T0B-01", "RENAMED"]):
            self.assert_rejected(verify_layouts_and_viewports)
        viewport = next(
            entity
            for entity in self.bundle.state["entities"].values()
            if entity["dxftype"] == "VIEWPORT" and entity["data"].get("id", 0) > 1
        )
        with changed(viewport["data"], "locked", False):
            self.assert_rejected(verify_layouts_and_viewports)
        with changed(viewport["data"], "viewHeight", viewport["data"]["viewHeight"] * 2):
            self.assert_rejected(verify_layouts_and_viewports)

    def test_rejects_sidecar_handle_delete_and_duplicate(self) -> None:
        row = self.bundle.sidecar[0]
        with changed(row, "handle", "DEADBEEF"):
            self.assert_rejected(verify_provenance_sidecar)
        removed_row = self.bundle.sidecar.pop()
        try:
            self.assert_rejected(verify_provenance_sidecar)
        finally:
            self.bundle.sidecar.append(removed_row)
        duplicate = dict(self.bundle.sidecar[0])
        self.bundle.sidecar.append(duplicate)
        try:
            self.assert_rejected(verify_provenance_sidecar)
        finally:
            self.bundle.sidecar.pop()

    def test_rejects_external_dependency_and_font_path(self) -> None:
        with changed(self.bundle.state, "externalMarkers", [".dwg"]):
            self.assert_rejected(verify_security_font_qualification)
        styles = self.bundle.state["styles"]
        original = styles["GJ-NOTO-SANS-SC"]
        styles["GJ-NOTO-SANS-SC"] = r"C:\external\unlicensed.ttf"
        try:
            self.assert_rejected(verify_security_font_qualification)
        finally:
            styles["GJ-NOTO-SANS-SC"] = original

    def test_rejects_false_qualification(self) -> None:
        with changed(self.bundle.record, "L1", True):
            self.assert_rejected(verify_inputs_header_status)
        with changed(self.bundle.ir["qualificationBoundary"], "L1", True):
            self.assert_rejected(verify_inputs_header_status)

    def test_rejects_output_hash_and_nondeterminism(self) -> None:
        output = self.bundle.record["outputs"]["dxf"]
        with changed(output, "sha256", "0" * 64):
            self.assert_rejected(verify_hashes_and_determinism)
        with changed(self.bundle.double_build, "allByteIdentical", False):
            self.assert_rejected(verify_hashes_and_determinism)

    def test_rejects_failed_autocad_audit_evidence(self) -> None:
        payload = json.loads(AUDIT_SUMMARY.read_text(encoding="utf-8"))
        payload["status"] = "failed"
        payload["result"]["errorsFound"] = 1
        payload["result"]["errorsFixed"] = 1
        payload["result"]["objectsDeleted"] = 1
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "failed-audit-summary.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            audit = parse_autocad_audit(path, self.bundle.hashes["dxf"])
        self.assertFalse(audit["passed"])
        self.assertEqual(audit["result"]["errorsFound"], 1)
        self.assertEqual(audit["result"]["objectsDeleted"], 1)

    def test_rejects_audit_summary_hash_and_path_tampering(self) -> None:
        payload = json.loads(AUDIT_SUMMARY.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tampered-audit-summary.json"
            payload["canonicalDxfSha256"] = "0" * 64
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(DXFVerificationError):
                parse_autocad_audit(path, self.bundle.hashes["dxf"])
            payload["canonicalDxfSha256"] = self.bundle.hashes["dxf"]
            payload["sourcePath"] = r"C:\Users\example\T0B.dxf"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(DXFVerificationError):
                parse_autocad_audit(path, self.bundle.hashes["dxf"])


if __name__ == "__main__":
    unittest.main()
