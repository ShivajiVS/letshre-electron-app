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
    "openai.com", "api.openai.com",
    "anthropic.com", "api.anthropic.com",
    "parakeet", "parakeetai", "api.parakeet",
    "claude", "api.claude",
    "gemini", "google.generativelanguage",
    "interview-cheat", "answer-ai",
]

# DLL / module name fragments that indicate AI tools
SUSPICIOUS_DLLS = [
    "parakeet", "openai", "anthropic", "claude",
    "gemini", "interview", "cheat", "answer",
    "api_client", "http_tunnel", "proxy_socket",
]

# Win32 window class names that indicate automation / injection tools
SUSPICIOUS_WINDOW_CLASSES = [
    "IEFrame",        # IE automation
    "MozillaWindowClass",  # Firefox automation
    "tcpListener",
    "websocketServer",
    "apiProxy",
    "tunnelServer",
]

# Window title keywords that suggest cheating tools
SUSPICIOUS_WINDOW_TITLES = [
    "parakeet", "chatgpt", "claude ai", "gemini",
    "copilot", "interview assistant", "ai answer",
    "final round", "interview copilot",
]

OS_NAME = platform.system()  # 'Windows', 'Darwin', 'Linux'

# ─────────────────────────────────────────────
#  LOGGING SETUP
# ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
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
#  MAIN SCAN ORCHESTRATOR
# ─────────────────────────────────────────────
def run_full_scan():
    """
    Run all 5 behavioral deep-detection checks and compile results.
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
        "agent_version": AGENT_VERSION  # IMP-12
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
    """Start the local HTTP server."""
    try:
        server = HTTPServer(("127.0.0.1", PORT), AgentHandler)
        logger.info(f"HTTP server running at http://127.0.0.1:{PORT}")
        logger.info(f"  /ping   → Health check")
        logger.info(f"  /status → Latest scan result")
        logger.info(f"  /scan   → Trigger immediate scan")
        logger.info(f"  /log    → Full event log")
        server.serve_forever()
    except OSError as e:
        logger.error(f"Cannot start server on port {PORT}: {e}")
        logger.error("Is the agent already running? Close the other instance first.")
        sys.exit(1)

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

    logger.info("Running initial scan...")
    run_full_scan()

    # Start background scanner in a daemon thread
    scanner_thread = threading.Thread(target=background_scanner, daemon=True)
    scanner_thread.start()

    # Start HTTP server (blocking — keeps the agent alive)
    start_http_server()

if __name__ == "__main__":
    main()
