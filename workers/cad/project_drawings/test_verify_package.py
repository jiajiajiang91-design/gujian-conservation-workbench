from __future__ import annotations

import json
import gzip
import hashlib
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from .verify_package import verify


ROOT = Path(__file__).resolve().parents[3]
MATRIX = ROOT / "验证材料" / "09_T9任务驱动制图验证" / "artifact-requirement-matrix.json"
GEOMETRY = ROOT / "apps" / "server" / ".data" / "cad-staging" / "421e97f6-1923-4a14-9ef2-3d2b200a24ed" / "output"
OUTPUT = ROOT / "apps" / "server" / ".data" / "acceptance" / "milestone-two" / "t9-drawings"
FONT = ROOT / "workers" / "cad" / "t0b_v2" / "assets" / "fonts" / "noto-sans-sc" / "GujianSansSC-Regular.ttf"


class DrawingPackageVerifierTests(unittest.TestCase):
    @staticmethod
    def _copy_package(target: Path) -> None:
        for path in OUTPUT.iterdir():
            if path.is_file():
                (target / path.name).write_bytes(path.read_bytes())
        (target / "view-geometry").mkdir()
        for path in (OUTPUT / "view-geometry").iterdir():
            (target / "view-geometry" / path.name).write_bytes(path.read_bytes())

    def test_current_package_passes(self) -> None:
        if not OUTPUT.is_dir():
            self.skipTest("acceptance output is not present")
        report = verify(MATRIX, GEOMETRY, OUTPUT, FONT)
        self.assertEqual(report["failedCheckCount"], 0, report["checks"])

    def test_png_dimension_tamper_is_detected(self) -> None:
        if not OUTPUT.is_dir():
            self.skipTest("acceptance output is not present")
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self._copy_package(target)
            with Image.open(target / "P-01.png") as source:
                source.resize((100, 100)).save(target / "P-01.png", dpi=(72, 72))
            record = json.loads((target / "drawing-build-record.json").read_text(encoding="utf-8"))
            for asset in record["assets"]:
                if asset["fileName"] == "P-01.png":
                    asset["sha256"] = hashlib.sha256((target / "P-01.png").read_bytes()).hexdigest()
                    asset["byteLength"] = (target / "P-01.png").stat().st_size
            (target / "drawing-build-record.json").write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
            report = verify(MATRIX, GEOMETRY, target, FONT)
            self.assertTrue(any(item["id"] == "png-closure" and not item["passed"] for item in report["checks"]))

    def test_source_line_tamper_is_detected_after_rehash(self) -> None:
        if not OUTPUT.is_dir():
            self.skipTest("acceptance output is not present")
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self._copy_package(target)
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
            report = verify(MATRIX, GEOMETRY, target, FONT)
            self.assertTrue(any(item["id"] == "source-geometry-recompute" and not item["passed"] for item in report["checks"]))


if __name__ == "__main__":
    unittest.main()
