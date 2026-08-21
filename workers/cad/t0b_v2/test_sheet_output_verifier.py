from __future__ import annotations

import ast
from copy import deepcopy
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from lxml import etree
from PIL import Image
from pypdf import PdfReader, PdfWriter

import verify_sheet_outputs as verifier


ROOT = Path(__file__).resolve().parents[3]


class SheetOutputVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = verifier.load_bundle(ROOT)

    def test_verifier_does_not_import_generation_or_oracle_modules(self):
        source = Path(verifier.__file__).read_text(encoding="utf-8")
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertFalse(
            imported.intersection(
                {"generate_sheet_outputs", "drawing_contract", "drawing_ir", "generate_dxf", "font_assets", "view_geometry", "detail_oracle"}
            )
        )

    def test_current_machine_baseline_passes_all_six_checks(self):
        for _, _, check in verifier.CHECKS:
            check(self.bundle)

    def test_current_package_is_rejected_by_professional_p0(self):
        report = verifier.build_report(self.bundle, Path(verifier.__file__))
        self.assertEqual(report["summary"]["failedTechnicalChecks"], 0)
        ids = {item["id"] for item in report["findings"]["P0"]}
        self.assertEqual(
            ids,
            {
                "P0-RAW-VIEW-ID-IN-INDEX-SYMBOL",
                "P0-ANNOTATION-COLLISION",
                "P0-FALSE-ISSUE-DATE",
                "P0-CONDITION-PROTECTION-NOTE-MISSING",
                "P0-BRACKET-DETAIL-SIMPLIFIED",
                "P0-SECOND-CAD-ROUNDTRIP-UNSUPPORTED",
            },
        )

    def test_rejects_font_source_commit_tamper(self):
        attacked = deepcopy(self.bundle)
        attacked.font_manifest["source"]["commit"] = "0" * 40
        with self.assertRaises(verifier.SheetOutputVerificationError):
            verifier.verify_font_closure(attacked)

    def test_rejects_font_coverage_declaration_tamper(self):
        attacked = deepcopy(self.bundle)
        attacked.font_manifest["glyphCoverage"]["requiredCodepointCount"] += 1
        with self.assertRaises(verifier.SheetOutputVerificationError):
            verifier.verify_font_closure(attacked)

    def test_rejects_contract_ir_record_tampering(self):
        for attack in ("contract-signature", "ir-hash", "output-hash", "qualification", "blocker"):
            with self.subTest(attack=attack):
                attacked = deepcopy(self.bundle)
                if attack == "contract-signature":
                    attacked.contract["contractSignature"] = "0" * 64
                elif attack == "ir-hash":
                    attacked.ir["drawingPackageIrSha256"] = "0" * 64
                elif attack == "output-hash":
                    attacked.build_record["outputs"]["svg"][0]["sha256"] = "0" * 64
                elif attack == "qualification":
                    attacked.build_record["L1"] = True
                elif attack == "blocker":
                    attacked.build_record["qualification"]["requiredBlockers"] = []
                with self.assertRaises(verifier.SheetOutputVerificationError):
                    verifier.verify_contract_ir_output_binding(attacked)

    def test_rejects_svg_structural_coordinate_tamper(self):
        original = verifier._svg_document

        def attacked_document(path):
            tree = original(path)
            if path.name == "T0B-01.svg":
                line = tree.xpath("(//s:polyline[@data-object-class='structural'])[1]", namespaces=verifier.SVG_NS)[0]
                points = line.get("points").split()
                x, y = [float(value) for value in points[0].split(",")]
                points[0] = f"{x + 1.0},{y}"
                line.set("points", " ".join(points))
            return tree

        with patch.object(verifier, "_svg_document", attacked_document):
            with self.assertRaises(verifier.SheetOutputVerificationError):
                verifier.verify_svg_geometry_text(self.bundle)

    def test_rejects_svg_remote_dependency(self):
        original = verifier._svg_document

        def attacked_document(path):
            tree = original(path)
            if path.name == "T0B-01.svg":
                image = etree.SubElement(tree.getroot(), "{http://www.w3.org/2000/svg}image")
                image.set("href", "https://invalid.example/reference.png")
            return tree

        with patch.object(verifier, "_svg_document", attacked_document):
            with self.assertRaises(verifier.SheetOutputVerificationError):
                verifier.verify_svg_geometry_text(self.bundle)

    def _artifact_copy(self, temporary_root: Path) -> Path:
        out = temporary_root / "artifacts"
        out.mkdir()
        for source in self.bundle.artifact_dir.iterdir():
            if source.is_file() and source.name.startswith("T0B"):
                target = out / source.name
                try:
                    target.hardlink_to(source)
                except OSError:
                    shutil.copy2(source, target)
        return out

    def test_rejects_pdf_without_tounicode(self):
        with tempfile.TemporaryDirectory() as raw:
            attacked = deepcopy(self.bundle)
            attacked.artifact_dir = self._artifact_copy(Path(raw))
            target = attacked.artifact_dir / "T0B.pdf"
            source = self.bundle.artifact_dir / "T0B.pdf"
            target.unlink()
            shutil.copy2(source, target)
            reader = PdfReader(str(target))
            writer = PdfWriter(clone_from=reader)
            for page in writer.pages:
                for reference in page["/Resources"]["/Font"].values():
                    reference.get_object().pop("/ToUnicode", None)
            with target.open("wb") as stream:
                writer.write(stream)
            with self.assertRaises(verifier.SheetOutputVerificationError):
                verifier.verify_pdf_geometry_text(attacked)

    def test_rejects_png_size_and_dpi_tamper(self):
        with tempfile.TemporaryDirectory() as raw:
            attacked = deepcopy(self.bundle)
            attacked.artifact_dir = self._artifact_copy(Path(raw))
            target = attacked.artifact_dir / "T0B-01-300dpi.png"
            target.unlink()
            Image.new("RGB", (100, 100), "white").save(target, dpi=(72, 72))
            with self.assertRaises(verifier.SheetOutputVerificationError):
                verifier.verify_png_geometry(attacked)


if __name__ == "__main__":
    unittest.main()
