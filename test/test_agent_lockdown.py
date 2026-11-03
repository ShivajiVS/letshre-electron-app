"""Run with: python -m unittest discover -s test -p "test_agent_*.py" """
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402

VK_A = 0x41


class KeyRulesTest(unittest.TestCase):
    def test_windows_key_is_blocked_so_no_win_shortcut_works(self):
        self.assertTrue(agent.should_block_key(agent.VK_LWIN, False, False))
        self.assertTrue(agent.should_block_key(agent.VK_RWIN, False, False))

    def test_app_switching_and_start_menu_keys_are_blocked(self):
        self.assertTrue(agent.should_block_key(agent.VK_TAB, True, False))
        self.assertTrue(agent.should_block_key(agent.VK_ESCAPE, True, False))
        self.assertTrue(agent.should_block_key(agent.VK_ESCAPE, False, True))

    def test_typing_is_left_alone(self):
        self.assertFalse(agent.should_block_key(agent.VK_TAB, False, False))
        self.assertFalse(agent.should_block_key(agent.VK_ESCAPE, False, False))
        self.assertFalse(agent.should_block_key(VK_A, True, True))


class FocusTest(unittest.TestCase):
    def test_our_window_or_our_own_dialogs_keep_focus(self):
        self.assertIsNone(agent.focus_change(10, 5, 10, 5))
        self.assertIsNone(agent.focus_change(11, 5, 10, 5))

    def test_another_process_in_front_is_lost_focus(self):
        self.assertEqual(agent.focus_change(11, 9, 10, 5), "lost")

    def test_no_foreground_window_says_nothing(self):
        self.assertIsNone(agent.focus_change(0, 0, 10, 5))


class FakeKey:
    def __init__(self, reg):
        self.reg = reg

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeReg:
    HKEY_CURRENT_USER = "HKCU"
    KEY_READ = 1
    KEY_SET_VALUE = 2
    REG_DWORD = 4

    def __init__(self, values=None, present=True):
        self.values = dict(values or {})
        self.present = present

    def OpenKey(self, root, path, reserved=0, access=0):
        if not self.present:
            raise OSError("no key")
        return FakeKey(self)

    def QueryValueEx(self, key, name):
        if name not in self.values:
            raise OSError(name)
        return self.values[name], self.REG_DWORD

    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[name] = value


class TouchpadTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        patcher = mock.patch.object(agent, "TOUCHPAD_RESTORE_FILE", os.path.join(folder, "t.json"))
        patcher.start()
        self.addCleanup(patcher.stop)
        broadcast = mock.patch.object(agent, "_broadcast_setting_change", lambda: None)
        broadcast.start()
        self.addCleanup(broadcast.stop)

    def test_gestures_are_switched_off_and_put_back(self):
        reg = FakeReg({"ThreeFingerSlideEnabled": 1, "FourFingerSlideEnabled": 2, "Other": 7})
        self.assertTrue(agent.touchpad_disable(reg))
        self.assertEqual(reg.values["ThreeFingerSlideEnabled"], 0)
        self.assertEqual(reg.values["FourFingerSlideEnabled"], 0)
        self.assertEqual(reg.values["Other"], 7)

        self.assertTrue(agent.touchpad_restore(reg))
        self.assertEqual(reg.values, {"ThreeFingerSlideEnabled": 1, "FourFingerSlideEnabled": 2, "Other": 7})
        self.assertFalse(os.path.exists(agent.TOUCHPAD_RESTORE_FILE))

    def test_the_old_values_are_saved_before_anything_changes(self):
        reg = FakeReg({"ThreeFingerTapEnabled": 1})
        agent.touchpad_disable(reg)
        with open(agent.TOUCHPAD_RESTORE_FILE, encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"ThreeFingerTapEnabled": 1})

    def test_a_crash_left_over_is_restored_first(self):
        with open(agent.TOUCHPAD_RESTORE_FILE, "w", encoding="utf-8") as f:
            json.dump({"FourFingerTapEnabled": 2}, f)
        reg = FakeReg({"FourFingerTapEnabled": 0})
        agent.touchpad_restore(reg)
        self.assertEqual(reg.values["FourFingerTapEnabled"], 2)

    def test_nothing_to_change_changes_nothing(self):
        self.assertFalse(agent.touchpad_disable(FakeReg(present=False)))
        self.assertFalse(agent.touchpad_disable(FakeReg({"ThreeFingerSlideEnabled": 0})))
        self.assertFalse(os.path.exists(agent.TOUCHPAD_RESTORE_FILE))
        self.assertFalse(agent.touchpad_restore(FakeReg()))


class CommandTest(unittest.TestCase):
    def test_lockdown_is_windows_only(self):
        with mock.patch.object(agent, "OS_NAME", "Darwin"):
            lockdown = agent.InterviewLockdown()
            self.assertEqual(lockdown.start(1, 2), {"active": False, "supported": False})

    def test_commands_reach_the_lockdown(self):
        fake = mock.Mock()
        fake.start.return_value = {"active": True}
        fake.poll.return_value = {"active": True, "events": []}
        fake.stop.return_value = {"active": False}
        with mock.patch.object(agent, "LOCKDOWN", fake):
            self.assertEqual(agent._handle_command("lockdown_start", {"hwnd": 5, "pid": 6}), {"active": True})
            fake.start.assert_called_once_with(5, 6)
            self.assertEqual(agent._handle_command("lockdown_poll")["active"], True)
            self.assertEqual(agent._handle_command("lockdown_stop"), {"active": False})

    def test_poll_hands_each_event_over_once(self):
        lockdown = agent.InterviewLockdown()
        lockdown._record({"type": "focus_lost", "process": "chrome.exe"})
        first = lockdown.poll()
        self.assertEqual([e["type"] for e in first["events"]], ["focus_lost"])
        self.assertEqual(lockdown.poll()["events"], [])



class FakeTaskbars:
    """Two taskbars (main and an extra display) that can be hidden and shown."""

    def __init__(self, visible=(True, True)):
        self.visible = dict(zip((101, 102), visible))
        self.hidden_calls = []
        self.shown_calls = []

    def find_all(self):
        return list(self.visible)

    def is_visible(self, hwnd):
        return self.visible[hwnd]

    def hide(self, hwnd):
        self.visible[hwnd] = False
        self.hidden_calls.append(hwnd)

    def show(self, hwnd):
        self.visible[hwnd] = True
        self.shown_calls.append(hwnd)

    # Stacking for taskbar_above: window 1 is the interview, full screen.
    above = ()
    rects = {1: (0, 0, 1920, 1080), 101: (0, 1032, 1920, 1080), 102: (1920, 1032, 3840, 1080)}

    def windows_above(self, hwnd):
        return list(self.above)

    def rect(self, hwnd):
        return self.rects.get(hwnd)


class TaskbarTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        patcher = mock.patch.object(agent, "TASKBAR_RESTORE_FILE", os.path.join(folder, "tb.json"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_every_taskbar_is_hidden_and_shown_again(self):
        bars = FakeTaskbars()
        self.assertEqual(agent.taskbar_hide(bars), 2)
        self.assertEqual(bars.visible, {101: False, 102: False})

        self.assertTrue(agent.taskbar_restore(bars))
        self.assertEqual(bars.visible, {101: True, 102: True})
        self.assertFalse(os.path.exists(agent.TASKBAR_RESTORE_FILE))

    def test_the_restore_file_is_written_before_anything_is_hidden(self):
        bars = FakeTaskbars()
        seen = []
        bars.hide = lambda hwnd: seen.append(os.path.exists(agent.TASKBAR_RESTORE_FILE))
        agent.taskbar_hide(bars)
        self.assertEqual(seen, [True, True])

    def test_a_taskbar_that_comes_back_is_hidden_again(self):
        bars = FakeTaskbars()
        agent.taskbar_hide(bars)
        bars.visible[101] = True  # Explorer restarted
        self.assertEqual(agent.taskbar_hide(bars), 1)
        self.assertEqual(bars.visible[101], False)
        self.assertEqual(agent.taskbar_hide(bars), 0, "nothing visible, nothing to do")

    def test_after_a_crash_the_next_start_shows_them_again(self):
        agent.taskbar_hide(FakeTaskbars())
        # The agent died; a fresh one finds the file and hidden taskbars.
        after_crash = FakeTaskbars(visible=(False, False))
        self.assertTrue(agent.taskbar_restore(after_crash))
        self.assertEqual(after_crash.shown_calls, [101, 102])

    def test_without_the_file_restore_leaves_the_taskbars_alone(self):
        bars = FakeTaskbars(visible=(False, True))  # e.g. hidden by something else
        self.assertFalse(agent.taskbar_restore(bars))
        self.assertEqual(bars.shown_calls, [])

    def test_a_visible_taskbar_stacked_above_the_interview_is_reported(self):
        bars = FakeTaskbars(visible=(True, False))
        bars.above = (101,)
        self.assertTrue(agent.taskbar_above(1, bars))

    def test_a_taskbar_below_the_interview_is_not(self):
        bars = FakeTaskbars(visible=(True, False))
        bars.above = ()
        self.assertFalse(agent.taskbar_above(1, bars))

    def test_a_hidden_taskbar_or_one_on_another_display_is_not(self):
        hidden = FakeTaskbars(visible=(False, False))
        hidden.above = (101, 102)
        self.assertFalse(agent.taskbar_above(1, hidden))

        elsewhere = FakeTaskbars(visible=(False, True))
        elsewhere.above = (102,)
        self.assertFalse(agent.taskbar_above(1, elsewhere), "102 sits on the second display")

    def test_hiding_nothing_writes_no_file(self):
        self.assertEqual(agent.taskbar_hide(FakeTaskbars(visible=(False, False))), 0)
        self.assertFalse(os.path.exists(agent.TASKBAR_RESTORE_FILE))


if __name__ == "__main__":
    unittest.main()
