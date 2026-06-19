"""
=============================================================
  INTERVIEW SECURITY DESKTOP AGENT
  Behavioral deep-detection — catches threats the Node.js
  preflight checkers cannot see:
    1. Network connections to AI/cheating APIs
    2. DLL/memory signatures of renamed AI tools
    3. Browser automation (Selenium/ChromeDriver)
    4. Suspicious Win32 window class names
    5. Open window title scanning (Win32/AppleScript)

  Communication: Local HTTP Server on port 9999
  Supports: Windows, macOS, Linux
=============================================================
"""

import psutil
import platform
import subprocess
import threading
import time
import json
import socket
import os
import sys
import logging
import hashlib
import tempfile
import csv
import io
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler

# Force stdout/stderr to UTF-8 to prevent Windows cp1252 crash on non-ascii
# (stdout carries protocol JSON; stderr carries logs with arrows like →).
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

# ─────────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────────
PORT          = 9999
SCAN_INTERVAL = 3  # seconds between scans

# IMP-12: Single version source — passed via APP_VERSION env by agentManager.js.
# Previously there were 3 different version strings in the codebase.
AGENT_VERSION = os.environ.get("APP_VERSION", "1.0.0")

# IMP-08: Write logs to AGENT_LOG_DIR env var (set to userData by Electron).
# Falls back to the OS temp directory so packaged builds never hit a read-only CWD.
LOG_FILE = os.path.join(
    os.environ.get("AGENT_LOG_DIR") or tempfile.gettempdir(),
    "letshyre_agent.log"
)

# NOTE: Process-name bans, display counting, and screen-sharing
# detection are already handled by the Electron preflight
# (mirrorDetector.js + hdmiDetector.js). This agent only performs
# the five BEHAVIORAL checks that Node.js cannot do.

# AI/cheating service domains checked during network scan
SUSPICIOUS_DOMAINS = [
    # LLM API providers
    "openai.com", "api.openai.com",
    "anthropic.com", "api.anthropic.com",
    "google.generativelanguage", "generativelanguage.googleapis.com",
    "ai.google.dev",
    "api.groq.com", "groq.com",
    "api.together.xyz", "together.ai",
    "api.mistral.ai", "mistral.ai",
    "api.cohere.com", "cohere.ai",
    "api.deepseek.com", "deepseek.com",
    "api.perplexity.ai", "perplexity.ai",
    # Interview cheating tool domains
    "parakeet", "parakeetai", "api.parakeet",
    "finalroundai.com", "api.finalroundai",
    "interviewcoder.co", "api.interviewcoder",
    "cluely.com", "api.cluely",
    "lockedinai.com", "api.lockedinai",
    "interviewsolver.com",
    "interviewman.com",
    "aceround.app",
    "hedy.ai", "api.hedy.ai",
    "sensaiai", "sensei-ai",
    "aimind.so",
    # Generic cheating patterns
    "claude", "api.claude", "gemini",
    "interview-cheat", "answer-ai",
    "interview-copilot", "interview-assistant",
]

# DLL / module name fragments that indicate AI tools
SUSPICIOUS_DLLS = [
    "parakeet", "pmodule", "openai", "anthropic", "claude",
    "gemini", "interview", "cheat", "answer",
    "api_client", "http_tunnel", "proxy_socket",
    "finalround", "cluely", "lockedinai", "interviewcoder",
]

# Win32 window class names that indicate automation / injection tools.
# NOTE (Phase 4): "IEFrame" and "MozillaWindowClass" were removed — they are the
# ordinary window classes of Internet Explorer/embedded WebView and Firefox, so
# they false-positived on every such window. Browsers are already covered by the
# Node-side process check (BROWSER_APPS); flagging their window class here was
# both redundant and mislabeled as "automation/injection".
SUSPICIOUS_WINDOW_CLASSES = [
    "tcpListener",
    "websocketServer",
    "apiProxy",
    "tunnelServer",
]

# Window title keywords that suggest cheating tools
SUSPICIOUS_WINDOW_TITLES = [
    # AI assistants
    "parakeet", "chatgpt", "claude ai", "gemini", "copilot",
    "deepseek", "perplexity",
    # Interview cheating tools
    "final round", "finalround", "interview copilot",
    "interview coder", "interviewcoder",
    "cluely", "locked in ai", "lockedinai",
    "sensei ai", "sensai", "interview solver",
    "interviewman", "aceround", "ace round",
    "hedy ai", "hedyai", "pmodule",
    # Generic patterns
    "interview assistant", "ai answer", "ai helper",
    "coding assistant", "answer overlay",
    "stealth mode", "invisible overlay",
]

# ─── AI CHEATING TOOL DEEP DETECTION CONFIG ──────────────────

# Process name / exe path / cmdline keywords for AI copilot tools
AI_TOOL_PROCESS_KEYWORDS = [
    "pmodule",  # Parakeet AI real process name
    "parakeet", "finalround", "final round", "final_round",
    "interviewcoder", "interview-coder", "interview_coder",
    "cluely", "lockedin", "locked-in", "locked_in",
    "sensai", "sensei", "interviewsolver", "interview-solver",
    "interviewman", "interview-man", "aceround", "ace-round",
    "hedy", "hedyai",
    "interviewcopilot", "interview-copilot",
    "interviewassistant", "interview-assistant",
]

# Path fragments — catches renamed exes installed in known directories
AI_TOOL_PATH_KEYWORDS = [
    "parakeet", "pmodule", "finalroundai", "final round ai",
    "interviewcoder", "cluely", "lockedinai", "locked in ai",
    "sensaiai", "interviewsolver", "interviewman",
    "aceround", "hedyai",
]

# Stealth-mode command-line flags used by copilot tools
AI_TOOL_CMDLINE_FLAGS = [
    "--stealth", "--invisible", "--overlay", "--ghost",
    "--hidden-mode", "--undetectable", "--no-taskbar",
]

# Overlay window detection whitelist (legitimate overlay processes)
OVERLAY_WHITELIST = {
    "explorer.exe", "searchhost.exe", "shellexperiencehost.exe",
    "textinputhost.exe", "nvidia share.exe", "gamebar.exe",
    "gamebarftserver.exe", "widgets.exe", "startmenuexperiencehost.exe",
    "msedgewebview2.exe", "runtimebroker.exe",
    # Our own app
    "letshyre secure interview.exe", "electron.exe",
}

# Virtual audio device keywords
VIRTUAL_AUDIO_KEYWORDS = [
    "vb-cable", "vb-audio", "voicemeeter", "virtual cable",
    "blackhole", "soundflower", "loopback",
    "virtual audio", "cable input", "cable output",
]

OS_NAME = platform.system()  # 'Windows', 'Darwin', 'Linux'

# ─────────────────────────────────────────────
#  LOGGING SETUP
# ─────────────────────────────────────────────
# Phase 2: logs go to STDERR. stdout is now reserved for the newline-delimited
# JSON command protocol the Electron parent speaks over the pipe — mixing log
# text into stdout would corrupt that stream.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger("SecurityAgent")

# ─────────────────────────────────────────────
#  GLOBAL STATE
# ─────────────────────────────────────────────
scan_results = {
    "status": "initializing",
    "timestamp": "",
    "os": OS_NAME,
    "threats": [],
    "safe_to_proceed": False,
    "scan_count": 0,
    "agent_version": AGENT_VERSION  # IMP-12: uses single constant
}
scan_lock = threading.Lock()
event_log = []

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 1: WINDOW TITLE SCAN
#  Catches hidden/minimized cheating tools by
#  reading actual window titles from the OS.
# ─────────────────────────────────────────────
def scan_window_titles():
    """Scan open window titles for AI/cheating tool keywords."""
    threats = []
    titles = []

    try:
        if OS_NAME == "Windows":
            titles = _get_all_window_titles_win()
        elif OS_NAME == "Darwin":
            titles = _get_all_window_titles_mac()
        elif OS_NAME == "Linux":
            titles = _get_all_window_titles_linux()
    except Exception as e:
        logger.warning(f"Window title scan error: {e}")
        return threats

    for title in titles:
        title_lower = title.lower()
        for keyword in SUSPICIOUS_WINDOW_TITLES:
            if keyword in title_lower:
                threats.append({
                    "type": "suspicious_window_title",
                    "severity": "HIGH",
                    "detail": f"Suspicious window title detected: '{title}'",
                    "window_title": title
                })
                break
    return threats

def _get_all_window_titles_win():
    """Enumerate all visible window titles on Windows via Win32 API."""
    import ctypes
    titles = []
    EnumWindows        = ctypes.windll.user32.EnumWindows
    GetWindowText      = ctypes.windll.user32.GetWindowTextW
    GetWindowTextLen   = ctypes.windll.user32.GetWindowTextLengthW
    IsWindowVisible    = ctypes.windll.user32.IsWindowVisible

    def callback(hwnd, _):
        if IsWindowVisible(hwnd):
            length = GetWindowTextLen(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                GetWindowText(hwnd, buf, length + 1)
                if buf.value.strip():
                    titles.append(buf.value)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.c_bool,
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int)
    )
    EnumWindows(WNDENUMPROC(callback), 0)
    return titles

def _get_all_window_titles_mac():
    """Get all window titles on macOS via AppleScript."""
    script = '''
    tell application "System Events"
        set winList to {}
        repeat with proc in (every process whose background only is false)
            repeat with win in (every window of proc)
                set end of winList to name of win
            end repeat
        end repeat
        return winList
    end tell
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        raw = result.stdout.strip()
        return [t.strip() for t in raw.split(",") if t.strip()]
    except Exception:
        return []

def _get_all_window_titles_linux():
    """Get all window titles on Linux via wmctrl."""
    try:
        result = subprocess.run(
            ["wmctrl", "-l"], capture_output=True, text=True, timeout=5
        )
        titles = []
        for line in result.stdout.strip().split("\n"):
            parts = line.split(None, 3)
            if len(parts) >= 4:
                titles.append(parts[3])
        return titles
    except Exception:
        return []

# ─────────────────────────────────────────────
#  CLIPBOARD MONITOR
# ─────────────────────────────────────────────
def get_clipboard_snapshot():
    """Get a snapshot of clipboard content length (not contents for privacy)."""
    try:
        if OS_NAME == "Windows":
            import ctypes
            ctypes.windll.user32.OpenClipboard(0)
            data = ctypes.windll.user32.GetClipboardData(13)  # CF_UNICODETEXT
            ctypes.windll.user32.CloseClipboard()
            return bool(data)
        elif OS_NAME == "Darwin":
            result = subprocess.run(
                ["pbpaste"], capture_output=True, text=True, timeout=2
            )
            return len(result.stdout) > 0
    except Exception:
        pass
    return False

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION (detects renamed apps)
# ─────────────────────────────────────────────

import functools

@functools.lru_cache(maxsize=256)
def reverse_dns(ip):
    """Resolve IP to hostname, cached to avoid repeated lookups."""
    try:
        return socket.gethostbyaddr(ip)[0].lower()
    except (socket.herror, socket.gaierror, OSError):
        return ""

def detect_suspicious_network_activity():
    """
    BEHAVIORAL DETECTION 2: Network connection signatures.
    Detects any process connecting to known AI/cheating API domains.
    Works even if the application has been renamed.
    Uses psutil.net_connections() — cross-platform (Win/Mac/Linux).
    """
    threats = []

    try:
        # Build a PID → process name lookup once
        pid_to_name = {}
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                pid_to_name[proc.info['pid']] = proc.info['name'] or ""
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        # Iterate all ESTABLISHED connections (cross-platform)
        for conn in psutil.net_connections(kind='inet'):
            if conn.status != psutil.CONN_ESTABLISHED:
                continue
            if not conn.raddr:
                continue

            remote_ip = conn.raddr.ip
            remote_host = reverse_dns(remote_ip)
            pid       = conn.pid

            for domain in SUSPICIOUS_DOMAINS:
                if domain in remote_host or domain in remote_ip:
                    proc_name = pid_to_name.get(pid, f"PID {pid}")
                    threats.append({
                        "type": "suspicious_network",
                        "severity": "HIGH",
                        "detail": f"Process '{proc_name}' (PID {pid}) connected to suspicious host: {remote_ip}",
                        "process": proc_name,
                        "pid": pid,
                        "target": remote_ip
                    })
                    break

    except Exception as e:
        logger.warning(f"Network detection error: {e}")

    return threats

def detect_suspicious_memory_patterns():
    """
    BEHAVIORAL DETECTION 3: DLL / loaded-module signatures.
    Catches AI tools that have been renamed by inspecting which DLLs
    or modules are loaded in each non-system process.
    Windows only — uses a single batched `tasklist /M` call for performance.

    Fix: parses the CSV columns properly so only the MODULE column (col 5)
    is checked against SUSPICIOUS_DLLS — not the process name column (col 0).
    This prevents the host app name (e.g. 'LetsHyre Secure Interview.exe')
    from matching the keyword 'interview' and causing a false positive.
    """
    threats = []

    if OS_NAME != "Windows":
        return threats

    try:
        # Single batched call — much faster than one call per PID
        result = subprocess.run(
            ["tasklist", "/M", "/FO", "CSV"],
            capture_output=True, text=True, timeout=10
        )

        for line in result.stdout.splitlines():
            line_lower = line.lower()
            # Skip header and empty lines
            if not line_lower or "image name" in line_lower:
                continue

            # Parse the CSV row properly so quoted fields with commas
            # (e.g. "50,000 K" for Mem Usage) don't break field indexing.
            # tasklist /M /FO CSV columns:
            #   [0] Image Name  [1] PID  [2] Session Name
            #   [3] Session#    [4] Mem Usage  [5] Module (DLL name)
            try:
                cols = next(csv.reader(io.StringIO(line)))
            except Exception:
                continue

            if len(cols) < 6:
                continue  # malformed / incomplete line

            proc_name   = cols[0]          # e.g. "LetsHyre Secure Interview.exe"
            module_name = cols[5].lower()  # e.g. "ntdll.dll" — ONLY column checked

            for dll in SUSPICIOUS_DLLS:
                if dll in module_name:
                    threats.append({
                        "type": "suspicious_dll",
                        "severity": "HIGH",
                        "detail": f"Process '{proc_name}' has suspicious module loaded: '{cols[5]}'",
                        "process": proc_name,
                        "module": cols[5]
                    })
                    break  # one threat per process line

    except Exception as e:
        logger.warning(f"Memory pattern detection error: {e}")

    return threats

def detect_suspicious_file_access():
    """
    BEHAVIORAL DETECTION 4: Browser automation tools.
    Detects ChromeDriver, GeckoDriver, Selenium, PhantomJS, etc.
    Cross-platform — checks exe path and command line of every process.
    """
    threats = []

    AUTOMATION_MARKERS = [
        "chromedriver", "geckodriver", "edgedriver",
        "phantomjs", "selenium", "webdriver",
    ]

    try:
        for proc in psutil.process_iter(['pid', 'name', 'exe', 'cmdline']):
            try:
                exe_path = (proc.info['exe'] or "").lower()
                cmd_line = " ".join(proc.info['cmdline'] or []).lower()

                for marker in AUTOMATION_MARKERS:
                    if marker in exe_path or marker in cmd_line:
                        threats.append({
                            "type": "browser_automation",
                            "severity": "HIGH",
                            "detail": f"Browser automation tool detected: '{proc.info['name']}' (PID {proc.info['pid']})",
                            "process": proc.info['name'],
                            "pid": proc.info['pid']
                        })
                        break

            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

    except Exception as e:
        logger.warning(f"Browser automation detection error: {e}")

    return threats

def detect_suspicious_window_properties():
    """
    BEHAVIORAL DETECTION 5: Win32 window class names.
    Identifies automation frameworks and injection proxies even if their
    window title has been spoofed, by reading the underlying Win32 class.
    Windows only.
    """
    threats = []

    # Legitimate browser / OS window classes to ignore
    SAFE_WINDOW_CLASSES = {
        "chrome", "widgetwin", "msedge", "firefox", "opera",
        "shell_traywnd", "progman", "button", "tooltips_class32",
    }

    if OS_NAME != "Windows":
        return threats

    try:
        import ctypes
        GetClassName   = ctypes.windll.user32.GetClassNameW
        EnumWindows    = ctypes.windll.user32.EnumWindows
        IsWindowVisible = ctypes.windll.user32.IsWindowVisible

        found_classes = []

        def callback(hwnd, _):
            if IsWindowVisible(hwnd):
                buf = ctypes.create_unicode_buffer(256)
                GetClassName(hwnd, buf, 256)
                if buf.value:
                    found_classes.append(buf.value)
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(
            ctypes.c_bool,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int)
        )
        EnumWindows(WNDENUMPROC(callback), 0)

        for cls in found_classes:
            cls_lower = cls.lower()
            # Skip known-safe classes
            if any(safe in cls_lower for safe in SAFE_WINDOW_CLASSES):
                continue
            for suspicious in SUSPICIOUS_WINDOW_CLASSES:
                if suspicious.lower() in cls_lower:
                    threats.append({
                        "type": "suspicious_window_class",
                        "severity": "MEDIUM",
                        "detail": f"Suspicious Win32 window class detected: '{cls}'",
                        "window_class": cls
                    })
                    break

    except Exception as e:
        logger.warning(f"Window class detection error: {e}")

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 6: AI CHEATING TOOLS
#  Catches copilot tools even if renamed by
#  scanning process names, paths, and cmdlines.
# ─────────────────────────────────────────────
def detect_ai_cheating_tools():
    """
    Scans all running processes for AI interview copilot tools.
    Three-layer detection:
      1. Process names against keyword list
      2. Executable install paths for tool directory names
      3. Command-line arguments for stealth flags
    """
    threats = []
    seen_pids = set()  # avoid duplicate threats per process

    try:
        for proc in psutil.process_iter(['pid', 'name', 'exe', 'cmdline']):
            try:
                pid  = proc.info['pid']
                name = (proc.info['name'] or "").lower()
                exe  = (proc.info['exe'] or "").lower()
                cmd  = " ".join(proc.info['cmdline'] or []).lower()

                if pid in seen_pids:
                    continue

                # 1. Process name match
                for kw in AI_TOOL_PROCESS_KEYWORDS:
                    if kw in name:
                        seen_pids.add(pid)
                        threats.append({
                            "type": "ai_cheating_tool",
                            "severity": "HIGH",
                            "detail": f"AI cheating tool detected (process name): '{proc.info['name']}' (PID {pid})",
                            "process": proc.info['name'],
                            "pid": pid,
                            "match_type": "process_name",
                            "keyword": kw
                        })
                        break

                if pid in seen_pids:
                    continue

                # 2. Executable path match (catches renamed binaries)
                for kw in AI_TOOL_PATH_KEYWORDS:
                    if kw in exe:
                        seen_pids.add(pid)
                        threats.append({
                            "type": "ai_cheating_tool",
                            "severity": "HIGH",
                            "detail": f"AI cheating tool detected (install path): '{proc.info['name']}' at '{proc.info['exe']}' (PID {pid})",
                            "process": proc.info['name'],
                            "pid": pid,
                            "match_type": "exe_path",
                            "keyword": kw
                        })
                        break

                if pid in seen_pids:
                    continue

                # 3. Stealth command-line flags
                for flag in AI_TOOL_CMDLINE_FLAGS:
                    if flag in cmd:
                        seen_pids.add(pid)
                        threats.append({
                            "type": "ai_cheating_tool",
                            "severity": "HIGH",
                            "detail": f"Suspicious stealth flag detected: '{proc.info['name']}' with '{flag}' (PID {pid})",
                            "process": proc.info['name'],
                            "pid": pid,
                            "match_type": "cmdline_flag",
                            "keyword": flag
                        })
                        break

            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

    except Exception as e:
        logger.warning(f"AI cheating tool detection error: {e}")

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 7: TRANSPARENT OVERLAYS
#  Catches all overlay-based AI copilots by
#  detecting invisible click-through windows.
# ─────────────────────────────────────────────
def detect_overlay_windows():
    """
    Detect transparent overlay windows — the primary delivery mechanism
    for AI copilot answers.  A window with ALL THREE of these flags
    is almost certainly an AI overlay:
      - WS_EX_LAYERED     (0x00080000) — enables transparency
      - WS_EX_TRANSPARENT (0x00000020) — click-through
      - WS_EX_TOPMOST     (0x00000008) — always on top
    Whitelisted system processes are excluded.
    """
    if OS_NAME != "Windows":
        return []

    threats = []

    try:
        import ctypes

        WS_EX_LAYERED     = 0x00080000
        WS_EX_TRANSPARENT = 0x00000020
        WS_EX_TOPMOST     = 0x00000008
        GWL_EXSTYLE       = -20

        user32 = ctypes.windll.user32
        GetWindowLongW = user32.GetWindowLongW
        GetWindowThreadProcessId = user32.GetWindowThreadProcessId
        IsWindowVisible = user32.IsWindowVisible
        EnumWindows = user32.EnumWindows

        suspicious_pids = []

        def callback(hwnd, _):
            if not IsWindowVisible(hwnd):
                return True
            ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE)
            is_layered     = bool(ex_style & WS_EX_LAYERED)
            is_transparent = bool(ex_style & WS_EX_TRANSPARENT)
            is_topmost     = bool(ex_style & WS_EX_TOPMOST)

            if is_layered and is_transparent and is_topmost:
                pid = ctypes.c_ulong()
                GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                suspicious_pids.append(pid.value)
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(
            ctypes.c_bool,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int)
        )
        EnumWindows(WNDENUMPROC(callback), 0)

        # Resolve PIDs to process names and filter whitelist
        seen = set()
        for pid in suspicious_pids:
            if pid in seen:
                continue
            seen.add(pid)
            try:
                proc = psutil.Process(pid)
                pname = proc.name().lower()
                if pname not in OVERLAY_WHITELIST:
                    threats.append({
                        "type": "transparent_overlay",
                        "severity": "HIGH",
                        "detail": f"Suspicious transparent overlay detected: '{proc.name()}' (PID {pid})",
                        "process": proc.name(),
                        "pid": pid
                    })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

    except Exception as e:
        logger.warning(f"Overlay window detection error: {e}")

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 8: VIRTUAL AUDIO DEVICES
#  Detects VB-Cable, Voicemeeter, and similar
#  audio routing for hidden AI earpieces.
# ─────────────────────────────────────────────
def detect_virtual_audio_devices():
    """
    Detect virtual audio cables that could be used to pipe
    AI-generated answers to earpieces.  Windows only —
    queries PnP audio endpoint devices via PowerShell.
    """
    if OS_NAME != "Windows":
        return []

    threats = []
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object FriendlyName | Format-List"],
            capture_output=True, text=True, timeout=5
        )
        output = result.stdout.lower()
        for kw in VIRTUAL_AUDIO_KEYWORDS:
            if kw in output:
                threats.append({
                    "type": "virtual_audio_device",
                    "severity": "MEDIUM",
                    "detail": f"Virtual audio device detected (keyword: '{kw}')",
                })
                break  # one alert is enough

    except Exception as e:
        logger.warning(f"Virtual audio detection error: {e}")

    return threats

# ─────────────────────────────────────────────
#  PHYSICAL MONITOR COUNT (Phase 4)
#  Counts physically-attached display monitors via EnumDisplayDevices. Unlike the
#  Electron screen API (which sees ONE logical display in "Duplicate" mode), this
#  counts both panels of a cloned/mirrored setup — recovering duplicate-to-
#  projector detection that the logical-display count alone would miss.
# ─────────────────────────────────────────────
def count_physical_monitors():
    """Return the number of active, non-mirror-driver physical monitors (Windows)."""
    if OS_NAME != "Windows":
        return 0
    try:
        import ctypes
        from ctypes import wintypes

        class DISPLAY_DEVICE(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("DeviceName", wintypes.WCHAR * 32),
                ("DeviceString", wintypes.WCHAR * 128),
                ("StateFlags", wintypes.DWORD),
                ("DeviceID", wintypes.WCHAR * 128),
                ("DeviceKey", wintypes.WCHAR * 128),
            ]

        DISPLAY_DEVICE_ACTIVE = 0x00000001
        DISPLAY_DEVICE_MIRRORING_DRIVER = 0x00000008
        EnumDisplayDevices = ctypes.windll.user32.EnumDisplayDevicesW

        count = 0
        i = 0
        while True:
            adapter = DISPLAY_DEVICE()
            adapter.cb = ctypes.sizeof(DISPLAY_DEVICE)
            if not EnumDisplayDevices(None, i, ctypes.byref(adapter), 0):
                break
            i += 1
            if not (adapter.StateFlags & DISPLAY_DEVICE_ACTIVE):
                continue
            # Enumerate the physical monitor(s) attached to this active adapter.
            j = 0
            while True:
                mon = DISPLAY_DEVICE()
                mon.cb = ctypes.sizeof(DISPLAY_DEVICE)
                if not EnumDisplayDevices(adapter.DeviceName, j, ctypes.byref(mon), 0):
                    break
                j += 1
                if (mon.StateFlags & DISPLAY_DEVICE_ACTIVE) and not (
                    mon.StateFlags & DISPLAY_DEVICE_MIRRORING_DRIVER
                ):
                    count += 1
        return count
    except Exception as e:
        logger.warning(f"Physical monitor count error: {e}")
        return 0

# ─────────────────────────────────────────────
#  MAIN SCAN ORCHESTRATOR
# ─────────────────────────────────────────────
def run_full_scan():
    """
    Run all 8 behavioral deep-detection checks and compile results.
    Process/display/screen-sharing checks are handled by the Electron
    preflight (Node.js) and are intentionally excluded here.
    """
    global scan_results, event_log

    threats = []

    # 1. Window title scan (Win32 / AppleScript / wmctrl)
    threats.extend(scan_window_titles())

    # 2. Network connections to AI/cheating APIs (cross-platform psutil)
    threats.extend(detect_suspicious_network_activity())

    # 3. DLL / loaded-module signatures (Windows, batched)
    threats.extend(detect_suspicious_memory_patterns())

    # 4. Browser automation tools — ChromeDriver, Selenium, etc.
    threats.extend(detect_suspicious_file_access())

    # 5. Suspicious Win32 window class names
    threats.extend(detect_suspicious_window_properties())

    # 6. AI interview cheating tools (process name/path/cmdline)
    threats.extend(detect_ai_cheating_tools())

    # 7. Transparent overlay windows (Win32 WS_EX flags)
    threats.extend(detect_overlay_windows())

    # 8. Virtual audio devices (VB-Cable, Voicemeeter, etc.)
    threats.extend(detect_virtual_audio_devices())

    # ── Compile result ───────────────────────────────────────
    safe      = len(threats) == 0
    status    = "CLEAR" if safe else "THREAT_DETECTED"
    timestamp = datetime.now().isoformat()

    result = {
        "status": status,
        "timestamp": timestamp,
        "os": OS_NAME,
        "threats": threats,
        "safe_to_proceed": safe,
        "scan_count": scan_results.get("scan_count", 0) + 1,
        "agent_version": AGENT_VERSION,  # IMP-12
        # Phase 4: physical monitor count for duplicate/mirror-mode detection
        # (the Node screen API only sees logical displays). Cross-checked in
        # Node; not itself a threat here to avoid double-counting extend mode.
        "physical_monitors": count_physical_monitors(),
    }

    # ── Persist event log ────────────────────────────────────
    log_entry = {
        "timestamp": timestamp,
        "threat_count": len(threats),
        "safe": safe,
        "threats": [t["detail"] for t in threats]
    }
    event_log.append(log_entry)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception:
        pass

    if threats:
        for t in threats:
            logger.warning(f"[THREAT] {t['detail']}")
    else:
        logger.info(f"[SCAN #{result['scan_count']}] CLEAR — no behavioral threats detected.")

    with scan_lock:
        scan_results = result

    return result

# ─────────────────────────────────────────────
#  BACKGROUND SCAN LOOP
# ─────────────────────────────────────────────
def background_scanner():
    """Continuously scan every SCAN_INTERVAL seconds."""
    logger.info("Background scanner started.")
    while True:
        try:
            run_full_scan()
        except Exception as e:
            logger.error(f"Scan loop error: {e}")
        time.sleep(SCAN_INTERVAL)

# ─────────────────────────────────────────────
#  HTTP SERVER (talks to browser module)
# ─────────────────────────────────────────────
AGENT_SECRET = os.environ.get("AGENT_SECRET", "")

class AgentHandler(BaseHTTPRequestHandler):

    def _check_auth(self):
        if AGENT_SECRET and self.headers.get("X-Agent-Token") != AGENT_SECRET:
            self.send_response(403)
            self.send_header("Access-Control-Allow-Origin", "https://interview.letshyre.com")
            self.end_headers()
            self.wfile.write(b'{"error":"forbidden"}')
            return False
        return True

    def _send_cors_headers(self):
        origin = self.headers.get("Origin", "")
        allowed_origins = ["file://", "https://interview.letshyre.com"]
        if any(origin.startswith(o) for o in allowed_origins):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Agent-Token")

    def do_GET(self):
        if not self._check_auth():
            return
            
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._send_cors_headers()
        self.end_headers()

        if self.path == "/status":
            # Return latest scan result
            with scan_lock:
                response = scan_results.copy()
            self.wfile.write(json.dumps(response).encode())

        elif self.path == "/scan":
            # Trigger an immediate scan
            result = run_full_scan()
            self.wfile.write(json.dumps(result).encode())

        elif self.path == "/log":
            # Return full event log
            self.wfile.write(json.dumps(event_log).encode())

        elif self.path == "/ping":
            # Simple health check
            self.wfile.write(json.dumps({
                "alive": True,
                "agent": f"Interview Security Agent v{AGENT_VERSION}",  # IMP-12
                "version": AGENT_VERSION,
                "os": OS_NAME,
                "port": PORT
            }).encode())

        else:
            self.wfile.write(json.dumps({"error": "Unknown endpoint"}).encode())

    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def log_message(self, format, *args):
        # Suppress default HTTP logs (too noisy)
        pass

def start_http_server():
    """
    Start the local HTTP server (best-effort secondary channel).

    Phase 2: a failed bind (port already in use, firewall, AV) is NO LONGER fatal.
    The Electron parent talks to this agent over the stdin/stdout pipe, which does
    not depend on a TCP port, so the agent stays fully functional even when HTTP
    cannot start. HTTP remains available for any consumer that still uses it.
    """
    try:
        server = HTTPServer(("127.0.0.1", PORT), AgentHandler)
        logger.info(f"HTTP server running at http://127.0.0.1:{PORT}")
        server.serve_forever()
    except OSError as e:
        logger.warning(f"HTTP server unavailable on port {PORT}: {e} — "
                       f"continuing on the stdio pipe only.")


# ─────────────────────────────────────────────
#  STDIO PIPE PROTOCOL (primary Electron channel)
#  Newline-delimited JSON. Request:  {"id": <n>, "cmd": "ping"|"status"|"scan"}
#  Response: {"id": <n>, ...result}  written to stdout, one object per line.
# ─────────────────────────────────────────────
_stdout_lock = threading.Lock()

def _write_response(obj):
    """Serialize one response object to stdout as a single line."""
    try:
        with _stdout_lock:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()
    except Exception as e:
        logger.warning(f"stdout write failed: {e}")

def _handle_command(cmd):
    """Dispatch a single command to its handler and return the result dict."""
    if cmd == "ping":
        return {"alive": True, "agent_version": AGENT_VERSION, "os": OS_NAME, "port": PORT}
    if cmd == "status":
        with scan_lock:
            return dict(scan_results)
    if cmd == "scan":
        return run_full_scan()
    if cmd == "log":
        return {"log": event_log}
    return {"error": "unknown_cmd", "cmd": cmd}

def stdio_protocol_loop():
    """
    Blocking read loop over stdin. Keeps the process alive for as long as the
    parent holds the pipe open — when Electron exits and closes stdin, the loop
    ends and the agent terminates cleanly (no orphan).
    """
    logger.info("stdio pipe protocol ready (primary channel).")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue  # ignore malformed input
        req_id = req.get("id")
        try:
            resp = _handle_command(req.get("cmd"))
        except Exception as e:
            logger.warning(f"command error: {e}")
            resp = {"error": str(e)}
        resp["id"] = req_id
        _write_response(resp)
    logger.info("stdin closed — agent shutting down.")

# ─────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────
def main():
    logger.info("=" * 55)
    logger.info(f"  INTERVIEW SECURITY DESKTOP AGENT  v{AGENT_VERSION}")
    logger.info(f"  OS: {OS_NAME}  |  Port: {PORT}")
    logger.info(f"  Log file: {LOG_FILE}")
    logger.info("=" * 55)
    logger.info("Checking dependencies...")

    # Check psutil
    try:
        import psutil
        logger.info("  [OK] psutil")
    except ImportError:
        logger.error("  [MISSING] psutil — run: pip install psutil")
        sys.exit(1)

    # Start background scanner in a daemon thread (runs the first scan immediately)
    scanner_thread = threading.Thread(target=background_scanner, daemon=True)
    scanner_thread.start()

    # HTTP server is now a best-effort SECONDARY channel — run it in a daemon
    # thread so a bind failure cannot take down the agent.
    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    # The stdin/stdout pipe is the PRIMARY channel and the blocking main loop —
    # it keeps the agent alive and tied to the Electron parent's lifetime.
    stdio_protocol_loop()

if __name__ == "__main__":
    main()
