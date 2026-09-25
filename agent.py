"""
Interview security desktop agent.

Behavioural checks the Electron preflight can't do from Node (window titles and
classes, network peers, loaded modules, overlays, virtual audio, remote
sessions, virtual machines, renamed blocked apps). Process bans by image name
and display counting stay on the Node side.

Electron talks to it over newline-delimited JSON on stdin/stdout; the HTTP
server on 127.0.0.1:9999 is a fallback. Windows, macOS and Linux.
"""

import psutil
import platform
import queue
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
import re
import unicodedata
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# Windows defaults to cp1252, which crashes on non-ASCII in protocol JSON and logs.
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

# ─────────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────────
PORT          = 9999
SCAN_INTERVAL = 3  # seconds between background scans

# Electron gives a whole scan AGENT_SCAN_TIMEOUT_MS (12s); stay well inside it.
SCAN_BUDGET_S = 9.5

AGENT_VERSION = os.environ.get("APP_VERSION", "1.0.0")

# Version of the scan result shape, separate from AGENT_VERSION. Bump only when
# the fields change, so Electron can spot a stale agent.exe.
# 2 added checks{}, degraded and contract_version; safe_to_proceed needs every check to have run.
CONTRACT_VERSION = 2

# Hash of the agent.py this binary was built from; "dev" when running from source.
try:
    from _build_stamp import SOURCE_SHA
except ImportError:
    SOURCE_SHA = "dev"

LOG_FILE = os.path.join(
    os.environ.get("AGENT_LOG_DIR") or tempfile.gettempdir(),
    "letshyre_agent.log"
)

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

SUSPICIOUS_DLLS = [
    "parakeet", "pmodule", "openai", "anthropic", "claude",
    "gemini", "interview", "cheat", "answer",
    "api_client", "http_tunnel", "proxy_socket",
    "finalround", "cluely", "lockedinai", "interviewcoder",
]

# Win32 window class names that indicate automation / injection tools. Browser
# classes (IEFrame, MozillaWindowClass) don't belong here: every browser window has them.
SUSPICIOUS_WINDOW_CLASSES = [
    "tcpListener",
    "websocketServer",
    "apiProxy",
    "tunnelServer",
]

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

AI_TOOL_CMDLINE_FLAGS = [
    "--stealth", "--invisible", "--overlay", "--ghost",
    "--hidden-mode", "--undetectable", "--no-taskbar",
]

OVERLAY_WHITELIST = {
    "explorer.exe", "searchhost.exe", "shellexperiencehost.exe",
    "textinputhost.exe", "nvidia share.exe", "gamebar.exe",
    "gamebarftserver.exe", "widgets.exe", "startmenuexperiencehost.exe",
    "msedgewebview2.exe", "runtimebroker.exe",
    "letshyre secure interview.exe", "electron.exe",
}

# Laptop on-screen displays (volume, brightness, mic mute). Trusted by install
# location, not name alone, so a renamed copilot can't borrow the name. The
# driver store needs admin rights to write.
_DRIVER_STORE = os.path.normcase(os.path.join(
    os.environ.get("SystemRoot", r"C:\Windows"), "System32", "DriverStore", "FileRepository"
))
OVERLAY_TRUSTED_LOCATIONS = {
    "fnhotkeyutility.exe": (_DRIVER_STORE,),  # Lenovo Fn keys
}

# Pop-ups like the volume display vanish within a few seconds; answer overlays stay.
OVERLAY_MIN_VISIBLE_SECONDS = 5

VIRTUAL_AUDIO_KEYWORDS = [
    "vb-cable", "vb-audio", "voicemeeter", "virtual cable",
    "blackhole", "soundflower", "loopback",
    "virtual audio", "cable input", "cable output",
]

SM_REMOTESESSION = 0x1000
SM_REMOTECONTROL = 0x2001

# Guest-side tools only. Host services (VBoxSVC, vmware-authd, and Hyper-V/WSL's
# vmmem, vmcompute, vmwp on a Windows 11 host) must never be listed here.
VM_GUEST_PROCESSES = frozenset({
    "vmtoolsd.exe", "vboxservice.exe", "vboxtray.exe", "qemu-ga.exe", "xenservice.exe",
})
VM_GUEST_PROCESS_PREFIXES = ("prl_tools",)

VM_BIOS_KEYWORDS = ("vmware", "virtualbox", "innotek", "qemu", "parallels", "bochs")
VM_BIOS_WORDS = re.compile(r"\b(?:kvm|xen)\b")

# Windows image names from ALL_BLOCKED_APPS in src/shared/appList.js
# (agentBlocklistParity.test.js keeps them equal).
RENAMED_APP_BLOCKLIST = frozenset({
    "zoom.exe", "teams.exe", "ms-teams.exe", "msteams.exe", "webex.exe",
    "gotomeeting.exe", "skype.exe",
    "obs64.exe", "obs32.exe", "obs-studio.exe", "discord.exe", "slack.exe",
    "anydesk.exe", "teamviewer.exe", "bandicam.exe", "camtasia.exe", "snagit.exe",
    "parsecd.exe", "parsec.exe", "srserver.exe", "srfeature.exe", "stserver.exe",
    "remoting_host.exe",
    "scrcpy.exe", "miracast.exe", "apowermirror.exe", "letsview.exe",
    "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe", "vivaldi.exe",
    "pmodule.exe", "parakeet.exe", "parakeetai.exe", "finalroundai.exe",
    "final round ai.exe", "finalround.exe", "interviewcoder.exe", "interview-coder.exe",
    "cluely.exe", "lockedinai.exe", "lockedin.exe", "locked-in.exe", "sensei.exe",
    "sensaiai.exe", "interviewsolver.exe", "interview-solver.exe", "interviewman.exe",
    "aceround.exe", "hedy.exe", "hedyai.exe",
})

# Audio endpoints rarely change and the PowerShell query behind them is the slowest check.
VIRTUAL_AUDIO_CACHE_S = 180

# An IPv4 address with no reverse DNS takes ~4.5s to fail on Windows.
RDNS_WORKERS = 8
RDNS_WAIT_S = 5
RDNS_CACHE_MAX = 1024

OS_NAME = platform.system()  # 'Windows', 'Darwin', 'Linux'

# ─────────────────────────────────────────────
#  LOGGING SETUP
# ─────────────────────────────────────────────
# stdout carries the JSON pipe protocol, so logs go to stderr.
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
    "agent_version": AGENT_VERSION,
    "contract_version": CONTRACT_VERSION,
    "source_sha": SOURCE_SHA,
    # Nothing is verified until the first scan lands, so an early "status" can't read as clean.
    "checks": {},
    "degraded": True,
    "physical_monitors": None,
}
scan_lock = threading.Lock()

# Only one scan body runs at a time; scan_lock just guards scan_results.
scan_run_lock = threading.Lock()

# A caller arriving mid-scan waits for the in-flight scan instead of queueing another.
_scan_inflight = None            # threading.Event set when the running scan ends
_scan_inflight_lock = threading.Lock()
SCAN_WAIT_TIMEOUT = 60           # seconds a coalesced waiter waits before giving up

# Check name -> the thread that last ran it, so a check stuck from an earlier scan isn't doubled up.
_check_threads = {}

event_log = []

# ─────────────────────────────────────────────
#  CHECK OUTCOME REPORTING
# ─────────────────────────────────────────────
# A detector raises CheckError when it couldn't finish, so "couldn't look" never
# reads as "found nothing". Skipping one process or window is normal and stays local.


class CheckError(Exception):
    """Raised by a detector when an error prevented the check from completing."""

    def __init__(self, message, partial=None):
        super().__init__(message)
        self.partial = partial or []


def _run_check(name, fn, checks, threats):
    """
    Run one detector, record its outcome in `checks`, and append its threats.

    Args:
        name:    stable check id used as the key in the result's `checks` dict
        fn:      zero-arg detector returning a list of threat dicts
        checks:  dict mutated in place with name -> "ok" | "error"
        threats: list mutated in place with whatever the detector found
    """
    try:
        found = fn()
        checks[name] = "ok"
    except CheckError as e:
        logger.warning(f"[CHECK FAILED] {name}: {e}")
        checks[name] = "error"
        found = e.partial
    except Exception as e:
        logger.warning(f"[CHECK FAILED] {name}: unexpected error: {e}")
        checks[name] = "error"
        found = []
    threats.extend(found)


_proc_lock = threading.Lock()


# Render as nothing but aren't whitespace, so copilots use them to look nameless.
_BLANK_LOOKALIKES = {"⠀", "ㅤ", "ᅟ", "ᅠ", "ﾠ"}


def _visible(text):
    return "".join(
        ch for ch in text or ""
        if ch not in _BLANK_LOOKALIKES and unicodedata.category(ch)[0] not in ("C", "Z")
    )


def display_name(image, exe=None):
    """
    A name a person can read. An image named with invisible characters (ParakeetAI
    ships as U+2800 ".exe") falls back to its install folder; "" when nothing is left.
    """
    stem = os.path.splitext(image or "")[0]
    if _visible(stem):
        return image
    return _visible(os.path.basename(os.path.dirname(exe or "")))


def _processes(attrs):
    """Snapshot of process info dicts."""
    # process_iter shares its Process objects (and their .info) between callers,
    # so checks running in parallel take turns.
    with _proc_lock:
        return [dict(p.info) for p in psutil.process_iter(attrs)]

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 1: WINDOW TITLE SCAN
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
        raise CheckError(f"Window title scan error: {e}") from e

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
    # Failures propagate so the check reports "error" rather than an empty window list.
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=5
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"osascript exited {result.returncode}: {result.stderr.strip()[:200]}"
        )
    raw = result.stdout.strip()
    return [t.strip() for t in raw.split(",") if t.strip()]

def _get_all_window_titles_linux():
    """Get all window titles on Linux via wmctrl."""
    result = subprocess.run(
        ["wmctrl", "-l"], capture_output=True, text=True, timeout=5
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"wmctrl exited {result.returncode}: {result.stderr.strip()[:200]}"
        )
    titles = []
    for line in result.stdout.strip().split("\n"):
        parts = line.split(None, 3)
        if len(parts) >= 4:
            titles.append(parts[3])
    return titles

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
#  BEHAVIORAL DETECTION 2: NETWORK PEERS
# ─────────────────────────────────────────────
def reverse_dns(ip):
    """Resolve IP to hostname, "" when it has none."""
    try:
        return socket.gethostbyaddr(ip)[0].lower()
    except (socket.herror, socket.gaierror, OSError):
        return ""


_rdns_cache = {}      # ip -> hostname
_rdns_queued = set()
_rdns_queue = queue.Queue()
_rdns_cond = threading.Condition()
_rdns_workers = []


def _rdns_worker():
    while True:
        ip = _rdns_queue.get()
        try:
            host = reverse_dns(ip)
        except Exception:
            host = ""
        with _rdns_cond:
            _rdns_cache[ip] = host
            _rdns_queued.discard(ip)
            _rdns_cond.notify_all()


def resolve_hosts(ips):
    """
    Reverse-resolve ips in parallel on a shared pool. A lookup still pending
    after RDNS_WAIT_S counts as unresolved for this scan, like a failed one, and
    lands in the cache for the next.
    """
    with _rdns_cond:
        if len(_rdns_cache) > RDNS_CACHE_MAX:
            _rdns_cache.clear()
        while len(_rdns_workers) < RDNS_WORKERS:
            worker = threading.Thread(target=_rdns_worker, name="rdns", daemon=True)
            worker.start()
            _rdns_workers.append(worker)
        for ip in ips:
            if ip not in _rdns_cache and ip not in _rdns_queued:
                _rdns_queued.add(ip)
                _rdns_queue.put(ip)
        _rdns_cond.wait_for(lambda: all(ip in _rdns_cache for ip in ips), timeout=RDNS_WAIT_S)
        return {ip: _rdns_cache.get(ip, "") for ip in ips}


def detect_suspicious_network_activity():
    """
    Flags any process connected to a known AI/cheating API domain, even when
    the app has been renamed.
    """
    threats = []

    try:
        pid_to_name = {info['pid']: info['name'] or "" for info in _processes(['pid', 'name'])}

        conns = [
            c for c in psutil.net_connections(kind='inet')
            if c.status == psutil.CONN_ESTABLISHED and c.raddr
        ]
        hosts = resolve_hosts({c.raddr.ip for c in conns})

        for conn in conns:
            remote_ip = conn.raddr.ip
            remote_host = hosts.get(remote_ip, "")
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
        # net_connections() needs elevated rights on some platforms.
        raise CheckError(f"Network detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 3: LOADED MODULES
# ─────────────────────────────────────────────
def detect_suspicious_memory_patterns():
    """
    Catches renamed AI tools by the DLLs loaded into each process. Windows only,
    one batched `tasklist /M` call. Only the module column is matched, so the
    host app's own name ('LetsHyre Secure Interview.exe') can't hit 'interview'.
    """
    threats = []

    if OS_NAME != "Windows":
        return threats

    try:
        result = subprocess.run(
            ["tasklist", "/M", "/FO", "CSV"],
            capture_output=True, text=True, timeout=8
        )

        # Blocked by policy/AV means empty stdout, not "nothing loaded".
        if result.returncode != 0:
            raise RuntimeError(
                f"tasklist exited {result.returncode}: {result.stderr.strip()[:200]}"
            )

        for line in result.stdout.splitlines():
            line_lower = line.lower()
            if not line_lower or "image name" in line_lower:
                continue

            # Columns: [0] Image Name [1] PID [2] Session Name [3] Session# [4] Mem Usage [5] Module
            try:
                cols = next(csv.reader(io.StringIO(line)))
            except Exception:
                continue

            if len(cols) < 6:
                continue

            proc_name   = cols[0]
            module_name = cols[5].lower()

            for dll in SUSPICIOUS_DLLS:
                if dll in module_name:
                    threats.append({
                        "type": "suspicious_dll",
                        "severity": "HIGH",
                        "detail": f"Process '{proc_name}' has suspicious module loaded: '{cols[5]}'",
                        "process": proc_name,
                        "module": cols[5]
                    })
                    break

    except Exception as e:
        raise CheckError(f"Memory pattern detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 4: BROWSER AUTOMATION
# ─────────────────────────────────────────────
def detect_suspicious_file_access():
    """Detects ChromeDriver, GeckoDriver, Selenium, PhantomJS etc. by exe path and command line."""
    threats = []

    AUTOMATION_MARKERS = [
        "chromedriver", "geckodriver", "edgedriver",
        "phantomjs", "selenium", "webdriver",
    ]

    try:
        for info in _processes(['pid', 'name', 'exe', 'cmdline']):
            exe_path = (info['exe'] or "").lower()
            cmd_line = " ".join(info['cmdline'] or []).lower()

            for marker in AUTOMATION_MARKERS:
                if marker in exe_path or marker in cmd_line:
                    threats.append({
                        "type": "browser_automation",
                        "severity": "HIGH",
                        "detail": f"Browser automation tool detected: '{info['name']}' (PID {info['pid']})",
                        "process": info['name'],
                        "pid": info['pid']
                    })
                    break

    except Exception as e:
        raise CheckError(f"Browser automation detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 5: WINDOW CLASSES
# ─────────────────────────────────────────────
def detect_suspicious_window_properties():
    """
    Flags automation frameworks and injection proxies by their Win32 window
    class, which survives a spoofed title. Windows only.
    """
    threats = []

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
        raise CheckError(f"Window class detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 6: AI CHEATING TOOLS
# ─────────────────────────────────────────────
def detect_ai_cheating_tools():
    """
    Finds AI interview copilots, renamed or not, by process name, then install
    path, then stealth command-line flags. One threat per process.
    """
    threats = []
    seen_pids = set()

    try:
        for info in _processes(['pid', 'name', 'exe', 'cmdline']):
            pid  = info['pid']
            name = (info['name'] or "").lower()
            exe  = (info['exe'] or "").lower()
            cmd  = " ".join(info['cmdline'] or []).lower()

            if pid in seen_pids:
                continue

            for kw in AI_TOOL_PROCESS_KEYWORDS:
                if kw in name:
                    seen_pids.add(pid)
                    threats.append({
                        "type": "ai_cheating_tool",
                        "severity": "HIGH",
                        "detail": f"AI cheating tool detected (process name): '{info['name']}' (PID {pid})",
                        "process": info['name'],
                        "pid": pid,
                        "exe": info['exe'],
                        "match_type": "process_name",
                        "keyword": kw
                    })
                    break

            if pid in seen_pids:
                continue

            for kw in AI_TOOL_PATH_KEYWORDS:
                if kw in exe:
                    seen_pids.add(pid)
                    threats.append({
                        "type": "ai_cheating_tool",
                        "severity": "HIGH",
                        "detail": f"AI cheating tool detected (install path): '{info['name']}' at '{info['exe']}' (PID {pid})",
                        "process": info['name'],
                        "pid": pid,
                        "exe": info['exe'],
                        "match_type": "exe_path",
                        "keyword": kw
                    })
                    break

            if pid in seen_pids:
                continue

            for flag in AI_TOOL_CMDLINE_FLAGS:
                if flag in cmd:
                    seen_pids.add(pid)
                    threats.append({
                        "type": "ai_cheating_tool",
                        "severity": "HIGH",
                        "detail": f"Suspicious stealth flag detected: '{info['name']}' with '{flag}' (PID {pid})",
                        "process": info['name'],
                        "pid": pid,
                        "exe": info['exe'],
                        "match_type": "cmdline_flag",
                        "keyword": flag
                    })
                    break

    except Exception as e:
        raise CheckError(f"AI cheating tool detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 7: TRANSPARENT OVERLAYS
# ─────────────────────────────────────────────
_overlay_first_seen = {}  # hwnd → when it was first seen


def _keep_persistent(hwnds, now):
    """Returns the overlays visible for OVERLAY_MIN_VISIBLE_SECONDS, forgetting ones that closed."""
    global _overlay_first_seen
    _overlay_first_seen = {h: _overlay_first_seen.get(h, now) for h in hwnds}
    return {h for h, since in _overlay_first_seen.items() if now - since >= OVERLAY_MIN_VISIBLE_SECONDS}


def _is_trusted_overlay(proc):
    roots = OVERLAY_TRUSTED_LOCATIONS.get(proc.name().lower())
    if not roots:
        return False
    try:
        exe = os.path.normcase(os.path.normpath(proc.exe()))
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        return False
    return any(exe.startswith(root + os.sep) for root in roots)


def detect_overlay_windows():
    """
    Detect transparent overlay windows — the primary delivery mechanism
    for AI copilot answers.  A window with ALL THREE of these flags
    is almost certainly an AI overlay:
      - WS_EX_LAYERED     (0x00080000) — enables transparency
      - WS_EX_TRANSPARENT (0x00000020) — click-through
      - WS_EX_TOPMOST     (0x00000008) — always on top
    Whitelisted system processes, trusted laptop pop-ups and windows that
    have not stayed up for OVERLAY_MIN_VISIBLE_SECONDS are excluded.
    Reported as MEDIUM so the candidate is warned first; a second report ends
    the interview.
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

        overlays = {}  # hwnd → pid

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
                overlays[ctypes.cast(hwnd, ctypes.c_void_p).value] = pid.value
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(
            ctypes.c_bool,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int)
        )
        EnumWindows(WNDENUMPROC(callback), 0)
        persistent = _keep_persistent(overlays.keys(), time.monotonic())

        seen = set()
        for hwnd in persistent:
            pid = overlays[hwnd]
            if pid in seen:
                continue
            seen.add(pid)
            try:
                proc = psutil.Process(pid)
                pname = proc.name().lower()
                if pname not in OVERLAY_WHITELIST and not _is_trusted_overlay(proc):
                    threats.append({
                        "type": "transparent_overlay",
                        "severity": "MEDIUM",
                        "detail": f"Suspicious transparent overlay detected: '{proc.name()}' (PID {pid})",
                        "process": proc.name(),
                        "pid": pid
                    })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

    except Exception as e:
        raise CheckError(f"Overlay window detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 8: VIRTUAL AUDIO DEVICES
# ─────────────────────────────────────────────
_virtual_audio_cache = None  # (monotonic time, threats) from the last successful query


def detect_virtual_audio_devices():
    """
    Detect virtual audio cables (VB-Cable, Voicemeeter...) that could pipe
    AI answers to an earpiece. Windows only. Successful results are reused for
    VIRTUAL_AUDIO_CACHE_S; errors are never cached.
    """
    global _virtual_audio_cache
    if OS_NAME != "Windows":
        return []

    cached = _virtual_audio_cache
    if cached is not None and time.monotonic() - cached[0] < VIRTUAL_AUDIO_CACHE_S:
        return [dict(t) for t in cached[1]]

    threats = _query_virtual_audio()
    _virtual_audio_cache = (time.monotonic(), threats)
    return [dict(t) for t in threats]


def _query_virtual_audio():
    threats = []
    try:
        # A cold PowerShell start plus Get-PnpDevice takes ~5s.
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object FriendlyName | Format-List"],
            capture_output=True, text=True, timeout=8
        )
        # Blocked by execution policy / AV means empty stdout, not "no devices".
        if result.returncode != 0:
            raise RuntimeError(
                f"Get-PnpDevice exited {result.returncode}: "
                f"{result.stderr.strip()[:200]}"
            )
        output = result.stdout.lower()
        for kw in VIRTUAL_AUDIO_KEYWORDS:
            if kw in output:
                threats.append({
                    "type": "virtual_audio_device",
                    "severity": "MEDIUM",
                    "detail": f"Virtual audio device detected (keyword: '{kw}')",
                })
                break

    except Exception as e:
        raise CheckError(f"Virtual audio detection error: {e}", threats) from e

    return threats

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 9: REMOTE SESSION
# ─────────────────────────────────────────────
def _system_metric(index):
    import ctypes
    return ctypes.windll.user32.GetSystemMetrics(index)


def detect_remote_session():
    """
    Flags an RDP session or a remotely controlled one. Windows only: on macOS
    remote-control tools are caught by the process blocklist.
    """
    if OS_NAME != "Windows":
        return []
    try:
        remote = bool(_system_metric(SM_REMOTESESSION)) or bool(_system_metric(SM_REMOTECONTROL))
    except Exception as e:
        raise CheckError(f"Remote session check error: {e}") from e
    if not remote:
        return []
    return [{
        "type": "remote_session",
        "severity": "HIGH",
        "detail": "This computer is being used through a remote desktop session",
    }]

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 10: VIRTUAL MACHINE
# ─────────────────────────────────────────────
def _bios_is_vm(manufacturer, product):
    maker, model = manufacturer.strip().lower(), product.strip().lower()
    both = f"{maker} {model}"
    if any(k in both for k in VM_BIOS_KEYWORDS) or VM_BIOS_WORDS.search(both):
        return True
    # Surfaces are "Microsoft Corporation" too; only Hyper-V guests say "Virtual Machine".
    return maker == "microsoft corporation" and model == "virtual machine"


def _read_bios_strings():
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\BIOS") as key:
        values = []
        for name in ("SystemManufacturer", "SystemProductName"):
            try:
                values.append(str(winreg.QueryValueEx(key, name)[0]))
            except FileNotFoundError:
                values.append("")
        return values


def _is_vm_guest_tool(name):
    name = (name or "").lower()
    return name in VM_GUEST_PROCESSES or name.startswith(VM_GUEST_PROCESS_PREFIXES)


def detect_virtual_machine():
    """
    Flags running as a VM guest, from the firmware strings and guest tools.
    Never the CPUID hypervisor bit: Windows 11 sets it on hosts with VBS or WSL.
    """
    try:
        if OS_NAME == "Windows":
            found = _bios_is_vm(*_read_bios_strings()) or any(
                _is_vm_guest_tool(info["name"]) for info in _processes(["name"])
            )
        elif OS_NAME == "Darwin":
            result = subprocess.run(
                ["sysctl", "-n", "kern.hv_vmm_present"],
                capture_output=True, text=True, timeout=2
            )
            if result.returncode != 0:
                raise RuntimeError(f"sysctl exited {result.returncode}: {result.stderr.strip()[:200]}")
            found = result.stdout.strip() == "1"
        else:
            return []
    except Exception as e:
        raise CheckError(f"Virtual machine check error: {e}") from e
    if not found:
        return []
    return [{
        "type": "virtual_machine",
        "severity": "HIGH",
        "detail": "This computer is a virtual machine",
    }]

# ─────────────────────────────────────────────
#  BEHAVIORAL DETECTION 11: RENAMED BLOCKED APPS
# ─────────────────────────────────────────────
_version_api = None
_original_name_cache = {}  # (exe, mtime, size) -> original file name or None


def _version_functions():
    global _version_api
    if _version_api is None:
        import ctypes
        from ctypes import wintypes
        dll = ctypes.WinDLL("version")
        dll.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
        dll.GetFileVersionInfoSizeW.restype = wintypes.DWORD
        dll.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
        dll.GetFileVersionInfoW.restype = wintypes.BOOL
        dll.VerQueryValueW.argtypes = [
            ctypes.c_void_p, wintypes.LPCWSTR,
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT),
        ]
        dll.VerQueryValueW.restype = wintypes.BOOL
        _version_api = dll
    return _version_api


def _read_original_name(path):
    """OriginalFilename from the exe's version resource (InternalName if that's empty), or None."""
    import ctypes
    from ctypes import wintypes
    api = _version_functions()
    size = api.GetFileVersionInfoSizeW(path, None)
    if not size:
        return None
    data = ctypes.create_string_buffer(size)
    if not api.GetFileVersionInfoW(path, 0, size, data):
        return None

    ptr, length = ctypes.c_void_p(), wintypes.UINT()

    def query(sub_block):
        if api.VerQueryValueW(data, sub_block, ctypes.byref(ptr), ctypes.byref(length)) and ptr.value:
            return ptr.value, length.value
        return None, 0

    addr, count = query("\\VarFileInfo\\Translation")
    words = (wintypes.WORD * (count // 2)).from_address(addr) if addr else []
    langs = [f"{words[i]:04x}{words[i + 1]:04x}" for i in range(0, len(words) - 1, 2)]

    for field in ("OriginalFilename", "InternalName"):
        for lang in langs:
            addr, count = query(f"\\StringFileInfo\\{lang}\\{field}")
            value = ctypes.wstring_at(addr, count).split("\0")[0].strip() if addr and count else ""
            if value:
                return value
    return None


def _normalise_original(name):
    name = name.lower()
    # System binaries carry their strings in a .mui satellite.
    if name.endswith(".mui"):
        name = name[:-4]
    if not os.path.splitext(name)[1]:
        name += ".exe"
    return name


def _original_names(exes):
    """exe path -> normalised original name, reusing cached reads while the file is unchanged."""
    global _original_name_cache
    cache, names = {}, {}
    for exe in exes:
        try:
            st = os.stat(exe)
        except OSError:
            continue
        key = (os.path.normcase(exe), st.st_mtime_ns, st.st_size)
        if key in _original_name_cache:
            cache[key] = _original_name_cache[key]
        else:
            try:
                raw = _read_original_name(exe)
            except OSError:
                continue
            cache[key] = _normalise_original(raw) if raw else None
        names[exe] = cache[key]
    _original_name_cache = cache
    return names


def _parent_pid(pid):
    # Per call, psutil walks every process on Windows, so it isn't in the shared snapshot.
    try:
        return psutil.Process(pid).ppid()
    except psutil.Error:
        return None


def _own_app_exes(procs):
    """The agent's exe and the exe of the app that launched it (all Electron processes share one)."""
    exe_of = {info["pid"]: info["exe"] for info in procs}
    pid = os.getpid()
    own = exe_of.get(pid)
    if not own:
        return set()
    seen = {pid}
    parent = _parent_pid(pid)
    # The PyInstaller bootloader runs the same exe as its child.
    while parent is not None and parent not in seen and exe_of.get(parent) == own:
        seen.add(parent)
        parent = _parent_pid(parent)
    exes = {own, exe_of.get(parent)}
    return {os.path.normcase(e) for e in exes if e}


def detect_renamed_blocked_apps():
    """
    Flags a blocked app renamed to dodge the image-name check, by the original
    file name in its version resource. Windows only. Apps running under their
    blocked name are left to Electron's own process scan.
    """
    if OS_NAME != "Windows":
        return []
    try:
        procs = _processes(["pid", "name", "exe"])
        skip = _own_app_exes(procs)
        candidates = [
            info for info in procs
            if info["exe"] and info["name"]
            and info["name"].lower() not in RENAMED_APP_BLOCKLIST
            and os.path.normcase(info["exe"]) not in skip
        ]
        originals = _original_names({info["exe"] for info in candidates})
    except Exception as e:
        raise CheckError(f"Renamed app check error: {e}") from e

    threats = []
    for info in candidates:
        original = originals.get(info["exe"])
        if original in RENAMED_APP_BLOCKLIST and original != info["name"].lower():
            threats.append({
                "type": "renamed_blocked_app",
                "severity": "HIGH",
                "detail": "A blocked app is running under a different name",
                "process": info["name"],
                "pid": info["pid"],
                "original": original,
            })
    return threats

# ─────────────────────────────────────────────
#  PHYSICAL MONITOR COUNT
# ─────────────────────────────────────────────
def count_physical_monitors():
    """
    Number of active, non-mirror-driver physical monitors (Windows). Electron's
    screen API sees one logical display in Duplicate mode; this counts both panels.

    None means the enumeration failed, so it can't be mistaken for "no extra
    monitor". 0 on other platforms, where the screen API is authoritative.
    """
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
        return None

# ─────────────────────────────────────────────
#  MAIN SCAN ORCHESTRATOR
# ─────────────────────────────────────────────
_CHECKS = [
    ("window_titles", scan_window_titles),
    ("network", detect_suspicious_network_activity),
    ("memory_patterns", detect_suspicious_memory_patterns),
    ("browser_automation", detect_suspicious_file_access),
    ("window_classes", detect_suspicious_window_properties),
    ("ai_tools", detect_ai_cheating_tools),
    ("overlay_windows", detect_overlay_windows),
    ("virtual_audio", detect_virtual_audio_devices),
    ("remote_session", detect_remote_session),
    ("virtual_machine", detect_virtual_machine),
    ("renamed_blocked_app", detect_renamed_blocked_apps),
]


def run_full_scan():
    """
    Run a full scan, or join the one already in flight and return its result.
    Waiters get the stored result (the fail-closed initial one if no scan has
    finished yet), never a made-up clean one.
    """
    global _scan_inflight

    with _scan_inflight_lock:
        pending = _scan_inflight
        if pending is None:
            _scan_inflight = pending = threading.Event()
            owner = True
        else:
            owner = False

    if not owner:
        pending.wait(SCAN_WAIT_TIMEOUT)
        with scan_lock:
            return dict(scan_results)

    try:
        return _execute_full_scan()
    finally:
        with _scan_inflight_lock:
            _scan_inflight = None
        pending.set()


def _launch(name, target, *args):
    """Start a check on its own thread, unless its thread from an earlier scan is still stuck."""
    prev = _check_threads.get(name)
    if prev is not None and prev.is_alive():
        logger.warning(f"[CHECK FAILED] {name}: still running from an earlier scan")
        return None
    thread = threading.Thread(target=target, args=args, name=f"check-{name}", daemon=True)
    _check_threads[name] = thread
    thread.start()
    return thread


def _execute_full_scan():
    """
    Run every check in parallel within SCAN_BUDGET_S and compile the result.
    A check that errors, overruns the budget or is still stuck from an earlier
    scan is "error", which makes the scan degraded and not safe_to_proceed.
    """
    global scan_results, event_log

    with scan_run_lock:
        deadline = time.monotonic() + SCAN_BUDGET_S

        # Each run writes to its own dict and list, so a check abandoned past the
        # deadline can't touch a later scan's result.
        runs = []
        for name, fn in _CHECKS:
            outcome, found = {}, []
            runs.append((name, _launch(name, _run_check, name, fn, outcome, found), outcome, found))
        monitor_box = []
        monitor_thread = _launch(
            "physical_monitors", lambda: monitor_box.append(count_physical_monitors())
        )

        for thread in [run[1] for run in runs] + [monitor_thread]:
            if thread is not None:
                thread.join(max(0.0, deadline - time.monotonic()))

        threats = []
        checks = {}
        for name, thread, outcome, found in runs:
            if thread is None:
                checks[name] = "error"
            elif thread.is_alive():
                logger.warning(f"[CHECK FAILED] {name}: over the {SCAN_BUDGET_S}s scan budget")
                checks[name] = "error"
            else:
                checks[name] = outcome.get(name, "error")
                threats.extend(found)

        for t in threats:
            exe = t.pop("exe", None)
            if isinstance(t.get("process"), str):
                label = display_name(t["process"], exe)
                if label:
                    t["display_name"] = label

        # Not a threat check, but a silent failure here hides a mirrored projector.
        monitors = monitor_box[0] if monitor_box else None
        checks["physical_monitors"] = "error" if monitors is None else "ok"

    failed    = sorted(n for n, outcome in checks.items() if outcome != "ok")
    degraded  = len(failed) > 0
    # status only says whether anything was found; "couldn't look" is degraded.
    status    = "CLEAR" if len(threats) == 0 else "THREAT_DETECTED"
    safe      = len(threats) == 0 and not degraded
    timestamp = datetime.now().isoformat()

    result = {
        "status": status,
        "timestamp": timestamp,
        "os": OS_NAME,
        "threats": threats,
        "safe_to_proceed": safe,
        "scan_count": scan_results.get("scan_count", 0) + 1,
        "agent_version": AGENT_VERSION,
        # Cross-checked against logical displays in Node; None means it couldn't count.
        "physical_monitors": monitors,
        "contract_version": CONTRACT_VERSION,
        "source_sha": SOURCE_SHA,
        "checks": checks,
        "degraded": degraded,
    }

    if degraded:
        logger.warning(
            f"[SCAN #{result['scan_count']}] DEGRADED — {len(failed)} of "
            f"{len(checks)} checks could not complete: {', '.join(failed)}. "
            f"Reporting safe_to_proceed=False; this device was NOT fully verified."
        )

    log_entry = {
        "timestamp": timestamp,
        "threat_count": len(threats),
        "safe": safe,
        "degraded": degraded,
        "failed_checks": failed,
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
    elif not degraded:
        logger.info(
            f"[SCAN #{result['scan_count']}] CLEAR — all {len(checks)} checks ran, "
            f"no behavioral threats detected."
        )

    with scan_lock:
        scan_results = result

    return result

# ─────────────────────────────────────────────
#  BACKGROUND SCAN LOOP
# ─────────────────────────────────────────────
def background_scanner():
    """
    Scan every SCAN_INTERVAL seconds, starting straight away so the first
    preflight scan joins a warm one instead of paying for a cold start.
    """
    logger.info("Background scanner started.")
    while True:
        try:
            run_full_scan()
        except Exception as e:
            logger.error(f"Scan loop error: {e}")
        time.sleep(SCAN_INTERVAL)

# ─────────────────────────────────────────────
#  HTTP SERVER (fallback channel)
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
            with scan_lock:
                response = scan_results.copy()
            self.wfile.write(json.dumps(response).encode())

        elif self.path == "/scan":
            result = run_full_scan()
            self.wfile.write(json.dumps(result).encode())

        elif self.path == "/log":
            self.wfile.write(json.dumps(event_log).encode())

        elif self.path == "/ping":
            self.wfile.write(json.dumps({
                "alive": True,
                "agent": f"Interview Security Agent v{AGENT_VERSION}",
                "version": AGENT_VERSION,
                "contract_version": CONTRACT_VERSION,
                "source_sha": SOURCE_SHA,
                "os": OS_NAME,
                "port": PORT
            }).encode())

        else:
            self.wfile.write(json.dumps({"error": "Unknown endpoint"}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def log_message(self, format, *args):
        pass

def start_http_server():
    """Start the HTTP fallback. A failed bind isn't fatal: Electron uses the stdio pipe."""
    try:
        # Threading, so a slow /scan can't block /ping.
        server = ThreadingHTTPServer(("127.0.0.1", PORT), AgentHandler)
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
        return {
            "alive": True,
            "agent_version": AGENT_VERSION,
            "contract_version": CONTRACT_VERSION,
            "source_sha": SOURCE_SHA,
            "os": OS_NAME,
            "port": PORT,
        }
    if cmd == "status":
        with scan_lock:
            return dict(scan_results)
    if cmd == "scan":
        return run_full_scan()
    if cmd == "log":
        return {"log": event_log}
    return {"error": "unknown_cmd", "cmd": cmd}

# Answered inline; anything else runs on a worker so a slow scan can't delay a ping.
_INLINE_CMDS = ("ping", "status", "log")

# Scans coalesce, so this cap only stops a runaway client spawning threads.
MAX_WORKER_THREADS = 8
_worker_count = 0
_worker_count_lock = threading.Lock()

def _dispatch(req_id, cmd):
    """Run one command and write its response. Responses carry `id`, so the
    parent matches them regardless of arrival order."""
    try:
        resp = _handle_command(cmd)
    except Exception as e:
        logger.warning(f"command error: {e}")
        resp = {"error": str(e)}
    resp["id"] = req_id
    _write_response(resp)

def _dispatch_worker(req_id, cmd):
    global _worker_count
    try:
        _dispatch(req_id, cmd)
    finally:
        with _worker_count_lock:
            _worker_count -= 1

def stdio_protocol_loop():
    """Blocking read loop over stdin. When Electron closes the pipe the agent exits, so it can't be orphaned."""
    global _worker_count
    logger.info("stdio pipe protocol ready (primary channel).")
    # The parent's "agent is up" signal: sent once, without an id.
    _write_response({
        "event": "ready",
        "agent_version": AGENT_VERSION,
        "contract_version": CONTRACT_VERSION,
        "source_sha": SOURCE_SHA,
        "pid": os.getpid(),
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        req_id = req.get("id")
        cmd = req.get("cmd")

        if cmd in _INLINE_CMDS:
            _dispatch(req_id, cmd)
            continue

        with _worker_count_lock:
            if _worker_count >= MAX_WORKER_THREADS:
                busy = True
            else:
                _worker_count += 1
                busy = False
        if busy:
            _write_response({"id": req_id, "error": "busy", "cmd": cmd})
            continue
        threading.Thread(
            target=_dispatch_worker, args=(req_id, cmd), daemon=True
        ).start()
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

    try:
        import psutil
        logger.info("  [OK] psutil")
    except ImportError:
        logger.error("  [MISSING] psutil — run: pip install psutil")
        sys.exit(1)

    scanner_thread = threading.Thread(target=background_scanner, daemon=True)
    scanner_thread.start()

    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    stdio_protocol_loop()

if __name__ == "__main__":
    main()
