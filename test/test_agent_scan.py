"""Run with: python -m unittest discover -s test -p "test_*.py" """
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402

BUDGET = 0.3
RESPONSE_KEYS = {
    "status", "timestamp", "os", "threats", "safe_to_proceed", "scan_count",
    "agent_version", "physical_monitors", "contract_version", "source_sha",
    "checks", "degraded",
}


def threat(detail):
    return {"type": "test", "severity": "HIGH", "detail": detail}


class ScanBudgetTest(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.addCleanup(self.release.set)
        agent._check_threads.clear()
        log = tempfile.NamedTemporaryFile(delete=False)
        log.close()
        self.addCleanup(os.remove, log.name)
        for name, value in [
            ("SCAN_BUDGET_S", BUDGET),
            ("LOG_FILE", log.name),
            ("count_physical_monitors", lambda: 1),
        ]:
            patcher = mock.patch.object(agent, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def use_checks(self, checks):
        patcher = mock.patch.object(agent, "_CHECKS", checks)
        patcher.start()
        self.addCleanup(patcher.stop)

    def hang(self, found=None):
        def check():
            self.release.wait(10)
            return found or []
        return check

    def scan(self):
        started = time.monotonic()
        result = agent.run_full_scan()
        return result, time.monotonic() - started

    def test_all_checks_ok_is_safe(self):
        self.use_checks([("a", lambda: []), ("b", lambda: [])])
        result, _ = self.scan()
        self.assertEqual(set(result), RESPONSE_KEYS)
        self.assertEqual(result["checks"], {"a": "ok", "b": "ok", "physical_monitors": "ok"})
        self.assertFalse(result["degraded"])
        self.assertTrue(result["safe_to_proceed"])
        self.assertEqual(result["contract_version"], 2)

    def test_threats_carry_a_readable_name_and_no_exe_path(self):
        blank = "\u2800.exe"
        exe = r"C:\Programs\parakeetai-desktop" + "\\" + blank
        self.use_checks([
            ("ai", lambda: [
                {"type": "ai_cheating_tool", "detail": "a", "process": blank, "pid": 7, "exe": exe},
                {"type": "ai_cheating_tool", "detail": "b", "process": "cluely.exe", "pid": 8,
                 "exe": None},
                {"type": "suspicious_window_title", "detail": "x"},
            ]),
        ])
        result, _ = self.scan()
        hidden, cluely, title = result["threats"]
        self.assertEqual(hidden["display_name"], "parakeetai-desktop")
        self.assertEqual(hidden["process"], blank)
        self.assertEqual(cluely["display_name"], "cluely.exe")
        self.assertNotIn("display_name", title)
        self.assertTrue(all("exe" not in t for t in result["threats"]))

    def test_checks_run_in_parallel(self):
        def slowish():
            time.sleep(0.2)
            return []
        self.use_checks([(name, slowish) for name in "abcd"])
        result, elapsed = self.scan()
        self.assertLess(elapsed, 0.6)
        self.assertFalse(result["degraded"])

    def test_slow_check_is_an_error_and_the_scan_stays_in_budget(self):
        self.use_checks([("fast", lambda: [threat("seen")]), ("slow", self.hang())])
        result, elapsed = self.scan()
        self.assertLess(elapsed, BUDGET + 0.5)
        self.assertEqual(result["checks"]["fast"], "ok")
        self.assertEqual(result["checks"]["slow"], "error")
        self.assertTrue(result["degraded"])
        self.assertFalse(result["safe_to_proceed"])
        self.assertEqual([t["detail"] for t in result["threats"]], ["seen"])

    def test_clean_but_slow_scan_is_not_safe(self):
        self.use_checks([("slow", self.hang())])
        result, _ = self.scan()
        self.assertEqual(result["status"], "CLEAR")
        self.assertTrue(result["degraded"])
        self.assertFalse(result["safe_to_proceed"])

    def test_a_stuck_check_is_not_relaunched_and_cannot_leak_into_a_later_scan(self):
        calls = []

        def stuck():
            calls.append(1)
            self.release.wait(10)
            return [threat("late")]

        self.use_checks([("stuck", stuck)])
        first, _ = self.scan()
        second, _ = self.scan()
        self.assertEqual(len(calls), 1)
        self.assertEqual(second["checks"]["stuck"], "error")

        self.release.set()
        agent._check_threads["stuck"].join(2)
        self.assertEqual(first["threats"], [])
        self.assertEqual(second["threats"], [])

        third, _ = self.scan()
        self.assertEqual(len(calls), 2)
        self.assertEqual(third["checks"]["stuck"], "ok")

    def test_stuck_monitor_count_reads_as_unknown(self):
        self.use_checks([("a", lambda: [])])
        with mock.patch.object(agent, "count_physical_monitors", self.hang(1)):
            result, elapsed = self.scan()
        self.assertLess(elapsed, BUDGET + 0.5)
        self.assertIsNone(result["physical_monitors"])
        self.assertEqual(result["checks"]["physical_monitors"], "error")
        self.assertTrue(result["degraded"])

    def test_concurrent_callers_share_one_real_scan(self):
        calls = []

        def check():
            calls.append(1)
            time.sleep(0.1)
            return [threat("x")]

        self.use_checks([("a", check)])
        results = []
        callers = [threading.Thread(target=lambda: results.append(agent.run_full_scan())) for _ in range(3)]
        for c in callers:
            c.start()
        for c in callers:
            c.join(5)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 3)
        for r in results:
            self.assertFalse(r["safe_to_proceed"])
            self.assertEqual(r["status"], "THREAT_DETECTED")


def completed(returncode, stdout=""):
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr="")


class VirtualAudioCacheTest(unittest.TestCase):
    def setUp(self):
        agent._virtual_audio_cache = None
        self.addCleanup(setattr, agent, "_virtual_audio_cache", None)
        patcher = mock.patch.object(agent, "OS_NAME", "Windows")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_success_is_cached(self):
        with mock.patch.object(agent.subprocess, "run", return_value=completed(0, "FriendlyName : CABLE Input")) as run:
            first = agent.detect_virtual_audio_devices()
            second = agent.detect_virtual_audio_devices()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(len(first), 1)
        self.assertEqual(first, second)

    def test_errors_are_not_cached(self):
        with mock.patch.object(agent.subprocess, "run", return_value=completed(1)) as run:
            with self.assertRaises(agent.CheckError):
                agent.detect_virtual_audio_devices()
            self.assertIsNone(agent._virtual_audio_cache)
            with self.assertRaises(agent.CheckError):
                agent.detect_virtual_audio_devices()
        self.assertEqual(run.call_count, 2)

    def test_timeout_is_not_cached(self):
        timeout = subprocess.TimeoutExpired("powershell", 8)
        with mock.patch.object(agent.subprocess, "run", side_effect=timeout):
            with self.assertRaises(agent.CheckError):
                agent.detect_virtual_audio_devices()
        self.assertIsNone(agent._virtual_audio_cache)

    def test_cache_expires(self):
        with mock.patch.object(agent.subprocess, "run", return_value=completed(0, "Speakers")) as run:
            agent.detect_virtual_audio_devices()
            stamp, found = agent._virtual_audio_cache
            agent._virtual_audio_cache = (stamp - agent.VIRTUAL_AUDIO_CACHE_S - 1, found)
            agent.detect_virtual_audio_devices()
        self.assertEqual(run.call_count, 2)


class ReverseDnsTest(unittest.TestCase):
    def setUp(self):
        with agent._rdns_cond:
            agent._rdns_cache.clear()
        self.release = threading.Event()
        self.addCleanup(self.release.set)

    def test_slow_lookup_counts_as_unresolved_then_lands_in_the_cache(self):
        def slow(ip):
            self.release.wait(5)
            return "api.openai.com"

        with mock.patch.object(agent, "reverse_dns", slow), mock.patch.object(agent, "RDNS_WAIT_S", 0.2):
            started = time.monotonic()
            self.assertEqual(agent.resolve_hosts({"198.51.100.7"}), {"198.51.100.7": ""})
            self.assertLess(time.monotonic() - started, 1)

            self.release.set()
            self.assertEqual(agent.resolve_hosts({"198.51.100.7"}), {"198.51.100.7": "api.openai.com"})

    def test_lookups_run_in_parallel(self):
        def lookup(ip):
            time.sleep(0.3)
            return "host-" + ip

        ips = {f"198.51.100.{i}" for i in range(agent.RDNS_WORKERS)}
        with mock.patch.object(agent, "reverse_dns", lookup):
            started = time.monotonic()
            hosts = agent.resolve_hosts(ips)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(hosts, {ip: "host-" + ip for ip in ips})


if __name__ == "__main__":
    unittest.main()
