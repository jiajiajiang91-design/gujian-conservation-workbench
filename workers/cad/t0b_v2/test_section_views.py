from __future__ import annotations

import gzip
import json
from pathlib import Path
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

from workers.cad.t0b_v2.build_sections import SECTION_VIEW_IDS, build_sections
from workers.cad.t0b_v2.contracts import load_fixture, prepare_view_generation_input
from workers.cad.t0b_v2.view_geometry import DepthIndex, SectionViewGenerator, ViewGeometryError, _visible_intervals, load_source_meshes


def _load_view(view_id: str) -> dict:
    with gzip.open(SECTIONS / f"{view_id}.view-geometry.json.gz", "rt", encoding="utf-8") as stream:
        return json.load(stream)


class T0BV2SectionViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE)
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        cls.metadata = {item["entityId"]: item for item in cls.manifest["entities"]}
        cls.views = {view_id: _load_view(view_id) for view_id in SECTION_VIEW_IDS}

    def test_outputs_bind_both_frozen_revisions(self) -> None:
        for view_id, output in self.views.items():
            self.assertEqual(output["viewId"], view_id)
            self.assertEqual(output["geometryRevisionId"], self.fixture["geometryRevisionId"])
            self.assertEqual(output["viewContractRevisionId"], self.fixture["viewContractRevisionId"])
            self.assertEqual(output["status"], "generated-not-qualified")
            self.assertEqual(output["qualification"], "not-drawing-output")

    def test_cut_regions_match_the_frozen_topology(self) -> None:
        oracle = self.fixture["knownAnswers"]["viewOracle"]["views"]
        for view_id, output in self.views.items():
            self.assertEqual(output["statistics"]["cutRegionCount"], oracle[view_id]["cutClosedRegionCount"])
            self.assertEqual(output["statistics"]["cutRegionCountByType"], oracle[view_id]["cutClosedRegionsByType"])
            self.assertEqual(output["statistics"]["cutEntitySetSha256"], oracle[view_id]["cutEntitySetSha256"])
            self.assertEqual(output["statistics"]["openOrDangleCount"], 0)
            self.assertTrue(output["cutRegions"])

    def test_exact_occlusion_does_not_miss_a_narrow_blocker(self) -> None:
        blocker = np.asarray([[[47.5, -1.0, 0.0], [52.5, -1.0, 0.0], [50.0, 1.0, 0.0]]])
        index = DepthIndex(list(blocker), [-10.0, -10.0, 110.0, 10.0])
        intervals = _visible_intervals(
            np.asarray([0.0, 0.0, 10.0]),
            np.asarray([100.0, 0.0, 10.0]),
            index,
            tolerance=0.5,
            split_tolerance=5.0,
        )
        self.assertEqual(len(intervals), 2)
        self.assertLess(intervals[0][1][0], 50.0)
        self.assertGreater(intervals[1][0][0], 50.0)
        self.assertGreaterEqual(intervals[1][0][0] - intervals[0][1][0], 2.49)

    def test_every_structural_line_keeps_source_and_derivation(self) -> None:
        for output in self.views.values():
            line_ids = set()
            for line in [*output["cutLines"], *output["projectionLines"]]:
                self.assertNotIn(line["lineId"], line_ids)
                line_ids.add(line["lineId"])
                self.assertIn(line["sourceEntityId"], self.metadata)
                self.assertEqual(line["sourceComponentType"], self.metadata[line["sourceEntityId"]]["componentType"])
                self.assertEqual(line["geometryRevisionId"], output["geometryRevisionId"])
                self.assertEqual(line["viewContractRevisionId"], output["viewContractRevisionId"])
                self.assertIn(line["lineClass"], {"cut", "silhouette", "feature", "componentBoundary"})
                self.assertEqual(line["visibility"], "visible")
                self.assertNotEqual(line["lineClass"], "triangleEdge")

    def test_depth_projection_respects_semantic_type_boundary(self) -> None:
        contract_views = {item["id"]: item for item in self.fixture["views"]}
        for view_id, output in self.views.items():
            allowed = set(contract_views[view_id]["section"]["depthProjectionTypes"])
            self.assertTrue(output["projectionLines"])
            self.assertTrue({line["sourceComponentType"] for line in output["projectionLines"]} <= allowed)
            for line in output["projectionLines"]:
                self.assertEqual([point[:2] for point in line["sourcePointsViewMm"]], line["pointsMm"])

    def test_generator_rejects_unsanitized_fixture(self) -> None:
        _header, meshes = load_source_meshes(SOURCE_MESHES)
        with self.assertRaisesRegex(ViewGeometryError, "sanitized"):
            SectionViewGenerator(self.fixture, self.manifest, meshes)

    def test_build_rejects_tampered_or_incomplete_source_closure(self) -> None:
        with gzip.open(SOURCE_MESHES, "rt", encoding="utf-8") as stream:
            records = [json.loads(line) for line in stream if line.strip()]
        variants = []
        tampered = json.loads(json.dumps(records))
        tampered[1]["vertices"][0][0] += 20
        variants.append(tampered)
        reversed_face = json.loads(json.dumps(records))
        reversed_face[1]["faces"][0].reverse()
        variants.append(reversed_face)
        variants.append(records[:-1])
        duplicated = json.loads(json.dumps(records))
        duplicated.append(duplicated[1])
        variants.append(duplicated)
        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            for index, variant in enumerate(variants):
                source_path = directory_path / f"source-{index}.ndjson.gz"
                raw = "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in variant).encode("utf-8")
                source_path.write_bytes(gzip.compress(raw, mtime=0))
                with self.subTest(index=index), self.assertRaisesRegex(ViewGeometryError, "oriented topology hash"):
                    build_sections(FIXTURE, MANIFEST, source_path, directory_path / f"sections-{index}")

    def test_build_rejects_tampered_semantic_manifest(self) -> None:
        variants = []
        component = json.loads(json.dumps(self.manifest))
        component["entities"][0]["componentType"] = "wall"
        variants.append(component)
        relation = json.loads(json.dumps(self.manifest))
        relation["relations"][0]["relation"] = "containedBy"
        variants.append(relation)
        source = json.loads(json.dumps(self.manifest))
        source["entities"][0]["sourceRefs"] = ["external:forbidden"]
        variants.append(source)
        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            for index, variant in enumerate(variants):
                manifest_path = directory_path / f"manifest-{index}.json"
                manifest_path.write_text(json.dumps(variant), encoding="utf-8")
                with self.subTest(index=index), self.assertRaisesRegex(ViewGeometryError, "semantic geometry signature"):
                    build_sections(FIXTURE, manifest_path, SOURCE_MESHES, directory_path / f"sections-{index}")

    def test_section_outputs_are_deterministic(self) -> None:
        expected = json.loads((SECTIONS / "section-build-record.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            actual = build_sections(FIXTURE, MANIFEST, SOURCE_MESHES, Path(directory) / "sections")
        self.assertEqual(
            [(item["viewId"], item["sha256"], item["viewGeometrySha256"]) for item in actual["outputs"]],
            [(item["viewId"], item["sha256"], item["viewGeometrySha256"]) for item in expected["outputs"]],
        )


if __name__ == "__main__":
    unittest.main()
