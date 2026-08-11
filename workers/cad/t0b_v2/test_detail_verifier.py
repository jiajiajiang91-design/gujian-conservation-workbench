from __future__ import annotations

import ast
from copy import deepcopy
import gzip
from hashlib import sha256
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from PIL import Image

from workers.cad.t0b_v2.verify_details import _file_hash, _line_id, _stable_hash, verify_details


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = next(ROOT.rglob("t0b-v2-resolved-local-assembly.json")).parent
FIXTURE = BASE / "t0b-v2-resolved-local-assembly.json"
OUTPUTS = BASE / "t0b-v2-outputs"
DETAILS = OUTPUTS / "details"
MANIFEST = OUTPUTS / "geometry-manifest.json"
SOURCE_MESHES = OUTPUTS / "source-meshes.ndjson.gz"


def _load_output(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _write_output(path: Path, output: dict, rehash: bool) -> None:
    if rehash:
        payload = dict(output)
        payload.pop("viewGeometrySha256", None)
        output["viewGeometrySha256"] = _stable_hash(payload)
    raw = (json.dumps(output, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))


def _sync_build_record(details_dir: Path, view_id: str, output: dict) -> None:
    path = details_dir / "detail-build-record.json"
    record = json.loads(path.read_text(encoding="utf-8"))
    output_path = details_dir / f"{view_id}.view-geometry.json.gz"
    for item in record["outputs"]:
        if item["viewId"] == view_id:
            item["sha256"] = _file_hash(output_path)
            item["viewGeometrySha256"] = output.get("viewGeometrySha256")
            item["statistics"] = output.get("statistics")
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class T0BV2IndependentDetailVerifierTests(unittest.TestCase):
    def _mutated_report(self, view_id: str, mutator, *, rehash: bool = True) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            details_dir = Path(directory) / "details"
            shutil.copytree(DETAILS, details_dir)
            output_path = details_dir / f"{view_id}.view-geometry.json.gz"
            output = _load_output(output_path)
            mutator(output)
            _write_output(output_path, output, rehash=rehash)
            _sync_build_record(details_dir, view_id, output)
            return verify_details(
                FIXTURE,
                MANIFEST,
                SOURCE_MESHES,
                details_dir,
                view_ids=(view_id,),
                context_outputs_root=OUTPUTS,
            )

    def _fixture_report(self, mutator, view_id: str = "doorWindowDetail") -> dict:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        mutator(fixture)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / FIXTURE.name
            path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return verify_details(
                path,
                MANIFEST,
                SOURCE_MESHES,
                DETAILS,
                view_ids=(view_id,),
                context_outputs_root=OUTPUTS,
            )

    @staticmethod
    def _failed(report: dict, name: str) -> bool:
        return report["status"] == "failed" and any(name in check["name"] and not check["passed"] for check in report["checks"])

    def test_verifier_has_no_generator_or_detail_oracle_import(self) -> None:
        source = (HERE / "verify_details.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.append(node.module or "")
        self.assertFalse(any(name.endswith(("view_geometry", "build_details", "detail_oracle")) for name in imported))

    def test_current_four_detail_outputs_pass_independent_verification(self) -> None:
        report = verify_details(FIXTURE, MANIFEST, SOURCE_MESHES, DETAILS, context_outputs_root=OUTPUTS)
        self.assertEqual(report["status"], "passed-detail-geometry-only")
        self.assertEqual(report["summary"]["failed"], 0)
        self.assertEqual(report["qualification"], "not-drawing-output")
        self.assertIs(report["L1"], False)

    def test_twelve_review_previews_bind_sources_hashes_dimensions_and_dpi(self) -> None:
        previews_dir = DETAILS / "previews"
        record = json.loads((previews_dir / "detail-preview-record.json").read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "review-evidence-only")
        self.assertEqual(record["qualification"], "not-drawing-output")
        self.assertIs(record["L1"], False)
        self.assertEqual(record["reviewStatus"], "reviewed-with-nonblocking-findings")
        self.assertEqual(len(record["previews"]), 12)
        self.assertEqual(
            {(item["viewId"], item["mode"]) for item in record["previews"]},
            {
                (view_id, mode)
                for view_id in ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail")
                for mode in ("clean", "lineClass", "material-source")
            },
        )
        for item in record["previews"]:
            image_path = previews_dir / item["path"]
            source_path = DETAILS / item["source"]["path"]
            self.assertEqual(_file_hash(image_path), item["sha256"])
            self.assertEqual(_file_hash(source_path), item["source"]["sha256"])
            self.assertEqual(_load_output(source_path)["viewGeometrySha256"], item["source"]["viewGeometrySha256"])
            with Image.open(image_path) as image:
                self.assertEqual(list(image.size), [2400, 1800])
                self.assertEqual([round(float(value)) for value in image.info.get("dpi", (0, 0))], [300, 300])

    def test_stale_output_hash_is_rejected(self) -> None:
        def mutate(output: dict) -> None:
            output["projectionLines"][0]["pointsMm"][0][0] += 1

        report = self._mutated_report("bracketDetail", mutate, rehash=False)
        self.assertTrue(self._failed(report, "output hash"))

    def test_source_entity_tamper_is_rejected_after_rehash(self) -> None:
        def mutate(output: dict) -> None:
            line = output["projectionLines"][0]
            line["sourceEntityId"] = "00000000-0000-5000-8000-000000000000"
            line["lineId"] = _line_id(
                output["viewContractRevisionId"], output["viewId"], line["sourceEntityId"], line["derivation"], line["lineClass"], line["pointsMm"]
            )

        report = self._mutated_report("bracketDetail", mutate)
        self.assertTrue(self._failed(report, "record closure"))
        self.assertTrue(self._failed(report, "complete visible-line"))

    def test_revision_tamper_is_rejected_after_rehash(self) -> None:
        report = self._mutated_report(
            "bracketDetail",
            lambda output: output.__setitem__("geometryRevisionId", "00000000-0000-5000-8000-000000000001"),
        )
        self.assertTrue(self._failed(report, "top-level contract"))

    def test_mirrored_frame_and_transform_are_rejected_after_rehash(self) -> None:
        def mutate(output: dict) -> None:
            output["viewFrame"]["right"] = [-value for value in output["viewFrame"]["right"]]
            output["viewFrame"]["modelToView"][0] = [-value for value in output["viewFrame"]["modelToView"][0]]
            for line in [*output["cutLines"], *output["projectionLines"], *output["cropLimitLines"]]:
                line["derivationTransform"] = output["viewFrame"]["modelToView"]

        report = self._mutated_report("eaveDetail", mutate)
        self.assertTrue(self._failed(report, "top-level contract"))

    def test_line_class_tamper_is_rejected_after_rehash(self) -> None:
        def mutate(output: dict) -> None:
            line = output["projectionLines"][0]
            line["lineClass"] = "triangleEdge"
            line["lineId"] = _line_id(
                output["viewContractRevisionId"], output["viewId"], line["sourceEntityId"], line["derivation"], line["lineClass"], line["pointsMm"]
            )

        report = self._mutated_report("doorWindowDetail", mutate)
        self.assertTrue(self._failed(report, "record closure"))
        self.assertTrue(self._failed(report, "complete visible-line"))

    def test_material_tamper_is_rejected_after_rehash(self) -> None:
        def mutate(output: dict) -> None:
            output["materialRegions"][0]["materialCode"] = "stone-demo"
            output["materialRegions"][0]["materialHatch"] = "stone"

        report = self._mutated_report("eaveDetail", mutate)
        self.assertTrue(self._failed(report, "material-region set"))
        self.assertTrue(self._failed(report, "record closure"))

    def test_crop_limit_tamper_is_rejected_after_rehash(self) -> None:
        def mutate(output: dict) -> None:
            line = output["cropLimitLines"][0]
            line["pointsMm"][0][0] += 5
            line["lineId"] = _line_id(
                output["viewContractRevisionId"], output["viewId"], line["sourceEntityId"], line["derivation"], line["lineClass"], line["pointsMm"]
            )

        report = self._mutated_report("columnBaseDetail", mutate)
        self.assertTrue(self._failed(report, "crop-limit set"))

    def test_occlusion_line_removal_is_rejected_after_rehash(self) -> None:
        def mutate(output: dict) -> None:
            output["projectionLines"].pop(len(output["projectionLines"]) // 2)
            output["statistics"]["visibleProjectionLineCount"] -= 1
            output["statistics"]["structuralLineCount"] -= 1

        report = self._mutated_report("bracketDetail", mutate)
        self.assertTrue(self._failed(report, "complete visible-line and occlusion set"))

    def test_door_window_topology_fixture_tamper_is_rejected(self) -> None:
        def mutate(fixture: dict) -> None:
            fixture["componentTemplates"]["doorLeaf"]["parameters"]["panels"] = 3

        report = self._fixture_report(mutate)
        self.assertTrue(self._failed(report, "independent topology counts"))

    def test_external_cad_path_and_hash_probes_are_rejected(self) -> None:
        probes = (
            r"D:\Downloads\reference.dwg",
            "file:///external/reference.dwg",
            "a" * 64,
        )
        for probe in probes:
            def mutate(fixture: dict, value=probe) -> None:
                detail = next(view["detail"] for view in fixture["views"] if view["id"] == "eaveDetail")
                detail["externalDependencyProbe"] = value

            with self.subTest(probe=probe), self.assertRaisesRegex(ValueError, "external CAD|dependency hash"):
                self._fixture_report(mutate, view_id="eaveDetail")

    def test_manifest_external_source_injection_is_rejected(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        manifest["entities"][0]["sourceRefs"] = ["file:///external/reference.dwg"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / MANIFEST.name
            path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "external CAD|demo source"):
                verify_details(
                    FIXTURE,
                    path,
                    SOURCE_MESHES,
                    DETAILS,
                    view_ids=("bracketDetail",),
                    context_outputs_root=OUTPUTS,
                )


if __name__ == "__main__":
    unittest.main()
