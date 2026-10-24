import unittest
from decimal import Decimal

from .attendance import (
    AttendanceInputError,
    current_percentage,
    project_remaining,
    required_classes,
)


class AttendanceCalculationTests(unittest.TestCase):
    def test_zero_classes_has_no_current_percentage(self) -> None:
        self.assertIsNone(current_percentage(0, 0))
        self.assertEqual(required_classes(0, 0, 75), 0)
        self.assertFalse(project_remaining(0, 0, 0, 75)["reachable"])

    def test_recovery_count_and_reachability_use_remaining_schedule(self) -> None:
        self.assertEqual(required_classes(30, 50, 75), 30)
        self.assertTrue(project_remaining(30, 50, 30, 75)["reachable"])
        self.assertFalse(project_remaining(30, 50, 29, 75)["reachable"])

    def test_exact_threshold_and_100_percent_targets(self) -> None:
        self.assertEqual(current_percentage(3, 4), 75)
        self.assertEqual(required_classes(3, 4, 75), 0)
        self.assertEqual(required_classes(5, 5, 100), 0)
        self.assertIsNone(required_classes(4, 5, 100))
        self.assertTrue(project_remaining(5, 5, 1, 100)["reachable"])
        self.assertFalse(project_remaining(4, 5, 20, 100)["reachable"])
        rounded_target = Decimal("66.66666666666667")
        self.assertEqual(required_classes(1, 3, rounded_target), 4)
        self.assertFalse(project_remaining(1, 3, 3, rounded_target)["reachable"])
        self.assertTrue(project_remaining(1, 3, 4, rounded_target)["reachable"])

    def test_invalid_counts_and_targets_are_rejected(self) -> None:
        for attended, total in ((-1, 5), (6, 5), (1.5, 5), (True, 5)):
            with self.subTest(attended=attended, total=total):
                with self.assertRaises(AttendanceInputError):
                    current_percentage(attended, total)
        for remaining in (-1, 1.5, True, 2**63):
            with self.subTest(remaining=remaining):
                with self.assertRaises(AttendanceInputError):
                    project_remaining(1, 2, remaining, 75)
        for target in (0, -1, 100.1, float("nan"), True):
            with self.subTest(target=target):
                with self.assertRaises(AttendanceInputError):
                    project_remaining(1, 2, 1, target)


if __name__ == "__main__":
    unittest.main()
