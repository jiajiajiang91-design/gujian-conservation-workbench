from __future__ import annotations

import json
import gzip
import hashlib
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from workers.cad.project_geometry.kernel import build_geometry_package
from workers.cad.project_geometry.test_project_geometry import spec_a

from .build_package import build_package
from .test_project_drawings import matrix
from .verify_package import _autocad_summary_matches, _qcad_summary_matches, verify


ROOT = Path(__file__).resolve().parents[3]
FONT = ROOT / "workers" / "cad" / "t0b_v2" / "assets" / "fonts" / "noto-sans-sc" / "GujianSansSC-Regular.ttf"


class DrawingPackageVerifierTests(unittest.TestCase):
    @staticmethod
    def _build_package(target: Path) -> tuple[Path, Path]:
        geometry = target / "geometry"
        drawings = target / "drawings"
        source = spec_a()
        manifest = build_geometry_package(source, geometry)
        requirement = matrix(source, manifest, "one-sheet")
        matrix_path = target / "matrix.json"
        matrix_path.write_text(json.dumps(requirement, ensure_ascii=False), encoding="utf-8")
        build_package(requirement, geometry, FONT, drawings)
        return matrix_path, geometry

    def test_current_package_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            matrix_path, geometry = self._build_package(target)
            report = verify(matrix_path, geometry, target / "drawings", FONT)
            self.assertEqual(report["failedCheckCount"], 0, report["checks"])

    def test_current_autocad_summary_schema_binds_the_canonical_dxf_hash(self) -> None:
        dxf_hash = "a" * 64
        summary = {
            "schemaVersion": "milestone-two-autocad-audit-summary-1",
            "status": "passed",
            "tool": {"product": "AutoCAD Core Console 2024"},
            "commandCategories": ["OPEN", "AUDIT"],
            "canonicalDxfSha256": dxf_hash,
            "auditCopy": {
                "preAuditSha256": dxf_hash,
                "postAuditSha256": dxf_hash,
                "byteIdenticalToCanonicalBefore": True,
                "byteIdenticalToCanonicalAfter": True,
            },
            "font": {"substitutionDetected": False},
            "result": {"exitCode": 0, "errorsFound": 0, "errorsFixed": 0, "objectsDeleted": 0, "canonicalDxfModified": False},
            "qualification": "generated-not-qualified",
            "l1Eligible": False,
            "formalEligibility": False,
        }
        self.assertTrue(_autocad_summary_matches(summary, dxf_hash))
        summary["canonicalDxfSha256"] = "b" * 64
        self.assertFalse(_autocad_summary_matches(summary, dxf_hash))

    def test_current_qcad_summary_schema_binds_source_and_print_layouts(self) -> None:
        dxf_hash = "a" * 64
        summary = {
            "schemaVersion": "milestone-two-qcad-compatibility-1",
            "status": "passed-open-view-print-only",
            "tool": {"product": "QCAD Professional Trial"},
            "input": {"canonicalDxfSha256": dxf_hash, "temporaryCopySha256AfterCheck": dxf_hash},
            "openAndView": {"exitCode": 0, "importSucceeded": True},
            "print": {"exitCode": 0, "layouts": ["P-01", "P-02"], "pageCount": 2},
            "saveBackPerformed": False,
            "canonicalDxfModified": False,
            "qualification": "generated-not-qualified",
            "l1Eligible": False,
            "formalEligibility": False,
        }
        self.assertTrue(_qcad_summary_matches(summary, dxf_hash, ["P-01", "P-02"]))
        summary["input"]["temporaryCopySha256AfterCheck"] = "b" * 64
        self.assertFalse(_qcad_summary_matches(summary, dxf_hash, ["P-01", "P-02"]))

    def test_png_dimension_tamper_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            matrix_path, geometry = self._build_package(root)
            target = root / "drawings"
            with Image.open(target / "P-01.png") as source:
                source.resize((100, 100)).save(target / "P-01.png", dpi=(72, 72))
            record = json.loads((target / "drawing-build-record.json").read_text(encoding="utf-8"))
            for asset in record["assets"]:
                if asset["fileName"] == "P-01.png":
                    asset["sha256"] = hashlib.sha256((target / "P-01.png").read_bytes()).hexdigest()
                    asset["byteLength"] = (target / "P-01.png").stat().st_size
            (target / "drawing-build-record.json").write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
            report = verify(matrix_path, geometry, target, FONT)
            self.assertTrue(any(item["id"] == "png-closure" and not item["passed"] for item in report["checks"]))

    def test_source_line_tamper_is_detected_after_rehash(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            matrix_path, geometry = self._build_package(root)
            target = root / "drawings"
            view_path = next((target / "view-geometry").glob("*.json.gz"))
            with gzip.open(view_path, "rt", encoding="utf-8") as stream:
                view = json.load(stream)
            view["lines"][0]["pointsMm"][0][0] += 1000
            payload = dict(view)
            payload.pop("viewGeometrySha256", None)
            canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            view["viewGeometrySha256"] = hashlib.sha256(canonical).hexdigest()
            with view_path.open("wb") as raw:
                with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as stream:
                    stream.write(json.dumps(view, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n")
            ir_path = target / "drawing-ir.json"
            ir = json.loads(ir_path.read_text(encoding="utf-8"))
            ir["views"] = [view if item["viewId"] == view["viewId"] else item for item in ir["views"]]
            ir_payload = dict(ir)
            ir_payload.pop("drawingIrSha256", None)
            ir["drawingIrSha256"] = hashlib.sha256(json.dumps(ir_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
            ir_path.write_text(json.dumps(ir, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
            record_path = target / "drawing-build-record.json"
            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["drawingIrSha256"] = ir["drawingIrSha256"]
            for asset in record["assets"]:
                path = target / asset["fileName"]
                if asset["fileName"] in {"drawing-ir.json", f"view-geometry/{view_path.name}"}:
                    asset["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                    asset["byteLength"] = path.stat().st_size
            record_path.write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
            report = verify(matrix_path, geometry, target, FONT)
            self.assertTrue(any(item["id"] == "source-geometry-recompute" and not item["passed"] for item in report["checks"]))


if __name__ == "__main__":
    unittest.main()
