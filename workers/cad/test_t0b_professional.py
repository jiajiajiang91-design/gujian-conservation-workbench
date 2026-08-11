from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SPEC = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "professional-hall.json"
GENERATOR = HERE / "t0b_generate.py"
sys.path.insert(0, str(HERE))

from t0b_generate import build_model, generate, load_spec
from t0b_verify import verify


class T0BProfessionalSampleTests(unittest.TestCase):
    def test_stable_semantic_entity_ids(self) -> None:
        spec = load_spec(SPEC)
        first = [(item.key, item.entity_id, item.category) for item in build_model(spec)]
        second = [(item.key, item.entity_id, item.category) for item in build_model(spec)]
        self.assertEqual(first, second)
        self.assertGreaterEqual(len(first), 80)
        self.assertEqual(len(first), len({item[1] for item in first}))

    def test_generation_reverse_parse_and_l1_boundaries(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-") as directory:
            output = Path(directory) / "outputs"
            completed = subprocess.run(
                [sys.executable, str(GENERATOR), "--spec", str(SPEC), "--output", str(output)],
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            message = json.loads(completed.stdout)
            self.assertEqual(message["status"], "ok")
            result = verify(SPEC, output)
            self.assertEqual(result["status"], "passed")
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["localProfessionalSampleEligible"])
            self.assertFalse(manifest["professionalDeliverableEligible"])
            self.assertFalse(manifest["formalEligibility"])

    def test_existing_output_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-existing-") as directory:
            output = Path(directory) / "outputs"
            first = generate(SPEC, output)
            first_manifest = (output / "manifest.json").read_bytes()
            with self.assertRaises(FileExistsError):
                generate(SPEC, output)
            self.assertEqual(first_manifest, (output / "manifest.json").read_bytes())
            self.assertEqual(first["entityMap"], json.loads(first_manifest)["entityMap"])

    def test_invalid_spec_leaves_no_staging_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0b-invalid-") as directory:
            root = Path(directory)
            invalid = json.loads(SPEC.read_text(encoding="utf-8"))
            invalid["baySpans"][0] = -1
            spec_path = root / "invalid.json"
            spec_path.write_text(json.dumps(invalid, ensure_ascii=False), encoding="utf-8")
            output = root / "outputs"
            with self.assertRaises(ValueError):
                generate(spec_path, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".outputs.staging-*")), [])


if __name__ == "__main__":
    unittest.main()
