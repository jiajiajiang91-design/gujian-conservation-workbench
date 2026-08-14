from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path

import ezdxf
from PIL import Image

from workers.cad.project_geometry.kernel import build_geometry_package
from workers.cad.project_geometry.test_project_geometry import spec_a, spec_b

from .build_package import build_package
from .contracts import DrawingContractError, validate_artifact_matrix


ROOT = Path(__file__).resolve().parents[3]
FONT = ROOT / "workers" / "cad" / "t0b_v2" / "assets" / "fonts" / "noto-sans-sc" / "GujianSansSC-Regular.ttf"
NS = uuid.UUID("778f5091-5081-5f1f-a2b1-556366f441ea")


def uid(label: str) -> str:
    return str(uuid.uuid5(NS, label))


def matrix(spec: dict, manifest: dict, variant: str) -> dict:
    if variant == "one-sheet":
        sheet = uid("sheet:a")
        views = [
            {"id": uid("view:a:plan"), "key": "plan", "displayLabelZh": "平面图", "drawingRef": "平-01", "kind": "floorPlan", "scaleDenominator": 20, "sheetId": sheet, "viewportRectMm": [20, 60, 360, 220], "direction": [0, 0, 1], "right": [1, 0, 0], "up": [0, 1, 0], "sectionPlane": {"normal": [0, 0, 1], "offsetMm": 500}, "sourceTypes": []},
            {"id": uid("view:a:elevation"), "key": "elevation", "displayLabelZh": "正立面图", "drawingRef": "立-01", "kind": "elevation", "scaleDenominator": 20, "sheetId": sheet, "viewportRectMm": [420, 60, 390, 220], "direction": [0, 1, 0], "right": [1, 0, 0], "up": [0, 0, 1], "sourceTypes": []},
        ]
        sheets = [{"id": sheet, "drawingNumber": "P-01", "displayLabelZh": "平面与立面", "pageMm": [841, 594], "viewIds": [item["id"] for item in views]}]
    else:
        first, second = uid("sheet:b:1"), uid("sheet:b:2")
        views = [
            {"id": uid("view:b:axon"), "key": "axon", "displayLabelZh": "轴测图", "drawingRef": "轴-01", "kind": "axonometric", "scaleDenominator": 20, "sheetId": first, "viewportRectMm": [20, 60, 360, 230], "direction": [-0.5773502692, -0.5773502692, -0.5773502692], "right": [0.7071067812, -0.7071067812, 0], "up": [-0.4082482905, -0.4082482905, 0.8164965809], "sourceTypes": []},
            {"id": uid("view:b:section"), "key": "section", "displayLabelZh": "横剖面图", "drawingRef": "剖-01", "kind": "transverseSection", "scaleDenominator": 20, "sheetId": second, "viewportRectMm": [20, 60, 360, 230], "direction": [1, 0, 0], "right": [0, 1, 0], "up": [0, 0, 1], "sectionPlane": {"normal": [1, 0, 0], "offsetMm": 0}, "sourceTypes": []},
        ]
        sheets = [
            {"id": first, "drawingNumber": "P-11", "displayLabelZh": "轴测", "pageMm": [594, 420], "viewIds": [views[0]["id"]]},
            {"id": second, "drawingNumber": "P-12", "displayLabelZh": "剖面", "pageMm": [594, 420], "viewIds": [views[1]["id"]]},
        ]
    return {
        "schemaVersion": "1.0", "id": uid(f"matrix:{variant}"), "projectId": spec["projectId"], "projectRevisionId": spec["projectRevisionId"],
        "geometryRevisionId": manifest["geometryRevisionId"], "titleZh": "项目驱动代理成果", "buildingDisplayNameZh": "测试对象",
        "issueState": "proxy-unissued", "issueDate": None, "revisionLabel": "P01", "views": views, "sheets": sheets,
        "observationCandidates": [{"id": uid(f"condition:{variant}"), "targetEntityId": spec["objects"][0]["id"], "displayLabelZh": "表面状态待现场核对", "reviewStatus": "unreviewed", "producerType": "demo"}],
        "createdAt": "2026-08-13T12:00:00.000Z",
    }


class ProjectDrawingTests(unittest.TestCase):
    def test_two_different_task_matrices_generate_native_cross_format_artifacts(self) -> None:
        self.assertTrue(FONT.is_file(), "bound OFL font must be generated before drawing tests")
        with tempfile.TemporaryDirectory() as temp:
            for index, (spec, variant) in enumerate(((spec_a(), "one-sheet"), (spec_b(), "two-sheet"))):
                root = Path(temp) / str(index)
                geometry = root / "geometry"
                manifest = build_geometry_package(spec, geometry)
                requirement = matrix(spec, manifest, variant)
                record = build_package(requirement, geometry, FONT, root / "drawings")
                self.assertEqual(record["viewCount"], 2)
                self.assertEqual(record["sheetCount"], 1 if variant == "one-sheet" else 2)
                self.assertFalse(record["l1Eligible"])
                doc = ezdxf.readfile(root / "drawings" / "drawings.dxf")
                self.assertFalse(doc.audit().errors)
                types = {entity.dxftype() for entity in doc.modelspace()}
                self.assertTrue({"LINE", "DIMENSION", "TEXT", "MTEXT", "INSERT"}.issubset(types))
                self.assertTrue({"GJ-DASHED", "GJ-CENTER"}.issubset({item.dxf.name for item in doc.linetypes}))
                self.assertEqual(doc.layers.get("GJ-CONDITION").dxf.linetype, "GJ-DASHED")
                self.assertEqual(doc.layers.get("GJ-AXIS").dxf.linetype, "GJ-CENTER")
                self.assertIn("GJ-CONDITION", doc.layers)
                layouts = [item for item in doc.layouts.names() if item != "Model"]
                self.assertEqual(len(layouts), record["sheetCount"])
                self.assertTrue(all(any(item.dxf.flags & 0x4000 for item in doc.layouts.get(name).query("VIEWPORT") if item.dxf.id > 1) for name in layouts))
                for asset in record["assets"]:
                    self.assertTrue((root / "drawings" / asset["fileName"]).is_file())
                for sheet in requirement["sheets"]:
                    with Image.open(root / "drawings" / f"{sheet['drawingNumber']}.png") as image:
                        self.assertAlmostEqual(image.info["dpi"][0], 300, places=2)
                        self.assertEqual(image.size, (round(sheet["pageMm"][0] * 300 / 25.4), round(sheet["pageMm"][1] * 300 / 25.4)))

    def test_contract_rejects_internal_labels_fake_dates_and_overlaps(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            source = spec_a()
            manifest = build_geometry_package(source, Path(temp) / "geometry")
            base = matrix(source, manifest, "one-sheet")
            for mutation in ("internal", "date", "overlap"):
                invalid = copy.deepcopy(base)
                if mutation == "internal": invalid["views"][0]["drawingRef"] = "targetViewId"
                elif mutation == "date": invalid["issueDate"] = "2000-01-01"
                else: invalid["views"][1]["viewportRectMm"] = invalid["views"][0]["viewportRectMm"]
                with self.assertRaises(DrawingContractError, msg=mutation):
                    validate_artifact_matrix(invalid, manifest)

    def test_same_inputs_build_byte_identical_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = spec_a()
            geometry = root / "geometry"
            manifest = build_geometry_package(source, geometry)
            requirement = matrix(source, manifest, "one-sheet")
            first = root / "first"
            second = root / "second"
            build_package(requirement, geometry, FONT, first)
            build_package(requirement, geometry, FONT, second)
            first_files = sorted(path.relative_to(first) for path in first.rglob("*") if path.is_file())
            second_files = sorted(path.relative_to(second) for path in second.rglob("*") if path.is_file())
            self.assertEqual(first_files, second_files)
            for relative in first_files:
                left = hashlib.sha256((first / relative).read_bytes()).hexdigest()
                right = hashlib.sha256((second / relative).read_bytes()).hexdigest()
                self.assertEqual(left, right, str(relative))


if __name__ == "__main__":
    unittest.main()
