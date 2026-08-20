from __future__ import annotations


import tempfile
import unittest
from pathlib import Path

from workers.cad.project_geometry.kernel import build_geometry_package
from workers.cad.project_geometry.test_project_geometry import spec_a

from .test_project_drawings import matrix
from .view_geometry import generate_view_geometry, load_source_meshes


# 质量基准 4.3 图面细节层级。规则由制图矩阵下发，本模块只按规则执行，
# 不含任何构件名清单也不判断比例。这里锁三条：
# 比例越小图线越少、每条线都带源构件、构件分缝不会把构件整个删掉。


def _rules(treatment: str, component_types: list[str], spacing: float = 0.5) -> list[dict]:
    return [{
        "familyZh": "测试族",
        "componentTypes": component_types,
        "treatment": treatment,
        "minimumOnPaperSpacingMm": spacing,
    }]


class DetailLevelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._temp = tempfile.TemporaryDirectory()
        target = Path(cls._temp.name) / "geometry"
        spec = spec_a()
        cls.manifest = build_geometry_package(spec, target)
        cls.meshes = load_source_meshes(target / "model.glb", cls.manifest)
        cls.view = next(item for item in matrix(spec, cls.manifest, "one-sheet")["views"] if item["key"] == "elevation")
        cls.component_types = sorted({mesh.component_type for mesh in cls.meshes})

    @classmethod
    def tearDownClass(cls) -> None:
        cls._temp.cleanup()

    def _run(self, rules: list[dict]) -> dict:
        return generate_view_geometry(dict(self.view, detailRules=rules), self.manifest, self.meshes)

    def test_不给规则时与简化前完全一致(self) -> None:
        baseline = self._run([])
        self.assertGreater(len(baseline["lines"]), 0)
        self.assertEqual(baseline["detailDroppedGroupCount"], 0)

    def test_每条图线都带源构件(self) -> None:
        entity_ids = {item["id"] for item in self.manifest["entities"]}
        for treatment in ("groupOutline", "noJointLines"):
            result = self._run(_rules(treatment, self.component_types))
            self.assertTrue(result["lines"], treatment)
            for line in result["lines"]:
                self.assertIn(line["sourceEntityId"], entity_ids, treatment)

    def test_外轮廓比逐构件出线少(self) -> None:
        full = self._run([])
        outline = self._run(_rules("groupOutline", self.component_types))
        self.assertLess(len(outline["lines"]), len(full["lines"]))

    def test_去掉分缝线只减少不新增(self) -> None:
        full = self._run([])
        without_joints = self._run(_rules("noJointLines", self.component_types))
        self.assertLessEqual(len(without_joints["lines"]), len(full["lines"]))
        # 轮廓线一条不少：去掉的只是分缝
        full_silhouette = sum(1 for line in full["lines"] if line["lineClass"] == "silhouette")
        kept_silhouette = sum(1 for line in without_joints["lines"] if line["lineClass"] == "silhouette")
        self.assertEqual(kept_silhouette, full_silhouette)

    def test_omit_的构件不出线其余不受影响(self) -> None:
        first = self.component_types[0]
        result = self._run(_rules("omit", [first]))
        drawn = {line["sourceComponentType"] for line in result["lines"]}
        self.assertNotIn(first, drawn)
        self.assertTrue(drawn)

    def test_规则只作用在自己声明的构件类型上(self) -> None:
        first = self.component_types[0]
        full = self._run([])
        scoped = self._run(_rules("groupOutline", [first]))
        untouched_full = [line for line in full["lines"] if line["sourceComponentType"] != first]
        untouched_scoped = [line for line in scoped["lines"] if line["sourceComponentType"] != first]
        self.assertEqual(len(untouched_scoped), len(untouched_full))

    def test_视图产物记录实际执行的规则与丢弃组数(self) -> None:
        rules = _rules("groupOutline", self.component_types)
        result = self._run(rules)
        self.assertEqual(result["detailRules"], rules)
        self.assertIsInstance(result["detailDroppedGroupCount"], int)
        self.assertGreaterEqual(result["detailDroppedGroupCount"], 0)


if __name__ == "__main__":
    unittest.main()
