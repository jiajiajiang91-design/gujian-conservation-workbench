from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import gzip
import inspect
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from xml.etree import ElementTree

from PIL import Image
from pypdf import PdfReader

import workers.cad.t0b_v2.generate_sheet_outputs as sheet_module
from workers.cad.t0b_v2.generate_sheet_outputs import BUILD_RECORD_NAME, DrawingSheetGenerator, SheetOutputError, build_sheet_outputs


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CONTRACT_PATH = next(ROOT.rglob("t0b-v2-drawing-package-contract.json"))
BASE = CONTRACT_PATH.parent
IR_PATH = BASE / "t0b-v2-outputs" / "drawing-package-ir" / "drawing-package.ir.json.gz"
FONT_CONFIG_PATH = HERE / "logical_font_config.json"
OUTPUT_DIR = BASE / "t0b-v2-outputs" / "drawing-package-artifacts"
RECORD_PATH = OUTPUT_DIR / BUILD_RECORD_NAME
SVG_PATHS = [OUTPUT_DIR / "T0B-01.svg", OUTPUT_DIR / "T0B-02.svg"]
PNG_PATHS = [OUTPUT_DIR / "T0B-01-300dpi.png", OUTPUT_DIR / "T0B-02-300dpi.png"]
PDF_PATH = OUTPUT_DIR / "T0B.pdf"


def _load_ir() -> dict:
    with gzip.open(IR_PATH, "rt", encoding="utf-8") as stream:
        return json.load(stream)


class T0BV2SheetOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        cls.ir = _load_ir()
        cls.font_config = json.loads(FONT_CONFIG_PATH.read_text(encoding="utf-8"))
        cls.record = json.loads(RECORD_PATH.read_text(encoding="utf-8"))

    def test_build_record_binds_ir_font_outputs_and_never_grants_qualification(self) -> None:
        self.assertEqual(self.record["status"], "generated-not-qualified")
        self.assertIs(self.record["L1"], False)
        self.assertEqual(self.record["inputs"]["drawingPackageContract"]["signature"], self.contract["contractSignature"])
        self.assertEqual(self.record["inputs"]["drawingPackageIr"]["drawingPackageIrSha256"], self.ir["drawingPackageIrSha256"])
        self.assertEqual(self.record["inputs"]["font"]["family"], "Gujian Sans SC")
        self.assertEqual(self.record["inputs"]["font"]["instanceWeight"], 400)
        self.assertEqual(self.record["fontClosure"], {"embeddedInSvg": True, "embeddedInPdf": True, "usedByPng": True, "missingGlyphs": 0, "fontSubstitutions": 0, "questionMarkPlaceholders": 0})
        blockers = set(self.record["qualification"]["requiredBlockers"])
        self.assertIn("BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", blockers)
        self.assertIn("QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED", blockers)
        self.assertIn("PROFESSIONAL_REVIEW_PENDING", blockers)
        self.assertFalse(self.record["qualification"]["generatorMaySetEligible"])
        for category in ("svg", "reviewPng"):
            for output in self.record["outputs"][category]:
                self.assertEqual(output["sha256"], sha256((OUTPUT_DIR / output["name"]).read_bytes()).hexdigest())
        self.assertEqual(self.record["outputs"]["pdf"]["sha256"], sha256(PDF_PATH.read_bytes()).hexdigest())

    def test_two_a1_svg_files_are_vector_searchable_and_close_all_ir_objects(self) -> None:
        namespace = "{http://www.w3.org/2000/svg}"
        structural_count = 0
        material_count = 0
        requirement_ids: set[str] = set()
        view_ids: set[str] = set()
        for path in SVG_PATHS:
            root = ElementTree.parse(path).getroot()
            self.assertEqual(root.attrib["width"], "841mm")
            self.assertEqual(root.attrib["height"], "594mm")
            self.assertEqual(root.attrib["viewBox"], "0 0 841 594")
            self.assertIn("data:font/ttf;base64,", path.read_text(encoding="utf-8"))
            self.assertFalse(root.findall(f".//{namespace}image"))
            self.assertEqual(len(root.findall(f".//{namespace}rect[@data-paper-frame='true']")), 1)
            for element in root.iter():
                if element.attrib.get("data-object-class") == "structural":
                    structural_count += 1
                if element.attrib.get("data-object-class") == "material-region":
                    material_count += 1
                if element.attrib.get("data-requirement-id"):
                    requirement_ids.add(element.attrib["data-requirement-id"])
                if element.attrib.get("data-view-id"):
                    view_ids.add(element.attrib["data-view-id"])
            text = "".join(element.text or "" for element in root.iter(f"{namespace}text"))
            self.assertNotIn("?", text)
            self.assertNotIn("\ufffd", text)
        self.assertEqual(structural_count, self.ir["statistics"]["structuralLineCount"])
        self.assertEqual(material_count, self.ir["statistics"]["materialRegionCount"])
        self.assertEqual(view_ids, {stage["viewId"] for stage in self.ir["modelSpace"]["viewStages"]})
        self.assertEqual(requirement_ids, {annotation["requirementId"] for annotation in self.ir["annotations"]})

    def test_two_page_pdf_is_a1_vector_searchable_and_embeds_only_bound_font(self) -> None:
        reader = PdfReader(str(PDF_PATH))
        self.assertEqual(len(reader.pages), 2)
        extracted: list[str] = []
        for page in reader.pages:
            self.assertAlmostEqual(float(page.mediabox.width) * 25.4 / 72, 841.0, places=3)
            self.assertAlmostEqual(float(page.mediabox.height) * 25.4 / 72, 594.0, places=3)
            resources = page["/Resources"]
            self.assertFalse(resources.get("/XObject"), "PDF must not use raster or external XObjects")
            fonts = resources["/Font"]
            self.assertEqual(len(fonts), 1)
            for reference in fonts.values():
                font = reference.get_object()
                descriptor = font["/FontDescriptor"].get_object()
                self.assertIn("GujianSansSC-Regular", str(font["/BaseFont"]))
                self.assertTrue(any(key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")))
                self.assertIn("/ToUnicode", font)
            text = page.extract_text()
            extracted.append(text)
            self.assertNotIn("?", text)
            self.assertNotIn("\ufffd", text)
            content = page.get_contents().get_data()
            self.assertGreater(content.count(b" m"), 1000)
            self.assertGreater(content.count(b" l"), 1000)
        combined = "\n".join(extracted)
        self.assertIn("T0-B 古建局部专业样板", combined)
        self.assertIn("团队演示/非正式签发", combined)
        self.assertIn("团队演示承托构造，非实测/非正式节点", combined)

    def test_two_review_png_files_are_exact_a1_300dpi_size(self) -> None:
        for path in PNG_PATHS:
            with Image.open(path) as image:
                self.assertEqual(image.size, (9933, 7016))
                self.assertEqual(image.mode, "RGB")
                dpi = image.info.get("dpi")
                self.assertIsNotNone(dpi)
                self.assertAlmostEqual(dpi[0], 300, delta=0.1)
                self.assertAlmostEqual(dpi[1], 300, delta=0.1)

    def test_generator_source_and_outputs_do_not_depend_on_forbidden_geometry_or_external_assets(self) -> None:
        source = inspect.getsource(sheet_module)
        for token in ("load_fixture", "detail_oracle", "view_geometry", "knownAnswers", "trimesh", "source_meshes", "old_preview"):
            self.assertNotIn(token, source)
        for path in [*SVG_PATHS, PDF_PATH, RECORD_PATH]:
            text = path.read_bytes().decode("utf-8", errors="ignore").lower()
            for token in (".dwg", "downloads", "寺庙古建筑设计方案图", "一套完整的古建施工图"):
                self.assertNotIn(token, text)

    def test_mismatched_or_absolute_font_configuration_is_rejected(self) -> None:
        font_manifest_path = ROOT / Path(*self.font_config["fontManifestRelativePath"].split("/"))
        font_path = ROOT / Path(*self.font_config["fontAssetRelativePath"].split("/"))
        font_manifest = json.loads(font_manifest_path.read_text(encoding="utf-8"))
        invalid = deepcopy(self.font_config)
        invalid["instanceWeight"] = 100
        with self.assertRaisesRegex(SheetOutputError, "weight"):
            DrawingSheetGenerator(self.contract, self.ir, invalid, font_manifest, font_path)
        invalid = deepcopy(self.font_config)
        invalid["fontAssetRelativePath"] = "C:/Windows/Fonts/forbidden.ttf"
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(SheetOutputError, "missing|hash|font"):
            invalid_path = Path(directory) / "logical_font_config.json"
            invalid_path.write_text(json.dumps(invalid), encoding="utf-8")
            build_sheet_outputs(CONTRACT_PATH, IR_PATH, invalid_path, Path(directory) / "out")

    def test_two_temporary_full_builds_are_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as first_root, tempfile.TemporaryDirectory() as second_root:
            first = Path(first_root) / "artifacts"
            second = Path(second_root) / "artifacts"
            command = [
                sys.executable,
                "-m",
                "workers.cad.t0b_v2.generate_sheet_outputs",
                "--contract",
                str(CONTRACT_PATH),
                "--ir",
                str(IR_PATH),
                "--font-config",
                str(FONT_CONFIG_PATH),
                "--output-dir",
            ]
            subprocess.run([*command, str(first)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
            subprocess.run([*command, str(second)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
            names = ["T0B-01.svg", "T0B-02.svg", "T0B.pdf", "T0B-01-300dpi.png", "T0B-02-300dpi.png", BUILD_RECORD_NAME]
            for name in names:
                self.assertEqual(sha256((first / name).read_bytes()).hexdigest(), sha256((second / name).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
