from __future__ import annotations

from copy import deepcopy
import gzip
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from workers.cad.t0b_v2.verify_projections import _line_id, verify_projections


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = next(ROOT.rglob("t0b-v2-resolved-local-assembly.json")).parent
FIXTURE = BASE / "t0b-v2-resolved-local-assembly.json"
OUTPUTS = BASE / "t0b-v2-outputs"
PROJECTIONS = OUTPUTS / "projections"
MANIFEST = OUTPUTS / "geometry-manifest.json"
SOURCE_MESHES = OUTPUTS / "source-meshes.ndjson.gz"
VIEW_IDS = ("roofPlan", "southElevation", "axonometric")


def _load(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _write(path: Path, output: dict) -> None:
    payload = dict(output)
    payload.pop("viewGeometrySha256", None)
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    output["viewGeometrySha256"] = sha256(canonical.encode("utf-8")).hexdigest()
    raw = (json.dumps(output, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))


class T0BV2ProjectionVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cls.outputs = {view_id: _load(PROJECTIONS / f"{view_id}.view-geometry.json.gz") for view_id in VIEW_IDS}

    def _run_variant(self, view_id: str, mutate) -> set[str]:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for current_view_id, source in self.outputs.items():
                output = deepcopy(source)
                if current_view_id == view_id:
                    mutate(output)
                _write(target / f"{current_view_id}.view-geometry.json.gz", output)

            def expected(view, _manifest, _meshes, _policy):
                return deepcopy(self.outputs[view["id"]]["projectionLines"])

            with patch("workers.cad.t0b_v2.verify_projections._expected_lines", side_effect=expected):
                report = verify_projections(FIXTURE, MANIFEST, SOURCE_MESHES, target)
        self.assertEqual(report["status"], "failed")
        return {check["name"] for check in report["checks"] if not check["passed"]}

    def test_removing_required_ridge_fails(self) -> None:
        ridge_id = self.fixture["knownAnswers"]["viewOracle"]["views"]["roofPlan"]["requiredVisibleEntityIds"][0]

        def mutate(output: dict) -> None:
            output["projectionLines"] = [line for line in output["projectionLines"] if line["sourceEntityId"] != ridge_id]
            output["statistics"]["visibleProjectionLineCount"] = len(output["projectionLines"])

        failed = self._run_variant("roofPlan", mutate)
        self.assertIn("roofPlan required visible entities", failed)

    def test_forbidden_north_column_injection_fails(self) -> None:
        forbidden_id = self.fixture["knownAnswers"]["viewOracle"]["views"]["southElevation"]["mustNotAppearEntityIds"][0]

        def mutate(output: dict) -> None:
            line = deepcopy(output["projectionLines"][0])
            line["sourceEntityId"] = forbidden_id
            line["sourceComponentType"] = "column"
            line["lineId"] = _line_id(output["viewContractRevisionId"], output["viewId"], forbidden_id, line["lineClass"], line["pointsMm"])
            output["projectionLines"].append(line)
            output["statistics"]["visibleProjectionLineCount"] = len(output["projectionLines"])

        failed = self._run_variant("southElevation", mutate)
        self.assertIn("southElevation forbidden entities absent", failed)

    def test_mirrored_axonometric_frame_fails(self) -> None:
        def mutate(output: dict) -> None:
            output["viewFrame"]["right"] = [-value for value in output["viewFrame"]["right"]]
            for line in output["projectionLines"]:
                line["derivationTransform"] = output["viewFrame"]["modelToView"]

        failed = self._run_variant("axonometric", mutate)
        self.assertIn("axonometric top level contract", failed)

    def test_source_revision_and_transform_tamper_fails(self) -> None:
        def mutate(output: dict) -> None:
            line = output["projectionLines"][0]
            line["geometryRevisionId"] = "00000000-0000-0000-0000-000000000000"
            line["derivationTransform"][0][3] += 100

        failed = self._run_variant("southElevation", mutate)
        self.assertIn("southElevation line record closure", failed)

    def test_coplanar_duplicate_edge_injection_fails(self) -> None:
        def mutate(output: dict) -> None:
            duplicate = deepcopy(output["projectionLines"][0])
            duplicate["lineId"] = "00000000-0000-0000-0000-000000000000"
            output["projectionLines"].append(duplicate)
            output["statistics"]["visibleProjectionLineCount"] = len(output["projectionLines"])

        failed = self._run_variant("roofPlan", mutate)
        self.assertIn("roofPlan no coincident duplicates", failed)


if __name__ == "__main__":
    unittest.main()
