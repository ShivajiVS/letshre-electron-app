"""Run with: python -m unittest discover -s test -p "test_agent_*.py" """
import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402


class FakeProcess:
    names = {}

    def __init__(self, pid):
        entry = self.names[pid]
        if isinstance(entry, Exception):
            raise entry
        self._name = entry

    def name(self):
        return self._name


class ProcessWatcherTest(unittest.TestCase):
    def poll(self, known, pids, names):
        FakeProcess.names = names
        events = []
        with mock.patch.object(agent.psutil, "pids", return_value=pids), \
                mock.patch.object(agent.psutil, "Process", FakeProcess):
            current = agent.poll_new_processes(set(known), events.append)
        return current, events

    def test_only_new_pids_are_reported(self):
        current, events = self.poll([1, 2], [1, 2, 7], {7: "zoom.exe"})
        self.assertEqual(current, {1, 2, 7})
        self.assertEqual(events, [{"type": "process_started", "name": "zoom.exe", "pid": 7}])

    def test_nothing_new_sends_nothing(self):
        _, events = self.poll([1, 2], [1, 2], {})
        self.assertEqual(events, [])

    def test_processes_that_exit_before_they_are_read_are_skipped(self):
        names = {5: agent.psutil.NoSuchProcess(5), 6: agent.psutil.AccessDenied(6), 8: "cluely.exe"}
        current, events = self.poll([], [5, 6, 8], names)
        self.assertEqual([e["pid"] for e in events], [8])
        self.assertEqual(current, {5, 6, 8})

    def test_a_burst_is_capped(self):
        pids = list(range(1, agent.PROCESS_EVENTS_PER_POLL + 20))
        _, events = self.poll([], pids, {p: f"p{p}.exe" for p in pids})
        self.assertEqual(len(events), agent.PROCESS_EVENTS_PER_POLL)

    def test_first_pass_is_a_baseline(self):
        stop = threading.Event()
        calls = []
        pids = iter([[1, 2], [1, 2, 3]])

        def next_pids():
            calls.append(1)
            if len(calls) >= 2:
                stop.set()
            return next(pids)

        FakeProcess.names = {3: "teams.exe"}
        events = []
        with mock.patch.object(agent.psutil, "pids", side_effect=next_pids), \
                mock.patch.object(agent.psutil, "Process", FakeProcess), \
                mock.patch.object(agent, "PROCESS_WATCH_S", 0):
            agent.process_watcher(events.append, stop)
        self.assertEqual(events, [{"type": "process_started", "name": "teams.exe", "pid": 3}])

    def test_errors_do_not_stop_the_watcher(self):
        stop = threading.Event()
        calls = []

        def failing():
            calls.append(1)
            if len(calls) >= 3:
                stop.set()
            raise OSError("denied")

        with mock.patch.object(agent.psutil, "pids", side_effect=failing), \
                mock.patch.object(agent, "PROCESS_WATCH_S", 0):
            agent.process_watcher(lambda e: None, stop)
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
