from __future__ import annotations

import gzip
import json
from pathlib import Path
import unittest

import numpy as np

from workers.cad.t0b_v2.build_projections import PROJECTION_VIEW_IDS
from workers.cad.t0b_v2.contracts import load_fixture, prepare_view_generation_input
from workers.cad.t0b_v2.view_geometry import (
    DepthIndex,
    ProjectionViewGenerator,
    ViewGeometryError,
    _occluded_interval,
    _occluded_intervals,
    _visible_intervals,
    load_source_meshes,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = next(ROOT.rglob("t0b-v2-resolved-local-assembly.json")).parent
FIXTURE = BASE / "t0b-v2-resolved-local-assembly.json"
OUTPUTS = BASE / "t0b-v2-outputs"
PROJECTIONS = OUTPUTS / "projections"
MANIFEST = OUTPUTS / "geometry-manifest.json"
SOURCE_MESHES = OUTPUTS / "source-meshes.ndjson.gz"


def _load_view(view_id: str) -> dict:
    with gzip.open(PROJECTIONS / f"{view_id}.view-geometry.json.gz", "rt", encoding="utf-8") as stream:
        return json.load(stream)


class T0BV2ProjectionViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE)
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        cls.metadata = {entity["entityId"]: entity for entity in cls.manifest["entities"]}
        cls.views = {view_id: _load_view(view_id) for view_id in PROJECTION_VIEW_IDS}

    def test_outputs_bind_frozen_contract_and_geometry(self) -> None:
        for view_id, output in self.views.items():
            self.assertEqual(output["viewId"], view_id)
            self.assertEqual(output["geometryRevisionId"], self.fixture["geometryRevisionId"])
            self.assertEqual(output["viewContractRevisionId"], self.fixture["viewContractRevisionId"])
            self.assertEqual(output["status"], "generated-not-qualified")
            self.assertEqual(output["qualification"], "not-drawing-output")

    def test_every_line_keeps_source_transform_and_class(self) -> None:
        contract_views = {view["id"]: view for view in self.fixture["views"]}
        for view_id, output in self.views.items():
            view = contract_views[view_id]
            line_ids: set[str] = set()
            point_keys: set[tuple] = set()
            for line in output["projectionLines"]:
                self.assertNotIn(line["lineId"], line_ids)
                line_ids.add(line["lineId"])
                point_key = tuple(map(tuple, line["pointsMm"]))
                self.assertNotIn(point_key, point_keys)
                point_keys.add(point_key)
                entity = self.metadata[line["sourceEntityId"]]
                self.assertEqual(line["sourceComponentType"], entity["componentType"])
                self.assertIn(entity["componentType"], view["projection"]["displayTypes"])
                self.assertEqual(line["derivation"], "visibleLineProjection")
                self.assertEqual(line["derivationTransform"], view["viewFrame"]["modelToView"])
                self.assertEqual(line["visibility"], "visible")
                self.assertIn(line["lineClass"], {"silhouette", "componentBoundary", "feature"})
                self.assertEqual(line["pointsMm"], [point[:2] for point in line["sourcePointsViewMm"]])

    def test_required_and_forbidden_sources_match_oracle(self) -> None:
        answers = self.fixture["knownAnswers"]["viewOracle"]["views"]
        for view_id, output in self.views.items():
            entity_ids = {line["sourceEntityId"] for line in output["projectionLines"]}
            component_types = {line["sourceComponentType"] for line in output["projectionLines"]}
            self.assertTrue(set(answers[view_id]["requiredVisibleEntityIds"]) <= entity_ids)
            self.assertFalse(set(answers[view_id].get("mustNotAppearEntityIds", [])) & entity_ids)
            self.assertFalse(set(answers[view_id].get("mustNotAppearTypes", [])) & component_types)

    def test_roof_plan_continuity_sources_are_visible(self) -> None:
        entities = {line["sourceEntityId"] for line in self.views["roofPlan"]["projectionLines"]}
        chains = self.fixture["knownAnswers"]["viewOracle"]["views"]["roofPlan"]["requiredVisibleChains"]
        for chain in chains.values():
            self.assertTrue(set(chain) <= entities)

    def test_exact_hlr_detects_a_five_millimetre_blocker(self) -> None:
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

    def test_vectorized_occlusion_matches_scalar_oracle(self) -> None:
        random = np.random.default_rng(20260811)
        for _case in range(200):
            start = random.uniform(-20, 20, 3)
            end = random.uniform(-20, 20, 3)
            triangles = [random.uniform(-20, 20, (3, 3)) for _ in range(20)]
            scalar = sorted(
                interval
                for triangle in triangles
                if (interval := _occluded_interval(start, end, triangle, 0.5)) is not None
            )
            vectorized = sorted(_occluded_intervals(start, end, triangles, 0.5))
            self.assertEqual(len(vectorized), len(scalar))
            self.assertTrue(
                all(
                    max(abs(actual[0] - expected[0]), abs(actual[1] - expected[1])) <= 1e-7
                    for actual, expected in zip(vectorized, scalar)
                )
            )

    def test_generator_rejects_unsanitized_fixture(self) -> None:
        _header, meshes = load_source_meshes(SOURCE_MESHES)
        with self.assertRaisesRegex(ViewGeometryError, "sanitized"):
            ProjectionViewGenerator(self.fixture, self.manifest, meshes)
        self.assertNotIn("knownAnswers", prepare_view_generation_input(self.fixture))


if __name__ == "__main__":
    unittest.main()
