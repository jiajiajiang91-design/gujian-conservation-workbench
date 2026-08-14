from __future__ import annotations

import unittest

import numpy as np

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


if __name__ == "__main__":
    unittest.main()
