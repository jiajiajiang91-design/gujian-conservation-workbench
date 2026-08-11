from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from hashlib import sha256
import gzip
import inspect
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import ezdxf
from ezdxf import const

import workers.cad.t0b_v2.generate_dxf as generate_dxf_module
from workers.cad.t0b_v2.generate_dxf import (
    APPID,
    BUILD_RECORD_NAME,
    DXFGenerationError,
    DXF_NAME,
    NativeDXFGenerator,
    SIDECAR_NAME,
    _validate_pattern_definition,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CONTRACT_PATH = next(ROOT.rglob("t0b-v2-drawing-package-contract.json"))
BASE = CONTRACT_PATH.parent
IR_PATH = BASE / "t0b-v2-outputs" / "drawing-package-ir" / "drawing-package.ir.json.gz"
MANIFEST_PATH = BASE / "t0b-v2-outputs" / "geometry-manifest.json"
FONT_CONFIG_PATH = HERE / "logical_font_config.json"
OUTPUT_DIR = BASE / "t0b-v2-outputs" / "native-dxf"
DXF_PATH = OUTPUT_DIR / DXF_NAME
SIDECAR_PATH = OUTPUT_DIR / SIDECAR_NAME
RECORD_PATH = OUTPUT_DIR / BUILD_RECORD_NAME


def _load_ir() -> dict:
    with gzip.open(IR_PATH, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _load_sidecar(path: Path = SIDECAR_PATH) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def _xdata(entity) -> dict[str, object]:
    result: dict[str, object] = {}
    for tag in entity.get_xdata(APPID):
        key, value = tag.value.split("=", 1)
        if key in result:
            previous = result[key]
            result[key] = [*previous, value] if isinstance(previous, list) else [previous, value]
        else:
            result[key] = value
    return result


def _flatten_values(value: object) -> list[float]:
    if isinstance(value, dict):
        return [float(value[key]) for key in sorted(value)]
    return [float(item) for item in value]


class T0BV2NativeDXFGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        cls.ir = _load_ir()
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        cls.font = json.loads(FONT_CONFIG_PATH.read_text(encoding="utf-8"))
        cls.doc = ezdxf.readfile(DXF_PATH)
        cls.record = json.loads(RECORD_PATH.read_text(encoding="utf-8"))
        cls.sidecar = _load_sidecar()
        cls.sidecar_by_cad_id = {row["cadObjectId"]: row for row in cls.sidecar}

    def test_build_record_hashes_inputs_outputs_and_keeps_qualification_blockers(self) -> None:
        self.assertEqual(self.record["status"], "generated-not-qualified")
        self.assertIs(self.record["L1"], False)
        self.assertEqual(self.record["useBoundary"], ["demo-only", "not-for-formal-signoff"])
        self.assertEqual(self.record["inputs"]["contract"]["signature"], self.contract["contractSignature"])
        self.assertEqual(self.record["inputs"]["drawingPackageIr"]["drawingPackageIrSha256"], self.ir["drawingPackageIrSha256"])
        self.assertEqual(self.record["inputs"]["manifest"]["sha256"], sha256(MANIFEST_PATH.read_bytes()).hexdigest())
        self.assertEqual(self.record["outputs"]["dxf"]["sha256"], sha256(DXF_PATH.read_bytes()).hexdigest())
        self.assertEqual(self.record["outputs"]["provenanceSidecar"]["sha256"], sha256(SIDECAR_PATH.read_bytes()).hexdigest())
        blockers = set(self.record["qualification"]["requiredBlockers"])
        self.assertIn("FONT_ASSET_NOT_BOUND", blockers)
        self.assertIn("BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", blockers)
        self.assertFalse(self.record["qualification"]["generatorMaySetEligible"])
        self.assertEqual(self.record["outputsNotGenerated"], ["SVG", "PDF", "PNG"])
        self.assertEqual(self.record["autocadCompatibility"]["earthPatternLineOffsetsMm"], [[0, 24], [24, 0]])
        self.assertTrue(self.record["autocadCompatibility"]["parallelPatternOffsetRejected"])
        self.assertEqual(self.record["autocadCompatibility"]["defaultPaperViewportLayer"], "0")

    def test_r2018_model_space_is_one_to_one_millimetres(self) -> None:
        self.assertEqual(self.doc.dxfversion, "AC1032")
        self.assertEqual(self.doc.header["$INSUNITS"], 4)
        self.assertEqual(self.record["outputs"]["dxf"]["modelSpaceScale"], "1:1")
        self.assertEqual(self.record["readback"]["structuralXdataCoverage"], 1.0)
        self.assertEqual(self.record["readback"]["ezdxfAuditErrors"], 0)

    def test_exactly_two_a1_layouts_have_five_locked_user_viewports_each(self) -> None:
        self.assertEqual(set(self.doc.layouts.names()), {"Model", "T0B-01", "T0B-02"})
        expected = {layout["layoutName"]: layout for layout in self.ir["paperSpace"]["layouts"]}
        for name in ("T0B-01", "T0B-02"):
            layout = self.doc.layouts.get(name)
            low, high = layout.get_paper_limits()
            self.assertAlmostEqual(high.x - low.x, 841.0)
            self.assertAlmostEqual(high.y - low.y, 594.0)
            viewports = [item for item in layout.query("VIEWPORT") if item.dxf.id > 1]
            default_viewports = [item for item in layout.query("VIEWPORT") if item.dxf.id == 1]
            self.assertEqual(len(default_viewports), 1)
            self.assertEqual(default_viewports[0].dxf.layer, "0")
            self.assertEqual(len(viewports), 5)
            for viewport, frozen in zip(sorted(viewports, key=lambda item: item.dxf.id), expected[name]["viewports"]):
                self.assertTrue(viewport.dxf.flags & const.VSF_VIEWPORT_ZOOM_LOCKING)
                self.assertEqual(viewport.dxf.layer, "GJ-FRAME")
                self.assertAlmostEqual(viewport.dxf.width, frozen["paperRectMm"][2])
                self.assertAlmostEqual(viewport.dxf.height, frozen["paperRectMm"][3])
                self.assertAlmostEqual(viewport.dxf.view_height, frozen["paperRectMm"][3] / frozen["paperScale"], places=3)

    def test_all_ir_structural_lines_roundtrip_without_recomputation(self) -> None:
        expected_lines = [line for stage in self.ir["modelSpace"]["viewStages"] for line in stage["structuralLines"]]
        self.assertEqual(len(expected_lines), 51114)
        required_xdata = {"sourceEntityId", "geometryRevisionId", "viewContractRevisionId", "viewId", "derivation", "derivationTransform"}
        for line in expected_lines:
            row = self.sidecar_by_cad_id[line["cadObjectId"]]
            entity = self.doc.entitydb[row["handle"]]
            self.assertEqual(entity.dxftype(), line["cadObjectType"])
            self.assertEqual(entity.dxf.layer, line["layer"])
            if entity.dxftype() == "LINE":
                actual = [[entity.dxf.start.x, entity.dxf.start.y], [entity.dxf.end.x, entity.dxf.end.y]]
            else:
                actual = [[point[0], point[1]] for point in entity.get_points("xy")]
            self.assertEqual(len(actual), len(line["modelSpacePointsMm"]))
            for actual_point, expected_point in zip(actual, line["modelSpacePointsMm"]):
                self.assertAlmostEqual(actual_point[0], expected_point[0], places=8)
                self.assertAlmostEqual(actual_point[1], expected_point[1], places=8)
            xdata = _xdata(entity)
            self.assertEqual(xdata["cadObjectId"], line["cadObjectId"])
            self.assertTrue(required_xdata <= set(xdata))
            self.assertEqual(xdata["sourceEntityId"], line["sourceEntityId"])
            self.assertEqual(xdata["geometryRevisionId"], self.ir["geometryRevisionId"])
            self.assertEqual(xdata["viewContractRevisionId"], self.ir["viewContractRevisionId"])
            self.assertEqual(xdata["viewId"], line["viewId"])

    def test_all_material_regions_are_native_hatches_with_ir_boundaries_and_patterns(self) -> None:
        regions = [region for stage in self.ir["modelSpace"]["viewStages"] for region in stage["materialRegions"]]
        self.assertEqual(len(regions), 315)
        target_counts = Counter()
        for region in regions:
            row = self.sidecar_by_cad_id[region["cadObjectId"]]
            hatch = self.doc.entitydb[row["handle"]]
            self.assertEqual(hatch.dxftype(), "HATCH")
            self.assertEqual(hatch.dxf.layer, "GJ-HATCH")
            self.assertEqual(hatch.dxf.pattern_name, region["targetHatchPatternId"])
            self.assertGreaterEqual(len(hatch.paths), 1)
            self.assertTrue(hatch.has_xdata(APPID))
            for line in hatch.pattern.lines:
                radians = math.radians(float(line.angle))
                perpendicular_component = math.cos(radians) * line.offset.y - math.sin(radians) * line.offset.x
                self.assertGreater(abs(perpendicular_component), 1e-9)
            if hatch.dxf.pattern_name == "GJ_EARTH_V1":
                self.assertEqual([(line.offset.x, line.offset.y) for line in hatch.pattern.lines], [(0.0, 24.0), (24.0, 0.0)])
            target_counts[region["targetHatchPatternId"]] += 1
        self.assertEqual(target_counts, Counter({"GJ_TIMBER_V1": 144, "GJ-CERAMIC-DEMO": 124, "GJ_EARTH_V1": 26, "GJ_STONE_V1": 21}))

    def test_parallel_hatch_offset_is_rejected_before_dxf_write(self) -> None:
        invalid = [(90.0, (12.0, 0.0), (0.0, 24.0), [0.0, -8.0])]
        with self.assertRaisesRegex(DXFGenerationError, "parallel"):
            _validate_pattern_definition(invalid)

    def test_annotations_are_native_and_close_every_ir_requirement(self) -> None:
        rows_by_requirement: dict[str, list[dict]] = defaultdict(list)
        for row in self.sidecar:
            requirement = row["provenance"].get("requirementId")
            if requirement:
                rows_by_requirement[requirement].append(row)
        expected = {item["requirementId"] for item in self.ir["annotations"]}
        self.assertTrue(expected <= set(rows_by_requirement))
        native_types = Counter()
        for requirement_id in expected:
            for row in rows_by_requirement[requirement_id]:
                entity = self.doc.entitydb[row["handle"]]
                native_types[entity.dxftype()] += 1
                xdata = _xdata(entity)
                self.assertEqual(xdata["requirementId"], requirement_id)
                self.assertIn("sourceRefs", xdata)
        self.assertGreater(native_types["DIMENSION"], 0)
        self.assertGreater(native_types["MTEXT"], 0)
        self.assertGreater(native_types["INSERT"], 0)
        self.assertTrue(all(entity.dxf.text in {"", "<>"} for entity in self.doc.modelspace().query("DIMENSION")))

    def test_four_detail_hard_gates_are_present_as_native_objects(self) -> None:
        rows_by_requirement: dict[str, list[dict]] = defaultdict(list)
        for row in self.sidecar:
            requirement = row["provenance"].get("requirementId")
            if requirement:
                rows_by_requirement[requirement].append(row)

        text_values = [entity.text for entity in self.doc.modelspace().query("MTEXT")]
        self.assertIn("团队演示承托构造，非实测/非正式节点", text_values)
        self.assertIn("上檩（团队演示构件）", text_values)
        for label in ("frame", "leaf", "lattice"):
            self.assertIn(label, text_values)

        def measurements(requirement_id: str) -> list[float]:
            return sorted(round(self.doc.entitydb[row["handle"]].get_measurement(), 6) for row in rows_by_requirement[requirement_id])

        self.assertEqual(measurements("DR-CB-DIM"), [240.0, 400.0, 560.0, 800.0])
        self.assertEqual(measurements("DR-DW-DIM"), [720.0, 1500.0, 1800.0, 2700.0])
        self.assertEqual(measurements("DR-ED-DIM"), [18.0, 100.0, 260.0])
        self.assertEqual(measurements("DR-BD-DIM"), [360.0, 520.0, 1100.0])

        for requirement_id in ("DR-CB-LEVEL", "DR-DW-LEVEL", "DR-ED-LEVEL", "DR-BD-LEVEL"):
            inserts = [self.doc.entitydb[row["handle"]] for row in rows_by_requirement[requirement_id] if row["dxftype"] == "INSERT"]
            self.assertTrue(inserts)
            self.assertTrue(all(entity.dxf.name == "GJ_LEVEL_MARK" for entity in inserts))
        for requirement_id in ("DR-ED-BREAK", "DR-BD-BREAK"):
            self.assertTrue(rows_by_requirement[requirement_id])
            self.assertTrue(all(self.doc.entitydb[row["handle"]].dxf.name == "GJ_BREAK_SYMBOL" for row in rows_by_requirement[requirement_id]))

        region_by_id = {
            region["cadObjectId"]: region
            for stage in self.ir["modelSpace"]["viewStages"]
            if stage["viewId"] == "columnBaseDetail"
            for region in stage["materialRegions"]
        }
        self.assertEqual({region["targetHatchPatternKey"] for region in region_by_id.values()}, {"timber", "stone", "earth"})

    def test_paper_frames_title_blocks_viewports_and_sidecar_have_system_provenance(self) -> None:
        system_rows = [row for row in self.sidecar if row["objectClass"].startswith("system-")]
        self.assertEqual(Counter(row["objectClass"] for row in system_rows)["system-paper-frame"], 2)
        self.assertEqual(Counter(row["objectClass"] for row in system_rows)["system-viewport"], 10)
        title_rows = [row for row in self.sidecar if row["dxftype"] == "INSERT" and row["provenance"].get("requirementId") in {"DR-TB-01", "DR-TB-02"}]
        self.assertEqual(len(title_rows), 2)
        self.assertTrue(all(self.doc.entitydb[row["handle"]].dxftype() == "INSERT" for row in title_rows))
        for layout_name in ("T0B-01", "T0B-02"):
            self.assertEqual(len(self.doc.layouts.get(layout_name).query('INSERT[name=="GJ_TITLEBLOCK"]')), 1)

    def test_logical_font_is_unbound_and_external_assets_are_absent(self) -> None:
        self.assertEqual(self.record["inputs"]["logicalFont"]["family"], "Noto Sans SC")
        self.assertEqual(self.record["inputs"]["logicalFont"]["assetStatus"], "unbound")
        self.assertIsNone(self.record["inputs"]["logicalFont"]["fontFilePath"])
        self.assertEqual({style.dxf.font for style in self.doc.styles}, {"Noto Sans SC"})
        forbidden_types = {
            entity.dxftype()
            for entity in self.doc.entitydb.values()
            if any(token in entity.dxftype().upper() for token in ("IMAGE", "UNDERLAY", "PROXY"))
        }
        self.assertFalse(forbidden_types)
        self.assertFalse([block.name for block in self.doc.blocks if int(block.block.dxf.flags) & (4 | 8 | 16 | 32)])
        raw = DXF_PATH.read_text(encoding="utf-8", errors="ignore").lower()
        for token in (".dwg", "downloads", "寺庙古建筑设计方案图", "一套完整的古建施工图"):
            self.assertNotIn(token, raw)
        self.assertIsNone(re.search(r"[a-z]:[/\\]", raw))

    def test_generator_does_not_import_or_read_forbidden_geometry_sources(self) -> None:
        source = inspect.getsource(generate_dxf_module)
        for token in ("load_fixture", "detail_oracle", "view_geometry", "knownAnswers", "trimesh", "source_meshes"):
            self.assertNotIn(token, source)
        self.assertNotIn(".dwg", source.lower().replace('".dwg"', ""))

    def test_absolute_or_bound_font_asset_configuration_is_rejected(self) -> None:
        invalid = deepcopy(self.font)
        invalid["fontFilePath"] = "C:/Windows/Fonts/forbidden.ttf"
        invalid["assetStatus"] = "bound"
        with self.assertRaisesRegex(DXFGenerationError, "font"):
            NativeDXFGenerator(self.contract, self.ir, self.manifest, invalid)

    def test_two_temporary_builds_are_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as first_root, tempfile.TemporaryDirectory() as second_root:
            first = Path(first_root) / "native-dxf"
            second = Path(second_root) / "native-dxf"
            command = [
                sys.executable,
                "-m",
                "workers.cad.t0b_v2.generate_dxf",
                "--contract",
                str(CONTRACT_PATH),
                "--ir",
                str(IR_PATH),
                "--manifest",
                str(MANIFEST_PATH),
                "--font-config",
                str(FONT_CONFIG_PATH),
                "--output-dir",
            ]
            subprocess.run([*command, str(first)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
            subprocess.run([*command, str(second)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
            for name in (DXF_NAME, SIDECAR_NAME, BUILD_RECORD_NAME):
                self.assertEqual(sha256((first / name).read_bytes()).hexdigest(), sha256((second / name).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
