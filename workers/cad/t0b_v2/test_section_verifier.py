from __future__ import annotations

from collections import defaultdict
import gzip
from hashlib import sha256
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import numpy as np


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = next(ROOT.rglob("t0b-v2-resolved-local-assembly.json")).parent
FIXTURE = BASE / "t0b-v2-resolved-local-assembly.json"
OUTPUTS = BASE / "t0b-v2-outputs"
SECTIONS = OUTPUTS / "sections"
MANIFEST = OUTPUTS / "geometry-manifest.json"
SOURCE_MESHES = OUTPUTS / "source-meshes.ndjson.gz"

from workers.cad.t0b_v2.verify_sections import VisibilityOracle, verify_sections


def _read_view(directory: Path, view_id: str) -> dict:
    with gzip.open(directory / f"{view_id}.view-geometry.json.gz", "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _write_view(directory: Path, view_id: str, payload: dict) -> None:
    raw = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    (directory / f"{view_id}.view-geometry.json.gz").write_bytes(gzip.compress(raw, mtime=0))


def _refresh_view_hash(payload: dict) -> None:
    payload.pop("viewGeometrySha256", None)
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload["viewGeometrySha256"] = sha256(canonical.encode("utf-8")).hexdigest()


class T0BV2SectionVerifierTests(unittest.TestCase):
    def test_saved_outputs_pass_independent_verification(self) -> None:
        report = verify_sections(FIXTURE, MANIFEST, SOURCE_MESHES, SECTIONS)
        self.assertEqual(report["status"], "passed-section-geometry-only")
        self.assertTrue(all(check["passed"] for check in report["checks"]))

    def test_independent_oracle_rejects_a_narrow_occluder(self) -> None:
        oracle = VisibilityOracle.__new__(VisibilityOracle)
        oracle.clip = [-10.0, -10.0, 110.0, 10.0]
        oracle.cell = 120.0
        oracle.triangles = []
        oracle.cells = defaultdict(list)
        oracle._add(np.asarray([[47.5, -1.0, 0.0], [52.5, -1.0, 0.0], [50.0, 1.0, 0.0]]))
        self.assertFalse(
            oracle.segment_fully_visible(
                np.asarray([0.0, 0.0, 10.0]),
                np.asarray([100.0, 0.0, 10.0]),
            )
        )

    def test_tampered_source_and_cut_boundary_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "sections"
            shutil.copytree(SECTIONS, copy)
            output = _read_view(copy, "floorPlan")
            output["projectionLines"][0]["sourceEntityId"] = "00000000-0000-0000-0000-000000000000"
            output["projectionLines"][1]["pointsMm"][0][0] += 1000
            output["cutLines"][0]["pointsMm"][0][0] += 20
            _write_view(copy, "floorPlan", output)
            report = verify_sections(FIXTURE, MANIFEST, SOURCE_MESHES, copy)
            failed = {check["name"] for check in report["checks"] if not check["passed"]}
            self.assertEqual(report["status"], "failed")
            self.assertIn("floorPlan projection source coverage", failed)
            self.assertIn("floorPlan projection 2d 3d binding", failed)
            self.assertIn("floorPlan view geometry hash", failed)
            self.assertIn("floorPlan independent cut boundary hash", failed)

    def test_hidden_projection_injection_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "sections"
            shutil.copytree(SECTIONS, copy)
            output = _read_view(copy, "transverseSection")
            line = output["projectionLines"][0]
            for point in line["sourcePointsViewMm"]:
                point[2] += 5000
            _write_view(copy, "transverseSection", output)
            report = verify_sections(FIXTURE, MANIFEST, SOURCE_MESHES, copy)
            failed = {check["name"] for check in report["checks"] if not check["passed"]}
            self.assertEqual(report["status"], "failed")
            self.assertIn("transverseSection source edge coverage", failed)
            self.assertIn("transverseSection independent exact occlusion", failed)

    def test_rehashed_frame_and_material_tampering_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "sections"
            shutil.copytree(SECTIONS, copy)
            output = _read_view(copy, "floorPlan")
            output["viewFrame"]["origin"][0] += 1000
            output["cutRegions"][0]["materialCode"] = "forged"
            output["cutRegions"][0]["materialHatch"] = "forged"
            _refresh_view_hash(output)
            _write_view(copy, "floorPlan", output)
            report = verify_sections(FIXTURE, MANIFEST, SOURCE_MESHES, copy)
            failed = {check["name"] for check in report["checks"] if not check["passed"]}
            self.assertEqual(report["status"], "failed")
            self.assertNotIn("floorPlan view geometry hash", failed)
            self.assertIn("floorPlan top level contract", failed)
            self.assertIn("floorPlan cut region material semantics", failed)


if __name__ == "__main__":
    unittest.main()
