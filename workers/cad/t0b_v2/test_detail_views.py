from __future__ import annotations

from copy import deepcopy
import gzip
from hashlib import sha256
import inspect
import json
from pathlib import Path
import tempfile
import unittest

from shapely.geometry import Polygon

from workers.cad.t0b_v2.build_details import DETAIL_VIEW_IDS, build_details
import workers.cad.t0b_v2.build_details as detail_build_module
from workers.cad.t0b_v2.contracts import load_fixture, prepare_view_generation_input
from workers.cad.t0b_v2.detail_oracle import detail_oracle
from workers.cad.t0b_v2 import view_geometry
from workers.cad.t0b_v2.view_geometry import DetailViewGenerator, ViewGeometryError, load_source_meshes


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = next(ROOT.rglob("t0b-v2-resolved-local-assembly.json")).parent
FIXTURE = BASE / "t0b-v2-resolved-local-assembly.json"
OUTPUTS = BASE / "t0b-v2-outputs"
DETAILS = OUTPUTS / "details"
MANIFEST = OUTPUTS / "geometry-manifest.json"
SOURCE_MESHES = OUTPUTS / "source-meshes.ndjson.gz"


def _load_view(view_id: str) -> dict:
    with gzip.open(DETAILS / f"{view_id}.view-geometry.json.gz", "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _line_set_hash(output: dict) -> str:
    records = []
    for line in output["cutLines"]:
        records.append(
            (
                line["sourceEntityId"],
                line["sourceComponentType"],
                line["derivation"],
                line["lineClass"],
                line["pointsMm"],
                None,
            )
        )
    for line in output["projectionLines"]:
        records.append(
            (
                line["sourceEntityId"],
                line["sourceComponentType"],
                line["derivation"],
                line["lineClass"],
                line["pointsMm"],
                line["sourcePointsViewMm"],
            )
        )
    records.sort(key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))
    return sha256(json.dumps(records, separators=(",", ":")).encode("utf-8")).hexdigest()


class T0BV2DetailViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture(FIXTURE)
        cls.contract = prepare_view_generation_input(cls.fixture)
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        cls.source_header, cls.meshes = load_source_meshes(SOURCE_MESHES)
        cls.contract_views = {view["id"]: view for view in cls.fixture["views"]}
        cls.outputs = {view_id: _load_view(view_id) for view_id in DETAIL_VIEW_IDS}

    def test_outputs_remain_unqualified_geometry(self) -> None:
        for view_id, output in self.outputs.items():
            self.assertEqual(output["viewId"], view_id)
            self.assertEqual(output["geometryRevisionId"], self.fixture["geometryRevisionId"])
            self.assertEqual(output["viewContractRevisionId"], self.fixture["viewContractRevisionId"])
            self.assertEqual(output["status"], "generated-not-qualified")
            self.assertEqual(output["qualification"], "not-drawing-output")
            self.assertIs(output["L1"], False)

    def test_structural_lines_match_independent_detail_oracle(self) -> None:
        policy = self.fixture["drawingRequirements"]["projectionPolicy"]
        for view_id, output in self.outputs.items():
            expected = detail_oracle(self.contract_views[view_id], self.manifest, self.meshes, policy)
            self.assertEqual(output["statistics"]["structuralLineCount"], expected["visibleLineCountDiagnostic"])
            self.assertEqual(_line_set_hash(output), expected["visibleLineSetSha256"])
            self.assertEqual(
                sorted({line["sourceEntityId"] for line in [*output["cutLines"], *output["projectionLines"]]}),
                expected["requiredVisibleEntityIds"],
            )

    def test_section_material_regions_match_independent_oracle(self) -> None:
        policy = self.fixture["drawingRequirements"]["projectionPolicy"]
        for view_id in ("eaveDetail", "columnBaseDetail"):
            output = self.outputs[view_id]
            expected = detail_oracle(self.contract_views[view_id], self.manifest, self.meshes, policy)
            self.assertEqual(output["statistics"]["cutRegionCount"], expected["cutClosedRegionCount"])
            self.assertEqual(output["statistics"]["cutRegionCountByType"], expected["cutClosedRegionsByType"])
            self.assertEqual(output["statistics"]["materialRegionCountByCode"], expected["materialRegionsByCode"])
            self.assertEqual(output["statistics"]["cropLimitLineCount"], expected["cropLimitSegmentCount"])
            self.assertEqual(output["statistics"]["maximumMaterialOverlapAreaMm2"], 0)
            self.assertTrue(output["materialRegions"])
            self.assertTrue(output["cropLimitLines"])
            self.assertTrue(all(line["lineClass"] == "cropLimit" and line["structural"] is False for line in output["cropLimitLines"]))
            by_material: dict[str, list[Polygon]] = {}
            for region in output["materialRegions"]:
                polygon = Polygon(region["outerMm"], region["holesMm"])
                by_material.setdefault(region["materialCode"], []).append(polygon)
            material_codes = sorted(by_material)
            for index, first_code in enumerate(material_codes):
                for second_code in material_codes[index + 1 :]:
                    self.assertLessEqual(
                        max(first.intersection(second).area for first in by_material[first_code] for second in by_material[second_code]),
                        1e-6,
                    )

    def test_every_line_retains_source_transform_and_allowed_type(self) -> None:
        metadata = {entity["entityId"]: entity for entity in self.manifest["entities"]}
        for view_id, output in self.outputs.items():
            view = self.contract_views[view_id]
            detail = view["detail"]
            allowed = (
                set(detail["cutTargetTypes"]) | set(detail["depthProjectionTypes"])
                if detail["mode"] == "section-projection"
                else set(detail["visibleProjectionTypes"])
            )
            lines = [*output["cutLines"], *output["projectionLines"]]
            self.assertEqual(len(lines), len({line["lineId"] for line in lines}))
            for line in lines:
                self.assertEqual(line["sourceComponentType"], metadata[line["sourceEntityId"]]["componentType"])
                self.assertIn(line["sourceComponentType"], allowed)
                self.assertEqual(line["derivationTransform"], view["viewFrame"]["modelToView"])
                self.assertEqual(line["visibility"], "visible")
                self.assertNotEqual(line["lineClass"], "triangleEdge")
                if detail["mode"] == "section-projection" and line in output["projectionLines"]:
                    retained_low, retained_high = detail["section"]["retainedProjectionDepthMm"]
                    padding = detail["section"]["allowedPaddingMm"]
                    depths = [point[2] for point in line["sourcePointsViewMm"]]
                    self.assertGreater(max(depths), retained_low)
                    self.assertLessEqual(min(depths), retained_high + padding)

    def test_relation_scope_matches_visible_endpoints(self) -> None:
        answers = self.fixture["knownAnswers"]["viewOracle"]["views"]
        for view_id in DETAIL_VIEW_IDS:
            visible = set(answers[view_id]["requiredVisibleEntityIds"])
            for relations in answers[view_id]["requiredEntityChains"].values():
                for relation in relations:
                    endpoints = {relation["fromEntityId"], relation["toEntityId"]}
                    if relation["relationScope"] == "inView":
                        self.assertTrue(endpoints <= visible)
                    else:
                        self.assertEqual(relation["relationScope"], "crossViewContext")
                        self.assertNotIn(relation["externalEndpointEntityId"], visible)
                        self.assertIn(relation["externalEndpointEntityId"], endpoints)
                        self.assertIn(relation["continuationViewId"], {view["id"] for view in self.fixture["views"]})

    def test_generator_has_no_oracle_or_fixture_dependency(self) -> None:
        source = inspect.getsource(view_geometry.DetailViewGenerator)
        self.assertNotIn("detail_oracle", source)
        self.assertNotIn("knownAnswers", source)
        entry_source = inspect.getsource(detail_build_module)
        self.assertNotIn("detail_oracle", entry_source)
        self.assertNotIn("knownAnswers", entry_source)
        self.assertNotIn("load_fixture", entry_source)
        with self.assertRaisesRegex(ViewGeometryError, "sanitized"):
            DetailViewGenerator(self.fixture, self.manifest, self.meshes)

    def test_generation_contract_rejects_scheme_path_filename_and_hash(self) -> None:
        variants = []
        for value in (
            "external:forbidden",
            r"D:\external\case.json",
            "寺庙古建筑设计方案图.dwg",
            "一套完整的古建施工图.dwg",
            "a" * 64,
        ):
            invalid = deepcopy(self.contract)
            invalid["views"][0]["detailDependencyProbe"] = value
            variants.append(invalid)
        for index, invalid in enumerate(variants):
            with self.subTest(index=index), self.assertRaisesRegex(ViewGeometryError, "forbidden|dependency|CAD|path|scheme"):
                DetailViewGenerator(invalid, self.manifest, self.meshes)

    def test_build_is_deterministic_without_frozen_answers(self) -> None:
        expected = json.loads((DETAILS / "detail-build-record.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            actual = build_details(self.contract, MANIFEST, SOURCE_MESHES, Path(directory) / "details")
        self.assertEqual(
            [(item["viewId"], item["sha256"], item["viewGeometrySha256"]) for item in actual["outputs"]],
            [(item["viewId"], item["sha256"], item["viewGeometrySha256"]) for item in expected["outputs"]],
        )


if __name__ == "__main__":
    unittest.main()
