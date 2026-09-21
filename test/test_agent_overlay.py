"""Run with: python -m unittest discover -s test -p "test_*.py" """
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402


class FakeProc:
    def __init__(self, name, exe):
        self._name, self._exe = name, exe

    def name(self):
        return self._name

    def exe(self):
        if isinstance(self._exe, Exception):
            raise self._exe
        return self._exe


DRIVER_STORE = os.path.join(agent._DRIVER_STORE, "lenovofnandfunctionkeys.inf_amd64_5e21", "FnHotkeyUtility.exe")


class TrustedOverlayTest(unittest.TestCase):
    def test_lenovo_popup_from_the_driver_store_is_trusted(self):
        self.assertTrue(agent._is_trusted_overlay(FakeProc("FnHotkeyUtility.exe", DRIVER_STORE)))

    def test_same_name_elsewhere_is_not_trusted(self):
        exe = os.path.join(os.path.expanduser("~"), "Downloads", "FnHotkeyUtility.exe")
        self.assertFalse(agent._is_trusted_overlay(FakeProc("FnHotkeyUtility.exe", exe)))

    def test_a_lookalike_folder_is_not_trusted(self):
        exe = agent._DRIVER_STORE + "Evil" + os.sep + "FnHotkeyUtility.exe"
        self.assertFalse(agent._is_trusted_overlay(FakeProc("FnHotkeyUtility.exe", exe)))

    def test_unreadable_path_is_not_trusted(self):
        denied = agent.psutil.AccessDenied(pid=1)
        self.assertFalse(agent._is_trusted_overlay(FakeProc("FnHotkeyUtility.exe", denied)))

    def test_other_programs_are_not_trusted_by_location(self):
        exe = os.path.join(agent._DRIVER_STORE, "x", "overlay.exe")
        self.assertFalse(agent._is_trusted_overlay(FakeProc("overlay.exe", exe)))


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        agent._overlay_first_seen = {}

    def test_a_short_popup_is_ignored(self):
        self.assertEqual(agent._keep_persistent({1}, 100.0), set())
        self.assertEqual(agent._keep_persistent({1}, 102.0), set())
        self.assertEqual(agent._keep_persistent(set(), 104.0), set())

    def test_an_overlay_that_stays_is_reported(self):
        agent._keep_persistent({1}, 100.0)
        self.assertEqual(agent._keep_persistent({1}, 100.0 + agent.OVERLAY_MIN_VISIBLE_SECONDS), {1})

    def test_a_reopened_popup_starts_over(self):
        agent._keep_persistent({1}, 100.0)
        agent._keep_persistent(set(), 103.0)
        self.assertEqual(agent._keep_persistent({1}, 106.0), set())


if __name__ == "__main__":
    unittest.main()
