"""
Interview security desktop agent.

Behavioural checks the Electron preflight can't do from Node (window titles and
classes, network peers, loaded modules, overlays, virtual audio, remote
sessions, virtual machines, renamed blocked apps). Process bans by image name
and display counting stay on the Node side; the agent only tells Electron the
moment a process starts so it can check it straight away.

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
#  PROCESS START WATCHER
# ─────────────────────────────────────────────
# The scan only sees a new app on its next pass, so new PIDs are pushed to
# Electron as {"type": "process_started"} for it to check against its blocklist.
PROCESS_WATCH_S = 0.5
# A burst past this is left to the next scan.
PROCESS_EVENTS_PER_POLL = 50


def poll_new_processes(known, emit):
    """Emit process_started for every PID not in `known`; returns the current PID set."""
    current = set(psutil.pids())
    for pid in sorted(current - known)[:PROCESS_EVENTS_PER_POLL]:
        try:
            name = psutil.Process(pid).name()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        if name:
            emit({"type": "process_started", "name": name, "pid": pid})
    return current


def process_watcher(emit, stop=None):
    known = None
    while stop is None or not stop.is_set():
        try:
            known = set(psutil.pids()) if known is None else poll_new_processes(known, emit)
        except Exception as e:
            logger.warning(f"process watcher error: {e}")
        time.sleep(PROCESS_WATCH_S)

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
#  INTERVIEW LOCKDOWN (Windows)
#  Electron can lock its own window but not the OS shell: system keys, the
#  taskbar, Task View, virtual desktops and touchpad gestures all move focus
#  away from a kiosk window. This holds them for the length of the interview.
# ─────────────────────────────────────────────
LOCKDOWN_WATCH_S = 0.25
HOOK_REFRESH_MS = 5000

VK_TAB, VK_ESCAPE, VK_LWIN, VK_RWIN, VK_CONTROL = 0x09, 0x1B, 0x5B, 0x5C, 0x11
LLKHF_ALTDOWN = 0x20
WH_KEYBOARD_LL = 13
WM_QUIT, WM_TIMER = 0x0012, 0x0113

TOUCHPAD_KEY = r"Software\Microsoft\Windows\CurrentVersion\PrecisionTouchPad"
TOUCHPAD_VALUES = (
    "ThreeFingerSlideEnabled",
    "FourFingerSlideEnabled",
    "ThreeFingerTapEnabled",
    "FourFingerTapEnabled",
)
TOUCHPAD_RESTORE_FILE = os.path.join(
    os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(),
    "letshyre-secure-interview",
    "touchpad-restore.json",
)


def should_block_key(vk, alt_down, ctrl_down):
    """The Windows key alone opens every Win+ shortcut, so blocking it covers them all."""
    if vk in (VK_LWIN, VK_RWIN):
        return True
    if alt_down and vk in (VK_TAB, VK_ESCAPE):
        return True
    return ctrl_down and vk == VK_ESCAPE


def focus_change(fg_hwnd, fg_pid, own_hwnd, own_pid):
    """"lost" when another process holds the foreground, None when it's ours or nobody's."""
    if not fg_hwnd or fg_hwnd == own_hwnd or fg_pid == own_pid:
        return None
    return "lost"


def _user32():
    """A private handle, so the argtypes set here don't leak into other checks."""
    import ctypes
    from ctypes import wintypes

    u = ctypes.WinDLL("user32", use_last_error=True)
    u.GetForegroundWindow.restype = wintypes.HWND
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetWindowThreadProcessId.restype = wintypes.DWORD
    u.SetForegroundWindow.argtypes = [wintypes.HWND]
    u.BringWindowToTop.argtypes = [wintypes.HWND]
    u.SwitchToThisWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
    u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    u.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    u.CallNextHookEx.restype = ctypes.c_ssize_t
    u.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
    u.GetAsyncKeyState.restype = ctypes.c_short
    u.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u.SendMessageTimeoutW.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPCWSTR,
        wintypes.UINT, wintypes.UINT, ctypes.c_void_p,
    ]
    return u


class _KeyHook:
    """A low-level keyboard hook on its own thread with its own message loop."""

    def __init__(self):
        self._thread = None
        self._thread_id = None
        self.blocked = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        ready = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(ready,), name="lockdown-keys", daemon=True)
        self._thread.start()
        ready.wait(2)

    def stop(self):
        if self._thread_id:
            _user32().PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self._thread:
            self._thread.join(2)
        self._thread = None
        self._thread_id = None

    def alive(self):
        return bool(self._thread and self._thread.is_alive())

    def _run(self, ready):
        import ctypes
        from ctypes import wintypes

        class KBDLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [
                ("vkCode", wintypes.DWORD),
                ("scanCode", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        u = _user32()
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        u.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
        u.SetWindowsHookExW.restype = wintypes.HHOOK

        def on_key(n_code, w_param, l_param):
            if n_code == 0:
                kb = ctypes.cast(l_param, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                ctrl = bool(u.GetAsyncKeyState(VK_CONTROL) & 0x8000)
                if should_block_key(kb.vkCode, bool(kb.flags & LLKHF_ALTDOWN), ctrl):
                    self.blocked += 1
                    return 1
            return u.CallNextHookEx(None, n_code, w_param, l_param)

        proc = HOOKPROC(on_key)
        module = kernel32.GetModuleHandleW(None)
        hook = u.SetWindowsHookExW(WH_KEYBOARD_LL, proc, module, 0)
        self._thread_id = kernel32.GetCurrentThreadId()
        timer = u.SetTimer(None, 0, HOOK_REFRESH_MS, None)
        ready.set()
        if not hook:
            logger.warning(f"[lockdown] keyboard hook failed: {ctypes.get_last_error()}")
            return
        msg = wintypes.MSG()
        while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_TIMER:
                # Windows silently drops a hook that once answered too slowly.
                u.UnhookWindowsHookEx(hook)
                hook = u.SetWindowsHookExW(WH_KEYBOARD_LL, proc, module, 0)
        u.KillTimer(None, timer)
        if hook:
            u.UnhookWindowsHookEx(hook)


def _virtual_desktop_check():
    """Returns f(hwnd) -> True/False/None (unknown), via the documented IVirtualDesktopManager."""
    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD), ("d", ctypes.c_ubyte * 8)]

    def guid(text):
        g = GUID()
        ctypes.oledll.ole32.CLSIDFromString(ctypes.c_wchar_p(text), ctypes.byref(g))
        return g

    ptr = ctypes.c_void_p()
    ctypes.oledll.ole32.CoInitialize(None)
    hr = ctypes.windll.ole32.CoCreateInstance(
        ctypes.byref(guid("{aa509086-5ca9-4c25-8f95-589d3c07b48a}")), None, 1,
        ctypes.byref(guid("{a5cd92ff-29be-454c-8d04-d82879fb3f1b}")), ctypes.byref(ptr),
    )
    if hr != 0 or not ptr.value:
        return lambda hwnd: None
    vtable = ctypes.cast(ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
    is_on_current = ctypes.WINFUNCTYPE(
        ctypes.c_long, ctypes.c_void_p, wintypes.HWND, ctypes.POINTER(wintypes.BOOL)
    )(vtable[3])

    def check(hwnd):
        result = wintypes.BOOL()
        if is_on_current(ptr, hwnd, ctypes.byref(result)) != 0:
            return None
        return bool(result.value)

    return check


def _broadcast_setting_change():
    try:
        _user32().SendMessageTimeoutW(0xFFFF, 0x001A, 0, "PrecisionTouchPad", 0x0002, 1000, None)
    except Exception as e:
        logger.warning(f"[lockdown] setting broadcast failed: {e}")


def touchpad_disable(reg=None):
    """
    Switches off three- and four-finger gestures (Task View, show desktop, switch
    desktop). The old values are written to disk first, so a crash can't leave
    the candidate's touchpad changed. Returns whether anything was changed.
    """
    if reg is None:
        import winreg as reg
    if os.path.exists(TOUCHPAD_RESTORE_FILE):
        touchpad_restore(reg)
    try:
        key = reg.OpenKey(reg.HKEY_CURRENT_USER, TOUCHPAD_KEY, 0, reg.KEY_READ | reg.KEY_SET_VALUE)
    except OSError:
        return False
    with key:
        saved = {}
        for name in TOUCHPAD_VALUES:
            try:
                value, kind = reg.QueryValueEx(key, name)
            except OSError:
                continue
            if kind == reg.REG_DWORD and value != 0:
                saved[name] = value
        if not saved:
            return False
        os.makedirs(os.path.dirname(TOUCHPAD_RESTORE_FILE), exist_ok=True)
        with open(TOUCHPAD_RESTORE_FILE, "w", encoding="utf-8") as f:
            json.dump(saved, f)
        for name in saved:
            reg.SetValueEx(key, name, 0, reg.REG_DWORD, 0)
    _broadcast_setting_change()
    logger.info(f"[lockdown] touchpad gestures off: {', '.join(sorted(saved))}")
    return True


def touchpad_restore(reg=None):
    """Puts back whatever touchpad_disable() changed, including after a crash."""
    try:
        with open(TOUCHPAD_RESTORE_FILE, encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return False
    if reg is None:
        import winreg as reg
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, TOUCHPAD_KEY, 0, reg.KEY_SET_VALUE) as key:
            for name, value in saved.items():
                if name in TOUCHPAD_VALUES and isinstance(value, int):
                    reg.SetValueEx(key, name, 0, reg.REG_DWORD, value)
    except OSError as e:
        logger.warning(f"[lockdown] touchpad restore failed: {e}")
        return False
    try:
        os.remove(TOUCHPAD_RESTORE_FILE)
    except OSError:
        pass
    _broadcast_setting_change()
    logger.info("[lockdown] touchpad gestures restored")
    return True


class InterviewLockdown:
    def __init__(self):
        self._lock = threading.Lock()
        self.active = False
        self.hwnd = 0
        self.pid = 0
        self._events = []
        self._watcher = None
        self._keys = _KeyHook()
        self.touchpad = False

    def start(self, hwnd, pid):
        if OS_NAME != "Windows":
            return {"active": False, "supported": False}
        with self._lock:
            self.hwnd, self.pid = int(hwnd), int(pid)
            if self.active:
                return self.poll_locked()
            self.active = True
            self._events = []
        self._keys.start()
        try:
            self.touchpad = touchpad_disable()
        except Exception as e:
            logger.warning(f"[lockdown] touchpad gestures unchanged: {e}")
            self.touchpad = False
        self._watcher = threading.Thread(target=self._watch, name="lockdown-focus", daemon=True)
        self._watcher.start()
        logger.info(f"[lockdown] on for window {self.hwnd} (pid {self.pid})")
        return self.poll()

    def stop(self):
        with self._lock:
            was_active = self.active
            self.active = False
        self._keys.stop()
        if self._watcher:
            self._watcher.join(2)
            self._watcher = None
        if OS_NAME == "Windows":
            touchpad_restore()
        self.touchpad = False
        if was_active:
            logger.info("[lockdown] off")
        return {"active": False, "supported": OS_NAME == "Windows"}

    def poll(self):
        with self._lock:
            return self.poll_locked()

    def poll_locked(self):
        events, self._events = self._events, []
        return {
            "active": self.active,
            "supported": OS_NAME == "Windows",
            "keys_hooked": self._keys.alive(),
            "keys_blocked": self._keys.blocked,
            "touchpad_locked": self.touchpad,
            "events": events,
        }

    def _record(self, event):
        with self._lock:
            self._events.append({**event, "at": datetime.now().isoformat()})
            del self._events[:-20]

    def _bring_back(self, u, fg):
        import ctypes

        me = ctypes.windll.kernel32.GetCurrentThreadId()
        fg_thread = u.GetWindowThreadProcessId(fg, None) if fg else 0
        attached = bool(fg_thread and fg_thread != me and u.AttachThreadInput(me, fg_thread, True))
        try:
            u.BringWindowToTop(self.hwnd)
            if not u.SetForegroundWindow(self.hwnd):
                u.SwitchToThisWindow(self.hwnd, True)
        finally:
            if attached:
                u.AttachThreadInput(me, fg_thread, False)

    def _watch(self):
        import ctypes
        from ctypes import wintypes

        u = _user32()
        try:
            on_current_desktop = _virtual_desktop_check()
        except Exception as e:
            logger.warning(f"[lockdown] virtual desktop check unavailable: {e}")
            on_current_desktop = lambda hwnd: None  # noqa: E731
        lost = False
        away = False
        while self.active:
            try:
                fg = u.GetForegroundWindow()
                pid = wintypes.DWORD()
                if fg:
                    u.GetWindowThreadProcessId(fg, ctypes.byref(pid))
                if focus_change(fg, pid.value, self.hwnd, self.pid) == "lost":
                    if not lost:
                        name = _process_name(pid.value)
                        self._record({"type": "focus_lost", "process": name,
                                      "display_name": display_name(name)})
                    lost = True
                    self._bring_back(u, fg)
                else:
                    lost = False
                on_desktop = on_current_desktop(self.hwnd)
                if on_desktop is False and not away:
                    self._record({"type": "virtual_desktop"})
                    self._bring_back(u, fg)
                away = on_desktop is False
            except Exception as e:
                logger.warning(f"[lockdown] focus watch error: {e}")
            time.sleep(LOCKDOWN_WATCH_S)


def _process_name(pid):
    try:
        return psutil.Process(pid).name()
    except Exception:
        return ""


LOCKDOWN = InterviewLockdown()


# ─────────────────────────────────────────────
#  STDIO PIPE PROTOCOL (primary Electron channel)
#  Newline-delimited JSON. Request:  {"id": <n>, "cmd": "ping"|"status"|"scan"|"lockdown_*", "args": {...}}
#  Response: {"id": <n>, ...result}  written to stdout, one object per line.
#  Unsolicited, no id: {"event": "ready", ...} once, then {"type": "process_started", "name", "pid"}.
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

def _handle_command(cmd, args=None):
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
    if cmd == "lockdown_start":
        args = args or {}
        return LOCKDOWN.start(args.get("hwnd", 0), args.get("pid", 0))
    if cmd == "lockdown_poll":
        return LOCKDOWN.poll()
    if cmd == "lockdown_stop":
        return LOCKDOWN.stop()
    return {"error": "unknown_cmd", "cmd": cmd}

# Answered inline; anything else runs on a worker so a slow scan can't delay a ping.
_INLINE_CMDS = ("ping", "status", "log", "lockdown_poll")

# Scans coalesce, so this cap only stops a runaway client spawning threads.
MAX_WORKER_THREADS = 8
_worker_count = 0
_worker_count_lock = threading.Lock()

def _dispatch(req_id, cmd, args=None):
    """Run one command and write its response. Responses carry `id`, so the
    parent matches them regardless of arrival order."""
    try:
        resp = _handle_command(cmd, args)
    except Exception as e:
        logger.warning(f"command error: {e}")
        resp = {"error": str(e)}
    resp["id"] = req_id
    _write_response(resp)

def _dispatch_worker(req_id, cmd, args=None):
    global _worker_count
    try:
        _dispatch(req_id, cmd, args)
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
    threading.Thread(
        target=process_watcher, args=(_write_response,), name="process-watcher", daemon=True
    ).start()
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
        args = req.get("args") if isinstance(req.get("args"), dict) else None

        if cmd in _INLINE_CMDS:
            _dispatch(req_id, cmd, args)
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
            target=_dispatch_worker, args=(req_id, cmd, args), daemon=True
        ).start()
    logger.info("stdin closed — agent shutting down.")
    LOCKDOWN.stop()

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

    if OS_NAME == "Windows":
        touchpad_restore()

    scanner_thread = threading.Thread(target=background_scanner, daemon=True)
    scanner_thread.start()

    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    stdio_protocol_loop()

if __name__ == "__main__":
    main()
