"""Run with: python -m unittest discover -s test -p "test_agent_*.py" """
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402


def completed(returncode, stdout=""):
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr="")


class VirtualCameraMatchTest(unittest.TestCase):
    def test_known_virtual_cameras_match(self):
        for name in ("OBS Virtual Camera", "ManyCam Virtual Webcam", "Snap Camera",
                     "XSplit VCam", "e2eSoft VCam", "Logi Capture", "AlterCam",
                     "CamTwist", "mmhmm Camera"):
            self.assertTrue(agent.is_virtual_camera(name), name)

    def test_real_cameras_and_nvidia_broadcast_do_not(self):
        for name in ("Integrated Camera", "Logitech BRIO", "FaceTime HD Camera",
                     "Camera (NVIDIA Broadcast)", "", None):
            self.assertFalse(agent.is_virtual_camera(name), name)

    def test_one_threat_per_distinct_device(self):
        threats = agent.virtual_camera_threats(
            ["OBS Virtual Camera", "obs virtual camera ", "Integrated Camera", "ManyCam"]
        )
        self.assertEqual([t["type"] for t in threats], ["virtual_camera", "virtual_camera"])
        self.assertEqual({t["severity"] for t in threats}, {"MEDIUM"})


class VirtualCameraDetectTest(unittest.TestCase):
    def setUp(self):
        agent._virtual_camera_cache = None
        self.addCleanup(setattr, agent, "_virtual_camera_cache", None)

    def on(self, os_name):
        patcher = mock.patch.object(agent, "OS_NAME", os_name)
        patcher.start()
        self.addCleanup(patcher.stop)

    def windows(self, dshow, run):
        self.on("Windows")
        return mock.patch.object(agent, "_dshow_camera_names", return_value=dshow), \
            mock.patch.object(agent.subprocess, "run", **run)

    def test_directshow_and_pnp_names_are_both_checked(self):
        dshow, run = self.windows(["OBS Virtual Camera"], {"return_value": completed(0, "Integrated Camera\ne2eSoft VCam\n")})
        with dshow, run:
            found = agent.detect_virtual_cameras()
        self.assertEqual(len(found), 2)

    def test_a_clean_machine_is_clear_and_cached(self):
        dshow, run = self.windows([], {"return_value": completed(0, "Integrated Camera\n")})
        with dshow, run as ran:
            self.assertEqual(agent.detect_virtual_cameras(), [])
            self.assertEqual(agent.detect_virtual_cameras(), [])
        self.assertEqual(ran.call_count, 1)

    def test_a_failed_query_is_an_error_and_not_cached(self):
        dshow, run = self.windows([], {"return_value": completed(1)})
        with dshow, run as ran:
            for _ in range(2):
                with self.assertRaises(agent.CheckError):
                    agent.detect_virtual_cameras()
        self.assertIsNone(agent._virtual_camera_cache)
        self.assertEqual(ran.call_count, 2)

    def test_a_timeout_is_an_error(self):
        dshow, run = self.windows([], {"side_effect": subprocess.TimeoutExpired("powershell", 8)})
        with dshow, run:
            with self.assertRaises(agent.CheckError):
                agent.detect_virtual_cameras()

    def test_mac_reads_system_profiler(self):
        self.on("Darwin")
        out = json.dumps({"SPCameraDataType": [{"_name": "FaceTime HD Camera"}, {"_name": "CamTwist"}]})
        with mock.patch.object(agent.subprocess, "run", return_value=completed(0, out)):
            found = agent.detect_virtual_cameras()
        self.assertEqual([t["detail"] for t in found], ["Virtual camera detected: CamTwist"])

    def test_mac_bad_output_is_an_error(self):
        self.on("Darwin")
        with mock.patch.object(agent.subprocess, "run", return_value=completed(0, "not json")):
            with self.assertRaises(agent.CheckError):
                agent.detect_virtual_cameras()

    def test_linux_is_not_checked(self):
        self.on("Linux")
        self.assertEqual(agent.detect_virtual_cameras(), [])

    def test_registered_as_a_scan_check(self):
        self.assertIn(("virtual_camera", agent.detect_virtual_cameras), agent._CHECKS)


@unittest.skipUnless(sys.platform == "win32", "reads the real registry")
class DirectShowRegistryTest(unittest.TestCase):
    def test_reads_without_error(self):
        self.assertIsInstance(agent._dshow_camera_names(), list)


if __name__ == "__main__":
    unittest.main()
