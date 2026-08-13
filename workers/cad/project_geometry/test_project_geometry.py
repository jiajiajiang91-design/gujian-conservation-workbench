from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from .contracts import ContractError, geometry_spec_input_hash, validate_geometry_spec
from .kernel import build_geometry_package

import ifcopenshell
import numpy as np
import trimesh


def uid(label: str) -> str:
    return str(uuid.uuid5(uuid.UUID("58267a52-9db9-55fc-af7d-f712c2f0ea98"), label))


def parameter(label: str, name: str, value_type: str, value: str | int, unit: str) -> dict:
    result = {
        "id": uid(f"parameter:{label}"), "name": name, "valueType": value_type, "unit": unit,
        "basis": "demo", "factRefs": [], "evidenceRefs": [],
    }
    if value_type == "count":
        result["value"] = value
    elif value_type == "text":
        result["value"] = value
    else:
        result["exactValue"] = value
    return result


def box(label: str, center: list[float], sizes: list[str], component_type: str) -> dict:
    object_id = uid(f"object:{label}")
    return {
        "id": object_id, "stableKey": label, "parentId": None, "componentType": component_type,
        "displayNameZh": label, "materialCode": "team-demo", "solid": {
            "kind": "box", "sizeX": sizes[0], "sizeY": sizes[1], "sizeZ": sizes[2], "centerMm": center,
        },
        "parameters": [parameter(f"{label}:height", "高度", "length", sizes[2], "mm")],
        "producer": {"producerType": "demo", "fixtureId": "project-kernel-contract"},
        "factRefs": [], "evidenceRefs": [], "unknownRefs": [],
    }


def cylinder(label: str, center: list[float], radius: str, height: str) -> dict:
    return {
        "id": uid(f"object:{label}"), "stableKey": label, "parentId": None, "componentType": "column",
        "displayNameZh": label, "materialCode": "team-demo", "solid": {
            "kind": "cylinder", "radius": radius, "height": height, "axis": "z", "centerMm": center,
        },
        "parameters": [parameter(f"{label}:count", "数量", "count", 1, "1")],
        "producer": {"producerType": "demo", "fixtureId": "project-kernel-contract"},
        "factRefs": [], "evidenceRefs": [], "unknownRefs": [],
    }


def spec_a() -> dict:
    column = cylinder("圆柱", [0, 0, 500], "150", "1000")
    beam = box("横梁", [0, 0, 1100], ["1600", "240", "200"], "beam")
    value = {
        "schemaVersion": "2.0", "id": uid("spec:a"), "projectId": uid("project:a"),
        "projectRevisionId": uid("revision:a"), "buildingId": uid("building:a"), "inputHash": "0" * 64,
        "coordinateSystem": {"name": "项目局部坐标", "axisOrder": "XYZ", "upAxis": "Z", "lengthUnit": "mm", "origin": [0, 0, 0]},
        "tolerances": {"modellingMm": 0.01, "interfaceMm": 0.5, "tessellationMm": 0.5},
        "objects": [column, beam], "interfaces": [{
            "id": uid("interface:a"), "fromObjectId": column["id"], "toObjectId": beam["id"],
            "interfaceType": "bearing", "fromSurface": "zMax", "toSurface": "zMin", "direction": [0, 0, 1],
            "maximumGapMm": 0.01, "maximumUnexpectedOverlapMm3": 0, "minimumDeclaredOverlapMm3": None,
            "factRefs": [], "evidenceRefs": [],
        }], "unknowns": [{
            "id": uid("unknown:a"), "subjectRef": column["id"], "reasonCode": "MATERIAL_UNCONFIRMED",
            "description": "材料只用于团队演示", "requiredEvidence": ["现场材质记录"], "affectedRefs": [column["id"]],
            "evidenceRefs": [], "blocksProxyOutcome": False, "blocksFormalEligibility": True,
        }], "createdAt": "2026-08-13T12:00:00.000Z",
    }
    value["objects"][0]["unknownRefs"] = [value["unknowns"][0]["id"]]
    value["inputHash"] = geometry_spec_input_hash(value)
    return value


def spec_b() -> dict:
    base = box("方台", [0, 0, 100], ["1200", "1000", "200"], "base")
    posts = [cylinder(f"柱-{index + 1}", [x, 0, 600], "100", "800") for index, x in enumerate((-350, 0, 350))]
    interfaces = [{
        "id": uid(f"interface:b:{index}"), "fromObjectId": base["id"], "toObjectId": post["id"],
        "interfaceType": "contact", "fromSurface": "zMax", "toSurface": "zMin", "direction": [0, 0, 1],
        "maximumGapMm": 0.01, "maximumUnexpectedOverlapMm3": 0, "minimumDeclaredOverlapMm3": None,
        "factRefs": [], "evidenceRefs": [],
    } for index, post in enumerate(posts)]
    value = {
        "schemaVersion": "2.0", "id": uid("spec:b"), "projectId": uid("project:b"),
        "projectRevisionId": uid("revision:b"), "buildingId": uid("building:b"), "inputHash": "0" * 64,
        "coordinateSystem": {"name": "项目局部坐标", "axisOrder": "XYZ", "upAxis": "Z", "lengthUnit": "mm", "origin": [0, 0, 0]},
        "tolerances": {"modellingMm": 0.01, "interfaceMm": 0.5, "tessellationMm": 0.5},
        "objects": [base, *posts], "interfaces": interfaces, "unknowns": [], "createdAt": "2026-08-13T12:00:00.000Z",
    }
    value["inputHash"] = geometry_spec_input_hash(value)
    return value


class ProjectGeometryTests(unittest.TestCase):
    def test_two_different_project_specs_build_complete_revision_packages(self) -> None:
        signatures: set[str] = set()
        counts: list[int] = []
        with tempfile.TemporaryDirectory() as temp:
            for index, source in enumerate((spec_a(), spec_b())):
                output = Path(temp) / f"out-{index}"
                result = build_geometry_package(source, output)
                signatures.add(result["geometrySignature"])
                counts.append(len(result["entities"]))
                self.assertFalse(result["l1Eligible"])
                self.assertEqual({item["kind"] for item in result["assets"]}, {"ifc", "glb", "manifest", "sourceMap", "report", "preview"})
                self.assertEqual(len(ifcopenshell.open(output / "model.ifc").by_type("IfcBuildingElementProxy")), len(source["objects"]))
                scene = trimesh.load(output / "model.glb", force="scene", process=False)
                self.assertEqual(len(scene.geometry), len(source["objects"]))
                by_type = {item["componentType"]: item["id"] for item in source["objects"]}
                if "base" in by_type:
                    self.assertEqual(int(np.argmin(scene.geometry[by_type["base"]].extents)), 1, "base thickness must be Y-up")
                self.assertEqual(int(np.argmax(scene.geometry[by_type["column"]].extents)), 1, "vertical member must be Y-up")
                self.assertTrue(all(item["passed"] for item in result["interfaces"]))
        self.assertEqual(signatures.__len__(), 2)
        self.assertEqual(counts, [2, 4])

    def test_build_is_deterministic_for_frozen_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            left = Path(temp) / "left"
            right = Path(temp) / "right"
            first = build_geometry_package(spec_a(), left)
            second = build_geometry_package(spec_a(), right)
            self.assertEqual(first, second)
            for name in ("model.glb", "model.ifc", "source-map.ndjson", "geometry-report.json", "preview.png", "manifest.json"):
                self.assertEqual((left / name).read_bytes(), (right / name).read_bytes(), name)

    def test_contract_rejects_wrong_units_and_arbitrary_external_inputs(self) -> None:
        wrong_unit = spec_a()
        wrong_unit["objects"][0]["parameters"][0]["unit"] = "mm"
        with self.assertRaises(ContractError):
            validate_geometry_spec(wrong_unit)
        external = spec_a()
        external["objects"][0]["evidenceRefs"] = ["D:/Downloads/reference.dwg"]
        external["inputHash"] = geometry_spec_input_hash(external)
        with self.assertRaises(ContractError):
            validate_geometry_spec(external)

    def test_interface_gap_and_overlap_are_geometry_failures(self) -> None:
        moved = spec_a()
        moved["objects"][1]["solid"]["centerMm"][2] += 10
        moved["inputHash"] = geometry_spec_input_hash(moved)
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(ValueError, "interface gap"):
            build_geometry_package(moved, Path(temp) / "out")


if __name__ == "__main__":
    unittest.main()
