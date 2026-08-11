from __future__ import annotations

from copy import deepcopy
import gzip
from hashlib import sha256
import inspect
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid5

import workers.cad.t0b_v2.drawing_ir as drawing_ir_module
from workers.cad.t0b_v2.drawing_contract import (
    DRAWING_PACKAGE_REVISION_NAMESPACE,
    drawing_contract_signature,
    load_drawing_package_contract,
)
from workers.cad.t0b_v2.drawing_ir import DrawingIRError, DrawingPackageIRBuilder, build_drawing_package_ir


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CONTRACT_PATH = next(ROOT.rglob("t0b-v2-drawing-package-contract.json"))
BASE = CONTRACT_PATH.parent
OUTPUT_DIR = BASE / "t0b-v2-outputs" / "drawing-package-ir"
IR_PATH = OUTPUT_DIR / "drawing-package.ir.json.gz"
BUILD_RECORD = OUTPUT_DIR / "drawing-package-ir-build-record.json"


def _load_ir(path: Path = IR_PATH) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _resign(contract: dict) -> dict:
    contract["contractSignature"] = drawing_contract_signature(contract)
    contract["contractRevisionId"] = str(uuid5(DRAWING_PACKAGE_REVISION_NAMESPACE, contract["contractSignature"]))
    return contract


def _apply(matrix: list[list[float]], point: list[float]) -> list[float]:
    return [
        matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2],
        matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2],
    ]


class T0BV2DrawingPackageIRTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = load_drawing_package_contract(CONTRACT_PATH)
        cls.ir = _load_ir()
        cls.record = json.loads(BUILD_RECORD.read_text(encoding="utf-8"))

    def test_ir_binds_contract_and_remains_unqualified(self) -> None:
        self.assertEqual(self.ir["drawingPackageContractSignature"], self.contract["contractSignature"])
        self.assertEqual(self.ir["drawingPackageContractRevisionId"], self.contract["contractRevisionId"])
        self.assertEqual(self.ir["geometryRevisionId"], self.contract["geometryRevisionId"])
        self.assertEqual(self.ir["viewContractRevisionId"], self.contract["viewContractRevisionId"])
        self.assertEqual(self.ir["status"], "generated-not-qualified")
        self.assertIs(self.ir["L1"], False)
        self.assertEqual(self.ir["useBoundary"], ["demo-only", "not-for-formal-signoff"])
        self.assertEqual(self.record["outputsNotGenerated"], ["DXF", "SVG", "PDF", "PNG"])

    def test_ir_hash_and_build_record_are_self_consistent(self) -> None:
        payload = dict(self.ir)
        expected = payload.pop("drawingPackageIrSha256")
        actual = sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        self.assertEqual(actual, expected)
        self.assertEqual(self.record["output"]["drawingPackageIrSha256"], expected)
        self.assertEqual(self.record["output"]["sha256"], sha256(IR_PATH.read_bytes()).hexdigest())

    def test_structural_lines_are_exactly_the_ten_bound_view_lines(self) -> None:
        expected: set[tuple[str, str]] = set()
        expected_count = 0
        for binding in self.contract["viewGeometryBindings"]:
            path = BASE / Path(*binding["relativePath"].split("/"))
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                view = json.load(stream)
            lines = [*view.get("cutLines", []), *view.get("projectionLines", [])]
            expected_count += len(lines)
            expected.update((binding["viewId"], line["lineId"]) for line in lines)
        actual = {
            (stage["viewId"], line["sourceLineId"])
            for stage in self.ir["modelSpace"]["viewStages"]
            for line in stage["structuralLines"]
        }
        self.assertEqual(len(actual), expected_count)
        self.assertEqual(actual, expected)
        self.assertEqual(self.ir["statistics"]["structuralLineCount"], expected_count)

    def test_every_staged_line_roundtrips_to_view_geometry(self) -> None:
        tolerance = self.contract["modelSpacePolicy"]["inverseLineMatchToleranceMm"]
        for stage in self.ir["modelSpace"]["viewStages"]:
            inverse = stage["modelSpaceToView"]
            self.assertEqual(stage["viewToModelSpace"][0][:2], [1, 0])
            self.assertEqual(stage["viewToModelSpace"][1][:2], [0, 1])
            for line in stage["structuralLines"]:
                restored = [_apply(inverse, point) for point in line["modelSpacePointsMm"]]
                for actual, expected in zip(restored, line["viewPointsMm"]):
                    self.assertLessEqual(max(abs(actual[index] - expected[index]) for index in range(2)), tolerance)

    def test_model_space_stages_and_paper_layouts_are_closed(self) -> None:
        stages = self.ir["modelSpace"]["viewStages"]
        self.assertEqual(len(stages), 10)
        for index, first in enumerate(stages):
            for second in stages[index + 1 :]:
                a, b = first["stagedBoundsMm"], second["stagedBoundsMm"]
                self.assertTrue(a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])
        layouts = self.ir["paperSpace"]["layouts"]
        self.assertEqual([layout["layoutName"] for layout in layouts], ["T0B-01", "T0B-02"])
        self.assertTrue(all(layout["pageMm"] == [841, 594] and len(layout["viewports"]) == 5 for layout in layouts))
        self.assertTrue(all(viewport["locked"] for layout in layouts for viewport in layout["viewports"]))

    def test_line_layer_classification_and_structural_xdata_are_complete(self) -> None:
        allowed_fields = set(self.contract["provenancePolicy"]["structuralXdataFields"])
        for stage in self.ir["modelSpace"]["viewStages"]:
            for line in stage["structuralLines"]:
                self.assertEqual(set(line["xdata"]) - {"applicationId"}, allowed_fields)
                self.assertEqual(line["xdata"]["applicationId"], "GUJIAN_TRACE_V1")
                self.assertTrue(line["sourceRefs"])
                if line["visibility"] == "hidden":
                    self.assertEqual(line["layer"], "GJ-HIDDEN")
                elif line["lineClass"] == "feature":
                    self.assertEqual(line["layer"], "GJ-PROJECTION")

    def test_material_regions_only_reference_view_geometry_boundaries(self) -> None:
        source_kinds = set()
        column_hatches = set()
        material_region_count = 0
        ceramic_count = 0
        ceramic_null_source_count = 0
        patterns = self.contract["materialPolicy"]["patterns"]
        for stage in self.ir["modelSpace"]["viewStages"]:
            structural_ids = {line["cadObjectId"] for line in stage["structuralLines"]}
            for region in stage["materialRegions"]:
                material_region_count += 1
                source_kinds.add(region["sourceKind"])
                self.assertEqual(region["cadObjectType"], "HATCH")
                self.assertEqual(region["layer"], "GJ-HATCH")
                self.assertIn(region["targetHatchPatternKey"], patterns)
                self.assertEqual(region["targetHatchPatternId"], patterns[region["targetHatchPatternKey"]]["patternId"])
                self.assertIn("sourceMaterialHatch", region)
                if region["sourceKind"] == "ViewGeometry.cutRegion":
                    self.assertTrue(set(region["boundaryCadObjectIds"]) <= structural_ids)
                else:
                    self.assertTrue(region["viewOuterMm"])
                    self.assertTrue(region["modelSpaceOuterMm"])
                if stage["viewId"] == "columnBaseDetail":
                    column_hatches.add(region["targetHatchPatternKey"])
                if region["materialCode"] in {"ceramic-demo", "ceramic"}:
                    ceramic_count += 1
                    self.assertEqual(region["targetHatchPatternKey"], "ceramic")
                    self.assertEqual(region["targetHatchPatternId"], "GJ-CERAMIC-DEMO")
                    if region["sourceMaterialHatch"] is None:
                        ceramic_null_source_count += 1
        self.assertEqual(source_kinds, {"ViewGeometry.cutRegion", "ViewGeometry.materialRegion"})
        self.assertEqual(column_hatches, {"timber", "stone", "earth"})
        self.assertEqual(material_region_count, 315)
        self.assertEqual(ceramic_count, 124)
        self.assertEqual(ceramic_null_source_count, 118)

    def test_unknown_material_code_cannot_become_native_hatch(self) -> None:
        builder = DrawingPackageIRBuilder(self.contract, BASE)
        with self.assertRaisesRegex(DrawingIRError, "unknown material code"):
            builder._target_hatch("unknown-material")

    def test_annotation_and_sidecar_provenance_are_complete(self) -> None:
        annotations = self.ir["annotations"]
        self.assertEqual(len(annotations), self.ir["statistics"]["annotationRequirementCount"])
        self.assertTrue(all(item["requirementId"] and item["sourceRefs"] for item in annotations))
        self.assertTrue(all(set(item["xdata"]) == {"applicationId", "requirementId", "sourceRefs"} for item in annotations))
        ids = [row["cadObjectId"] for row in self.ir["provenanceSidecarRows"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), self.ir["statistics"]["provenanceSidecarRowCount"])
        self.assertTrue({item["cadObjectId"] for item in annotations} <= set(ids))

    def test_detail_visual_semantics_and_blockers_reach_ir(self) -> None:
        by_requirement = {item["requirementId"]: item for item in self.ir["annotations"]}
        self.assertEqual(by_requirement["DR-ED-PURLIN"]["semanticPayload"]["targetEntityId"], "2f615b6c-d3f6-5537-9179-4dca3040e20e")
        self.assertEqual(by_requirement["DR-ED-BREAK"]["semanticPayload"]["coverage"], 1.0)
        self.assertEqual(by_requirement["DR-BD-NOTE"]["semanticPayload"]["text"], "团队演示承托构造，非实测/非正式节点")
        self.assertEqual(by_requirement["DR-CB-LEVEL"]["semanticPayload"]["valuesMm"], [-800, 0, 600])
        self.assertEqual(by_requirement["DR-CB-DIM"]["semanticPayload"]["valuesMm"], [560, 400, 240, 800])
        self.assertEqual(by_requirement["DR-DW-DIM"]["semanticPayload"]["valuesMm"], [1800, 2700, 720, 1500])
        self.assertIn("BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", self.ir["qualificationBoundary"]["requiredBlockers"])
        self.assertIn("FONT_ASSET_NOT_BOUND", self.ir["qualificationBoundary"]["requiredBlockers"])

    def test_builder_imports_no_fixture_or_geometry_oracle(self) -> None:
        source = inspect.getsource(drawing_ir_module)
        self.assertNotIn("detail_oracle", source)
        self.assertNotIn("load_fixture", source)
        self.assertNotIn("source_meshes", source)
        self.assertNotIn("trimesh", source)

    def test_bound_hash_change_is_rejected_before_ir_generation(self) -> None:
        invalid = deepcopy(self.contract)
        invalid["viewGeometryBindings"][0]["fileSha256"] = "a" * 64
        invalid = _resign(invalid)
        with self.assertRaisesRegex(DrawingIRError, "file hash"):
            DrawingPackageIRBuilder(invalid, BASE).build()

    def test_two_temporary_builds_are_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = build_drawing_package_ir(CONTRACT_PATH, Path(first_dir) / "ir")
            second = build_drawing_package_ir(CONTRACT_PATH, Path(second_dir) / "ir")
        self.assertEqual(first["output"]["sha256"], second["output"]["sha256"])
        self.assertEqual(first["output"]["drawingPackageIrSha256"], second["output"]["drawingPackageIrSha256"])


if __name__ == "__main__":
    unittest.main()
