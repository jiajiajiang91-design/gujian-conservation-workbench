from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SPEC = ROOT / "验证材料" / "06_T0_CAD可行性验证" / "minimal-hall.json"
GENERATOR = HERE / "t0_generate.py"
sys.path.insert(0, str(HERE))

from t0_model import build_objects, load_spec
from t0_verify import verify


class T0CadSpikeTests(unittest.TestCase):
    def test_stable_entity_ids(self) -> None:
        spec = load_spec(SPEC)
        first = [(item.key, item.entity_id, item.ifc_guid) for item in build_objects(spec)]
        second = [(item.key, item.entity_id, item.ifc_guid) for item in build_objects(spec)]
        self.assertEqual(first, second)
        self.assertEqual(len(first), len({item[1] for item in first}))

    def test_generation_reverse_parse_and_normal_exit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0-") as directory:
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

    def test_cancellation_cleans_staging_and_exits_two(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gujian-t0-cancel-") as directory:
            root = Path(directory)
            output = root / "outputs"
            cancel_file = root / "cancel.request"
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(GENERATOR),
                    "--spec", str(SPEC),
                    "--output", str(output),
                    "--cancel-file", str(cancel_file),
                    "--hold-ms", "3000",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            time.sleep(0.25)
            cancel_file.write_text("cancel\n", encoding="utf-8")
            stdout, stderr = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 2, stderr)
            self.assertEqual(json.loads(stdout)["status"], "cancelled")
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".outputs.staging-*")), [])


if __name__ == "__main__":
    unittest.main()
