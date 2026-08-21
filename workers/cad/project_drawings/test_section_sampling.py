from __future__ import annotations

import math
import unittest

import cadquery as cq
import numpy as np

from .view_geometry import _ocp_section_segments


def _cut_cylinder(radius: float, tolerance_mm: float) -> list[np.ndarray]:
    shape = cq.Workplane("YZ").circle(radius).extrude(600).val()
    return _ocp_section_segments(shape, np.array([1.0, 0.0, 0.0]), 300.0, tolerance_mm)


class SectionSamplingTests(unittest.TestCase):
    """剖切面上的曲线按弦高采样，不按弧长。

    容差是弦高。按弧长每 0.5 mm 取一点会把半径 130 mm 的檩切面拆成
    一千六百多段，七条檩就是一万一千多条图线，DXF 与图纸中间表示随之
    膨胀到几十兆，出图时间也跟着上去。弦高采样精度相同，段数少四十倍。
    """

    def test_circle_segment_count_follows_chord_height_not_arc_length(self) -> None:
        radius, tolerance = 130.0, 0.5
        segments = _cut_cylinder(radius, tolerance)
        arc_length_count = int(math.ceil(2 * math.pi * radius / tolerance))
        # 按弦高算的理论段数：每段圆心角 2*acos(1 - t/r)
        chord_count = math.ceil(2 * math.pi / (2 * math.acos(1 - tolerance / radius)))
        self.assertLess(len(segments), arc_length_count / 10)
        self.assertLessEqual(len(segments), chord_count * 3)
        self.assertGreaterEqual(len(segments), chord_count // 2)

    def test_sampled_polyline_stays_within_the_declared_chord_height(self) -> None:
        radius, tolerance = 130.0, 0.5
        segments = _cut_cylinder(radius, tolerance)
        self.assertTrue(segments)
        worst = 0.0
        for segment in segments:
            first, last = segment[0], segment[1]
            middle = (first + last) / 2
            # 切面在 x = 300 的平面上，圆心在 (300, 0, 0)
            distance = math.hypot(middle[1], middle[2])
            worst = max(worst, radius - distance)
        self.assertLessEqual(worst, tolerance * 1.5)

    def test_段数随容差放宽而减少(self) -> None:
        fine = _cut_cylinder(130.0, 0.5)
        coarse = _cut_cylinder(130.0, 2.0)
        self.assertLess(len(coarse), len(fine))

    def test_直线剖切边仍然只出一段(self) -> None:
        shape = cq.Workplane("XY").box(400, 400, 400).val()
        segments = _ocp_section_segments(shape, np.array([0.0, 0.0, 1.0]), 0.0, 0.5)
        self.assertEqual(len(segments), 4)




class BeyondPlaneTests(unittest.TestCase):
    """剖切面之外的可见投影必须画出来。

    只画剖切线时，平面上只剩几个柱截面，剖面上看不到后面那一榀的梁架，
    两类图都不成图。这里锁的是"剖切面与观察者之间的构件被移除、
    之外的构件保留"这条判定。
    """

    def setUp(self) -> None:
        from .view_geometry import SourceMesh, _is_beyond_plane
        self.judge = _is_beyond_plane
        self.make = lambda zmin, zmax: SourceMesh(
            "id", "column",
            np.array([[0.0, 0.0, zmin], [1.0, 0.0, zmin], [0.0, 1.0, zmax]]),
            np.array([[0, 1, 2]]), None,
        )

    def test_俯视时剖切面以下的构件保留(self) -> None:
        normal = np.array([0.0, 0.0, 1.0])
        origin = normal * 1800.0
        looking_down = np.array([0.0, 0.0, -1.0])
        self.assertTrue(self.judge(self.make(0.0, 600.0), normal, origin, looking_down))

    def test_俯视时剖切面以上的构件移除(self) -> None:
        normal = np.array([0.0, 0.0, 1.0])
        origin = normal * 1800.0
        looking_down = np.array([0.0, 0.0, -1.0])
        self.assertFalse(self.judge(self.make(3000.0, 4000.0), normal, origin, looking_down))

    def test_跨过剖切面的构件保留(self) -> None:
        normal = np.array([0.0, 0.0, 1.0])
        origin = normal * 1800.0
        looking_down = np.array([0.0, 0.0, -1.0])
        self.assertTrue(self.judge(self.make(900.0, 3700.0), normal, origin, looking_down))


if __name__ == "__main__":
    unittest.main()
