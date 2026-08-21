from __future__ import annotations

import unittest

import numpy as np

from . import view_geometry
from .view_geometry import _visibility_intervals


class VisibilityIntervalTests(unittest.TestCase):
    def test_five_millimetre_occluder_splits_visible_line(self) -> None:
        segment = np.array([[0.0, 0.0], [100.0, 0.0]])
        segment_depth = np.array([10.0, 10.0])
        occluder = np.array([[47.5, -10.0], [52.5, -10.0], [50.0, 10.0]])
        intervals = _visibility_intervals(
            segment,
            segment_depth,
            [(occluder, np.array([0.0, 0.0, 0.0]))],
            0.5,
        )
        self.assertEqual(len(intervals), 2)
        self.assertLess(intervals[0][1], 0.5)
        self.assertGreater(intervals[1][0], 0.5)

    def test_blocking_does_not_change_result(self) -> None:
        """分块只改内存策略。同一输入下小块与整块必须给出同样的可见区间。"""
        rng = np.random.default_rng(20260819)
        segment = np.array([[0.0, 0.0], [200.0, 0.0]])
        depths = np.array([100.0, 100.0])
        triangles = []
        for _ in range(40):
            x = float(rng.uniform(0.0, 190.0))
            triangles.append((
                np.array([[x, -4.0], [x + 6.0, -4.0], [x + 3.0, 4.0]]),
                np.array([50.0, 50.0, 50.0]),
            ))
        original = view_geometry._VISIBILITY_BLOCK_ELEMENTS
        try:
            view_geometry._VISIBILITY_BLOCK_ELEMENTS = 10**9
            whole = _visibility_intervals(segment, depths, triangles, 0.5)
            view_geometry._VISIBILITY_BLOCK_ELEMENTS = 8
            blocked = _visibility_intervals(segment, depths, triangles, 0.5)
        finally:
            view_geometry._VISIBILITY_BLOCK_ELEMENTS = original
        self.assertEqual(whole, blocked)
        self.assertTrue(whole)

if __name__ == "__main__":
    unittest.main()
