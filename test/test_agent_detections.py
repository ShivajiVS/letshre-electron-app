"""Run with: python -m unittest discover -s test -p "test_agent_*.py" """
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402


def on(os_name):
    patcher = mock.patch.object(agent, "OS_NAME", os_name)
    patcher.start()
    return patcher


def procs(*names):
    return lambda attrs: [{"name": n} for n in names]


class FakeKey:
    def __init__(self, values):
        self.values = values

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeWinreg:
    HKEY_LOCAL_MACHINE = "HKLM"

    def __init__(self, values=None):
        self.values = values

    def OpenKey(self, root, path):
        if self.values is None:
            raise FileNotFoundError(2, "The system cannot find the file specified")
        return FakeKey(self.values)

    def QueryValueEx(self, key, name):
        if name not in key.values:
            raise FileNotFoundError(2, "The system cannot find the file specified")
        return key.values[name], 1


def bios(manufacturer, product):
    return FakeWinreg({"SystemManufacturer": manufacturer, "SystemProductName": product})


class RemoteSessionTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(on("Windows").stop)

    def metrics(self, **values):
        table = {agent.SM_REMOTESESSION: values.get("session", 0), agent.SM_REMOTECONTROL: values.get("control", 0)}
        return mock.patch.object(agent, "_system_metric", side_effect=lambda i: table[i])

    def test_local_console_session_is_clear(self):
        with self.metrics():
            self.assertEqual(agent.detect_remote_session(), [])

    def test_rdp_metric_is_a_threat(self):
        with self.metrics(session=1):
            found = agent.detect_remote_session()
        self.assertEqual([t["type"] for t in found], ["remote_session"])
        self.assertEqual(found[0]["severity"], "HIGH")
        self.assertNotIn("pid", found[0])

    def test_remote_control_metric_is_a_threat(self):
        with self.metrics(control=1):
            self.assertEqual(len(agent.detect_remote_session()), 1)

    def test_stale_rdp_session_name_is_ignored(self):
        with self.metrics(), mock.patch.dict(os.environ, {"SESSIONNAME": "RDP-Tcp#3"}):
            self.assertEqual(agent.detect_remote_session(), [])

    def test_a_failed_metric_call_is_an_error(self):
        with mock.patch.object(agent, "_system_metric", side_effect=OSError("denied")):
            with self.assertRaises(agent.CheckError):
                agent.detect_remote_session()

    def test_macos_is_left_to_the_process_blocklist(self):
        with mock.patch.object(agent, "OS_NAME", "Darwin"), self.metrics(session=1):
            self.assertEqual(agent.detect_remote_session(), [])


class VirtualMachineWindowsTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(on("Windows").stop)

    def detect(self, winreg, running=()):
        with mock.patch.dict(sys.modules, {"winreg": winreg}), \
                mock.patch.object(agent, "_processes", procs(*running)):
            return agent.detect_virtual_machine()

    def test_hypervisor_firmware_strings_are_threats(self):
        for manufacturer, product in [
            ("VMware, Inc.", "VMware Virtual Platform"),
            ("innotek GmbH", "VirtualBox"),
            ("QEMU", "Standard PC (Q35 + ICH9, 2009)"),
            ("Xen", "HVM domU"),
            ("Parallels Software International Inc.", "Parallels Virtual Platform"),
            ("Microsoft Corporation", "Virtual Machine"),
            ("Red Hat", "KVM"),
            ("Bochs", "Bochs"),
        ]:
            with self.subTest(manufacturer=manufacturer):
                found = self.detect(bios(manufacturer, product))
                self.assertEqual([t["type"] for t in found], ["virtual_machine"])
                self.assertEqual(found[0]["severity"], "HIGH")

    def test_guest_tools_are_threats_on_real_firmware(self):
        for tool in ["vmtoolsd.exe", "VBoxService.exe", "VBoxTray.exe", "prl_tools_service.exe", "qemu-ga.exe", "xenservice.exe"]:
            with self.subTest(tool=tool):
                self.assertEqual(len(self.detect(bios("LENOVO", "81WB"), ["explorer.exe", tool])), 1)

    def test_hyperv_and_wsl_host_is_clear(self):
        running = ["vmmem", "vmmemWSL", "vmcompute.exe", "vmwp.exe", "vmms.exe", "wslservice.exe", "VBoxSVC.exe", "vmware-authd.exe"]
        self.assertEqual(self.detect(bios("LENOVO", "81WB"), running), [])

    def test_surface_is_clear(self):
        self.assertEqual(self.detect(bios("Microsoft Corporation", "Surface Pro 9")), [])

    def test_lookalike_words_are_clear(self):
        self.assertEqual(self.detect(bios("Xenon Systems", "Kvmatic 5")), [])

    def test_missing_values_are_clear(self):
        self.assertEqual(self.detect(FakeWinreg({})), [])

    def test_unreadable_firmware_key_is_an_error(self):
        with self.assertRaises(agent.CheckError):
            self.detect(FakeWinreg(None))


class VirtualMachineMacTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(on("Darwin").stop)

    def sysctl(self, returncode, stdout):
        result = subprocess.CompletedProcess([], returncode, stdout=stdout, stderr="unknown oid")
        return mock.patch.object(agent.subprocess, "run", return_value=result)

    def test_hv_vmm_present_is_a_threat(self):
        with self.sysctl(0, "1\n") as run:
            self.assertEqual(len(agent.detect_virtual_machine()), 1)
        self.assertEqual(run.call_args.args[0], ["sysctl", "-n", "kern.hv_vmm_present"])

    def test_bare_metal_is_clear(self):
        with self.sysctl(0, "0\n"):
            self.assertEqual(agent.detect_virtual_machine(), [])

    def test_sysctl_failure_is_an_error(self):
        with self.sysctl(1, ""):
            with self.assertRaises(agent.CheckError):
                agent.detect_virtual_machine()


class RenamedBlockedAppTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(on("Windows").stop)
        agent._original_name_cache = {}
        self.addCleanup(setattr, agent, "_original_name_cache", {})
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.originals = {}
        reader = mock.patch.object(agent, "_read_original_name", side_effect=lambda p: self.originals.get(p))
        self.reader = reader.start()
        self.addCleanup(reader.stop)
        self.running = []
        snapshot = mock.patch.object(
            agent, "_processes", lambda attrs: [{k: p[k] for k in attrs} for p in self.running]
        )
        snapshot.start()
        self.addCleanup(snapshot.stop)
        parents = mock.patch.object(
            agent, "_parent_pid", lambda pid: next((p["ppid"] for p in self.running if p["pid"] == pid), None)
        )
        parents.start()
        self.addCleanup(parents.stop)

    def exe(self, filename, original):
        path = os.path.join(self.dir, filename)
        with open(path, "wb") as f:
            f.write(b"MZ")
        self.originals[path] = original
        return path

    def run_proc(self, pid, name, exe, ppid=1):
        self.running.append({"pid": pid, "ppid": ppid, "name": name, "exe": exe})

    def test_renamed_blocked_app_is_flagged(self):
        self.run_proc(4242, "notes.exe", self.exe("notes.exe", "Chrome.exe"))
        found = agent.detect_renamed_blocked_apps()
        self.assertEqual(len(found), 1)
        threat = found[0]
        self.assertEqual(threat["type"], "renamed_blocked_app")
        self.assertEqual(threat["severity"], "HIGH")
        self.assertEqual((threat["process"], threat["pid"], threat["original"]), ("notes.exe", 4242, "chrome.exe"))
        self.assertNotIn(self.dir, threat["detail"])

    def test_same_name_is_left_to_electron(self):
        self.run_proc(1, "Chrome.exe", self.exe("chrome.exe", "chrome.exe"))
        self.run_proc(2, "msteams.exe", self.exe("msteams.exe", "ms-teams.exe"))
        self.assertEqual(agent.detect_renamed_blocked_apps(), [])

    def test_unblocked_originals_are_clear(self):
        self.run_proc(1, "Code.exe", self.exe("code.exe", "electron.exe"))
        self.run_proc(2, "svchost.exe", self.exe("svchost.exe", "svchost.exe.mui"))
        self.run_proc(3, "tool.exe", self.exe("tool.exe", None))
        self.run_proc(4, "gone.exe", os.path.join(self.dir, "missing.exe"))
        self.running.append({"pid": 5, "ppid": 0, "name": "Registry", "exe": None})
        self.assertEqual(agent.detect_renamed_blocked_apps(), [])

    def test_internal_name_without_extension_still_matches(self):
        self.run_proc(7, "meet.exe", self.exe("meet.exe", "Zoom"))
        self.assertEqual([t["original"] for t in agent.detect_renamed_blocked_apps()], ["zoom.exe"])

    def test_version_info_is_cached_until_the_file_changes(self):
        path = self.exe("notes.exe", "chrome.exe")
        self.run_proc(1, "notes.exe", path)
        self.run_proc(2, "notes.exe", path)
        for _ in range(3):
            self.assertEqual(len(agent.detect_renamed_blocked_apps()), 2)
        self.assertEqual(self.reader.call_count, 1)

        with open(path, "ab") as f:
            f.write(b"\0" * 16)
        agent.detect_renamed_blocked_apps()
        self.assertEqual(self.reader.call_count, 2)

    def test_exited_programs_drop_out_of_the_cache(self):
        self.run_proc(1, "notes.exe", self.exe("notes.exe", "chrome.exe"))
        agent.detect_renamed_blocked_apps()
        self.running.clear()
        agent.detect_renamed_blocked_apps()
        self.assertEqual(agent._original_name_cache, {})

    def test_own_app_and_agent_are_skipped(self):
        me = os.getpid()
        app = self.exe("LetsHyre Secure Interview.exe", "chrome.exe")
        agent_exe = self.exe("agent.exe", "chrome.exe")
        self.run_proc(900, "LetsHyre Secure Interview.exe", app, ppid=1)
        self.run_proc(901, "LetsHyre Secure Interview.exe", app, ppid=900)
        self.run_proc(902, "agent.exe", agent_exe, ppid=900)
        self.run_proc(me, "agent.exe", agent_exe, ppid=902)
        self.assertEqual(agent.detect_renamed_blocked_apps(), [])

    def test_snapshot_failure_is_an_error(self):
        with mock.patch.object(agent, "_processes", side_effect=agent.psutil.Error("boom")):
            with self.assertRaises(agent.CheckError):
                agent.detect_renamed_blocked_apps()

    def test_not_run_off_windows(self):
        self.run_proc(1, "notes.exe", self.exe("notes.exe", "chrome.exe"))
        with mock.patch.object(agent, "OS_NAME", "Darwin"):
            self.assertEqual(agent.detect_renamed_blocked_apps(), [])


@unittest.skipUnless(sys.platform == "win32", "reads a real PE version resource")
class VersionResourceTest(unittest.TestCase):
    def test_reads_original_filename(self):
        name = agent._read_original_name(sys.executable)
        self.assertEqual(agent._normalise_original(name), os.path.basename(sys.executable).lower())

    def test_system_binaries_drop_the_mui_suffix(self):
        explorer = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "explorer.exe")
        self.assertEqual(agent._normalise_original(agent._read_original_name(explorer)), "explorer.exe")

    def test_file_without_version_info(self):
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as f:
            f.write(b"not a pe file")
        self.addCleanup(os.remove, f.name)
        self.assertIsNone(agent._read_original_name(f.name))


class NewChecksInScanTest(unittest.TestCase):
    def setUp(self):
        agent._check_threads.clear()
        log = tempfile.NamedTemporaryFile(delete=False)
        log.close()
        self.addCleanup(os.remove, log.name)
        self.addCleanup(on("Windows").stop)
        for name, value in [("SCAN_BUDGET_S", 2), ("LOG_FILE", log.name), ("count_physical_monitors", lambda: 1)]:
            patcher = mock.patch.object(agent, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_new_checks_are_registered(self):
        names = [name for name, _ in agent._CHECKS]
        for check in ("remote_session", "virtual_machine", "renamed_blocked_app"):
            self.assertIn(check, names)

    def test_an_erroring_check_degrades_the_scan(self):
        checks = [
            ("remote_session", agent.detect_remote_session),
            ("virtual_machine", agent.detect_virtual_machine),
        ]
        with mock.patch.object(agent, "_CHECKS", checks), \
                mock.patch.object(agent, "_system_metric", side_effect=OSError("denied")), \
                mock.patch.dict(sys.modules, {"winreg": bios("LENOVO", "81WB")}), \
                mock.patch.object(agent, "_processes", procs("explorer.exe")):
            result = agent.run_full_scan()
        self.assertEqual(result["checks"]["remote_session"], "error")
        self.assertEqual(result["checks"]["virtual_machine"], "ok")
        self.assertTrue(result["degraded"])
        self.assertFalse(result["safe_to_proceed"])
        self.assertEqual(result["threats"], [])


if __name__ == "__main__":
    unittest.main()
