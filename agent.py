"""
=============================================================
  INTERVIEW SECURITY DESKTOP AGENT
  Detects cheating tools at OS level and reports to browser
  Supports: Windows, macOS, Linux
  Communication: Local HTTP Server on port 9999
  
  Enhanced with behavioral detection:
  - Network signatures
  - File access patterns
  - Memory analysis
  - DLL/library detection
  - Window class signatures
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
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler

# ─────────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────────
PORT = 9999
SCAN_INTERVAL = 3  # seconds between scans
LOG_FILE = "agent_log.json"

# Known cheating tool process names (cross-platform)
BANNED_PROCESSES = [
    # ParakeetAI
    "pmodule", "parakeet", "parakeetai",
    # AI Assistants
    "chatgpt", "claude", "copilot", "gemini",
    # Screen recorders
    "obs", "obs64", "obs32", "obs-studio",
    "bandicam", "fraps", "camtasia",
    "screenrecorder", "kazam", "simplescreenrecorder",
    # Remote desktop / sharing
    "teamviewer", "teamviewer_desktop",
    "anydesk",
    "rustdesk",
    "vnc", "vncviewer", "tvnviewer",
    "ultraviewer",
    # Virtual camera (used to fake webcam)
    "manycam", "xsplit", "splitcam",
    # AI overlay tools
    "interview", "interviewai", "copilotai",
    "wonsulting", "finalroundai", "final_round",
]

# Known cheating tool window title keywords
BANNED_WINDOW_TITLES = [
    "parakeet", "chatgpt", "claude ai", "gemini",
    "copilot", "interview assistant", "ai answer",
    "screen recorder", "obs studio", "bandicam",
    "teamviewer", "anydesk", "remote desktop",
    "final round", "interview copilot",
]

# Known AI API domains (for future network monitoring)
BANNED_DOMAINS = [
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.parakeet-ai.com",
]

# Allowed/whitelisted processes (development tools, browsers)
WHITELISTED_PROCESSES = [
    "code", "code.exe",  # Visual Studio Code
    "chrome", "chrome.exe", "chromium",  # Chrome/Chromium browsers
    "firefox", "firefox.exe",  # Firefox
    "msedge", "msedge.exe", "msedgewebview2", "msedgewebview2.exe",  # Microsoft Edge & WebView
    "iexplore", "iexplore.exe",  # Internet Explorer
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
    "warnings": [],
    "display_count": 1,
    "safe_to_proceed": False,
    "scan_count": 0,
    "agent_version": "1.0.0"
}
scan_lock = threading.Lock()
event_log = []

# ─────────────────────────────────────────────
#  PROCESS SCANNER
# ─────────────────────────────────────────────
def scan_processes():
    """Scan all running processes for banned applications."""
    threats = []
    try:
        for proc in psutil.process_iter(['pid', 'name', 'exe', 'cmdline']):
            try:
                proc_name = (proc.info['name'] or "").lower()
                proc_exe  = (proc.info['exe']  or "").lower()
                proc_cmd  = " ".join(proc.info['cmdline'] or []).lower()

                # Check if process is whitelisted (allowed)
                is_whitelisted = False
                for whitelisted in WHITELISTED_PROCESSES:
                    if (whitelisted in proc_name or
                        whitelisted in proc_exe  or
                        whitelisted in proc_cmd):
                        is_whitelisted = True
                        break
                
                # Skip whitelisted processes
                if is_whitelisted:
                    continue

                for banned in BANNED_PROCESSES:
                    if (banned in proc_name or
                        banned in proc_exe  or
                        banned in proc_cmd):
                        threats.append({
                            "type": "banned_process",
                            "severity": "HIGH",
                            "detail": f"Banned application detected: '{proc.info['name']}' (PID {proc.info['pid']})",
                            "process": proc.info['name'],
                            "pid": proc.info['pid']
                        })
                        break
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception as e:
        logger.error(f"Process scan error: {e}")
    return threats

# ─────────────────────────────────────────────
#  WINDOW TITLE SCANNER
# ─────────────────────────────────────────────
def scan_windows():
    """Scan open window titles for banned/suspicious keywords."""
    threats = []
    titles = []

    try:
        if OS_NAME == "Windows":
            titles = _get_windows_titles_win()
        elif OS_NAME == "Darwin":
            titles = _get_windows_titles_mac()
        elif OS_NAME == "Linux":
            titles = _get_windows_titles_linux()
    except Exception as e:
        logger.warning(f"Window scan error: {e}")
        return threats

    for title in titles:
        title_lower = title.lower()
        for keyword in BANNED_WINDOW_TITLES:
            if keyword in title_lower:
                threats.append({
                    "type": "banned_window",
                    "severity": "HIGH",
                    "detail": f"Suspicious window detected: '{title}'",
                    "window_title": title
                })
                break
    return threats

def _get_windows_titles_win():
    """Get all window titles on Windows."""
    import ctypes
    titles = []
    EnumWindows = ctypes.windll.user32.EnumWindows
    GetWindowText = ctypes.windll.user32.GetWindowTextW
    GetWindowTextLength = ctypes.windll.user32.GetWindowTextLengthW
    IsWindowVisible = ctypes.windll.user32.IsWindowVisible

    def callback(hwnd, _):
        if IsWindowVisible(hwnd):
            length = GetWindowTextLength(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                GetWindowText(hwnd, buf, length + 1)
                if buf.value.strip():
                    titles.append(buf.value)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))
    EnumWindows(WNDENUMPROC(callback), 0)
    return titles

def _get_windows_titles_mac():
    """Get all window titles on macOS using AppleScript."""
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

def _get_windows_titles_linux():
    """Get all window titles on Linux using wmctrl."""
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
#  DISPLAY / MONITOR SCANNER
# ─────────────────────────────────────────────
def scan_displays():
    """Count connected monitors and flag multiple displays."""
    warnings = []
    count = 1

    try:
        if OS_NAME == "Windows":
            import ctypes
            count = ctypes.windll.user32.GetSystemMetrics(80)  # SM_CMONITORS

        elif OS_NAME == "Darwin":
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType"],
                capture_output=True, text=True, timeout=5
            )
            count = result.stdout.count("Resolution:")

        elif OS_NAME == "Linux":
            result = subprocess.run(
                ["xrandr", "--listmonitors"],
                capture_output=True, text=True, timeout=5
            )
            lines = [l for l in result.stdout.strip().split("\n") if l.strip() and "Monitors" not in l]
            count = max(1, len(lines))

    except Exception as e:
        logger.warning(f"Display scan error: {e}")

    if count > 1:
        warnings.append({
            "type": "multiple_displays",
            "severity": "MEDIUM",
            "detail": f"{count} monitors detected. Secondary displays must be disconnected.",
            "display_count": count
        })

    return warnings, count

# ─────────────────────────────────────────────
#  SCREEN SHARING / RECORDING DETECTION
# ─────────────────────────────────────────────
def scan_screen_sharing():
    """Detect active screen sharing or recording sessions."""
    threats = []

    sharing_processes = [
        "zoom", "zoomus", "zoom.us",
        "teams", "msteams",
        "meet",  # Google Meet
        "discord",
        "slack",
        "webex", "ciscowebex",
        "gotomeeting",
        "screenshare", "screen_share",
    ]

    # On macOS, check for screen capture permissions in use
    if OS_NAME == "Darwin":
        try:
            result = subprocess.run(
                ["lsof", "-c", "screencaptureui"],
                capture_output=True, text=True, timeout=3
            )
            if result.stdout.strip():
                threats.append({
                    "type": "screen_capture_active",
                    "severity": "HIGH",
                    "detail": "Screen capture utility is currently active on this Mac."
                })
        except Exception:
            pass

    # Check for virtual camera drivers (used by ParakeetAI-like tools)
    virtual_cam_drivers = ["manycam", "xsplit", "obs-virtualcam", "droidcam", "iriun"]
    for proc in psutil.process_iter(['name']):
        try:
            name = (proc.info['name'] or "").lower()
            for driver in virtual_cam_drivers:
                if driver in name:
                    threats.append({
                        "type": "virtual_camera",
                        "severity": "HIGH",
                        "detail": f"Virtual camera software detected: '{proc.info['name']}'. This can be used to fake webcam feeds."
                    })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return threats

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

def detect_suspicious_network_activity():
    """
    Detect applications making connections to known cheating/AI API domains.
    Works even if application is renamed, by checking network signatures.
    """
    threats = []
    
    # Known malicious API endpoints and domains
    SUSPICIOUS_DOMAINS = [
        "openai.com", "api.openai.com",
        "anthropic.com", "api.anthropic.com",
        "parakeet", "parakeetai",
        "claude", "api.claude",
        "gemini", "google.generativelanguage",
        "api.parakeet",
        "interview-cheat",
        "answer-ai",
    ]
    
    try:
        if OS_NAME != "Windows":
            return threats  # Requires Windows netstat
        
        # Get all network connections
        result = subprocess.run(
            ["netstat", "-ano"], 
            capture_output=True, text=True, timeout=5
        )
        
        connections = []
        for line in result.stdout.split('\n'):
            if 'ESTABLISHED' in line:
                parts = line.split()
                if len(parts) >= 5:
                    try:
                        remote_addr = parts[2]
                        pid = int(parts[4])
                        connections.append({'addr': remote_addr, 'pid': pid})
                    except (ValueError, IndexError):
                        continue
        
        # Check if suspicious processes are connecting to suspicious domains
        suspicious_pids = {}
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                pid = proc.info['pid']
                name = (proc.info['name'] or "").lower()
                
                # Flag processes with suspicious behaviors
                if any(x in name for x in ['helper', 'service', 'process', 'proxy', 'tunnel']):
                    suspicious_pids[pid] = name
                    
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        
        # Map connections to suspicious domains
        for conn in connections:
            addr = conn['addr']
            pid = conn['pid']
            
            for domain in SUSPICIOUS_DOMAINS:
                if domain in addr:
                    try:
                        proc = psutil.Process(pid)
                        threats.append({
                            "type": "suspicious_network",
                            "severity": "HIGH",
                            "detail": f"Process {proc.name()} (PID {pid}) connecting to suspicious domain: {addr}",
                            "process": proc.name(),
                            "pid": pid,
                            "target": addr
                        })
                    except psutil.NoSuchProcess:
                        pass
    
    except Exception as e:
        logger.warning(f"Network detection error: {e}")
    
    return threats

def detect_suspicious_memory_patterns():
    """
    Detect processes with suspicious memory patterns or DLL imports.
    Catches renamed applications by looking for imported DLLs from AI tools.
    """
    threats = []
    
    SUSPICIOUS_DLLS = [
        "parakeet", "openai", "anthropic", "claude",
        "gemini", "interview", "cheat", "answer",
        "api_client", "http_tunnel", "proxy_socket"
    ]
    
    if OS_NAME != "Windows":
        return threats  # Requires Windows PE analysis
    
    try:
        for proc in psutil.process_iter(['pid', 'name', 'exe']):
            try:
                pid = proc.info['pid']
                exe_path = proc.info['exe']
                
                # Skip system processes
                if not exe_path or 'windows' in exe_path.lower() or 'system32' in exe_path.lower():
                    continue
                
                # Try to read loaded modules (requires Windows DLL analysis)
                try:
                    # Use tasklist with /m to show loaded modules
                    result = subprocess.run(
                        ["tasklist", "/FI", f"PID eq {pid}", "/M"],
                        capture_output=True, text=True, timeout=2
                    )
                    
                    modules = result.stdout.lower()
                    for suspicious_dll in SUSPICIOUS_DLLS:
                        if suspicious_dll in modules:
                            threats.append({
                                "type": "suspicious_dll",
                                "severity": "HIGH",
                                "detail": f"Process {proc.info['name']} loaded suspicious module: {suspicious_dll}",
                                "process": proc.info['name'],
                                "pid": pid,
                                "module": suspicious_dll
                            })
                            break
                except:
                    pass
                    
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    
    except Exception as e:
        logger.warning(f"Memory pattern detection error: {e}")
    
    return threats

def detect_suspicious_file_access():
    """
    Monitor file access patterns for suspicious activity.
    Detects tools trying to access interview systems or inject code.
    """
    threats = []
    
    SUSPICIOUS_PATTERNS = [
        # Only check for actual automation driver tools, not browsers
        "chromedriver",
        "edgedriver",
        "phantomjs",
        "selenium",
    ]
    
    WATCH_FOLDERS = [
        os.path.expanduser("~\\AppData\\Local\\Temp"),
        os.path.expanduser("~\\AppData\\Roaming"),
        os.path.expanduser("~\\Downloads"),
    ]
    
    if OS_NAME != "Windows":
        return threats
    
    try:
        # Check for selenium/webdriver processes
        for proc in psutil.process_iter(['pid', 'name', 'exe', 'cmdline']):
            try:
                exe_path = (proc.info['exe'] or "").lower()
                cmd_line = " ".join(proc.info['cmdline'] or []).lower()
                
                # Detect browser automation frameworks
                if any(x in exe_path or x in cmd_line for x in 
                       ['chromedriver', 'geckodriver', 'edgedriver', 'phantomjs', 'selenium']):
                    threats.append({
                        "type": "browser_automation",
                        "severity": "HIGH",
                        "detail": f"Browser automation tool detected: {proc.info['name']}",
                        "process": proc.info['name'],
                        "pid": proc.info['pid']
                    })
                    
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    
    except Exception as e:
        logger.warning(f"File access detection error: {e}")
    
    return threats

def detect_suspicious_window_properties():
    """
    Detect suspicious window properties and behaviors.
    Can identify renamed windows by checking class names and properties.
    """
    threats = []
    
    SUSPICIOUS_WINDOW_CLASSES = [
        "IEFrame",  # IE automation
        "MozillaWindowClass",  # Firefox automation
        "tcpListener",  # Socket listeners
        "websocketServer",
        "apiProxy",
        "tunnelServer",
    ]
    
    # Whitelisted window classes (legitimate browsers and tools)
    WHITELISTED_WINDOW_CLASSES = [
        "chrome",  # Chrome/Chromium browsers
        "widgetwin",  # Chrome widgets
        "msedge",  # Microsoft Edge
        "firefox",  # Firefox (normal windows, not automation)
        "opera",  # Opera browser
    ]
    
    if OS_NAME != "Windows":
        return threats
    
    try:
        import ctypes
        from ctypes import wintypes
        
        GetWindowClass = ctypes.windll.user32.GetClassNameW
        EnumWindows = ctypes.windll.user32.EnumWindows
        IsWindowVisible = ctypes.windll.user32.IsWindowVisible
        
        found_windows = []
        
        def callback(hwnd, _):
            if IsWindowVisible(hwnd):
                try:
                    class_name = ctypes.create_unicode_buffer(256)
                    GetWindowClass(hwnd, class_name, 256)
                    if class_name.value:
                        found_windows.append(class_name.value.lower())
                except:
                    pass
            return True
        
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))
        EnumWindows(WNDENUMPROC(callback), 0)
        
        # Check for suspicious window classes
        for window_class in found_windows:
            # Skip whitelisted window classes
            is_whitelisted_window = False
            for whitelisted in WHITELISTED_WINDOW_CLASSES:
                if whitelisted.lower() in window_class:
                    is_whitelisted_window = True
                    break
            
            if is_whitelisted_window:
                continue
            
            for suspicious in SUSPICIOUS_WINDOW_CLASSES:
                if suspicious.lower() in window_class:
                    threats.append({
                        "type": "suspicious_window_class",
                        "severity": "MEDIUM",
                        "detail": f"Suspicious window class detected: {window_class}",
                        "window_class": window_class
                    })
                    break
    
    except Exception as e:
        logger.warning(f"Window property detection error: {e}")
    
    return threats

# ─────────────────────────────────────────────
#  MAIN SCAN ORCHESTRATOR
# ─────────────────────────────────────────────
def run_full_scan():
    """Run all security checks and compile results."""
    global scan_results, event_log

    threats  = []
    warnings = []

    # 1. Process scan (detects known process names)
    proc_threats = scan_processes()
    threats.extend(proc_threats)

    # 2. Window scan (detects suspicious window titles)
    win_threats = scan_windows()
    threats.extend(win_threats)

    # 3. Display scan
    disp_warnings, display_count = scan_displays()
    warnings.extend(disp_warnings)

    # 4. Screen sharing / virtual camera
    share_threats = scan_screen_sharing()
    threats.extend(share_threats)
    
    # 5. BEHAVIORAL DETECTIONS (catches renamed applications)
    # ─────────────────────────────────────────────────────
    
    # Check for suspicious network connections to AI/cheating service APIs
    network_threats = detect_suspicious_network_activity()
    threats.extend(network_threats)
    
    # Check for suspicious DLL imports and memory patterns
    memory_threats = detect_suspicious_memory_patterns()
    threats.extend(memory_threats)
    
    # Check for file access patterns indicating cheating tools
    file_threats = detect_suspicious_file_access()
    threats.extend(file_threats)
    
    # Check for suspicious window classes (browser automation, etc.)
    window_threats = detect_suspicious_window_properties()
    threats.extend(window_threats)

    # Determine overall status
    safe = len(threats) == 0
    status = "CLEAR" if safe else "THREAT_DETECTED"

    timestamp = datetime.now().isoformat()

    result = {
        "status": status,
        "timestamp": timestamp,
        "os": OS_NAME,
        "threats": threats,
        "warnings": warnings,
        "display_count": display_count,
        "safe_to_proceed": safe,
        "scan_count": scan_results.get("scan_count", 0) + 1,
        "agent_version": "1.0.0"
    }

    # Log the event
    log_entry = {
        "timestamp": timestamp,
        "threat_count": len(threats),
        "warning_count": len(warnings),
        "safe": safe,
        "threats": [t["detail"] for t in threats],
        "warnings": [w["detail"] for w in warnings]
    }
    event_log.append(log_entry)

    # Save log to file
    try:
        with open(LOG_FILE, "w") as f:
            json.dump(event_log, f, indent=2)
    except Exception:
        pass

    if threats:
        for t in threats:
            logger.warning(f"[THREAT] {t['detail']}")
    else:
        logger.info(f"[SCAN #{result['scan_count']}] System is CLEAR.")

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
class AgentHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        # CORS headers so browser can call this
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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
                "agent": "Interview Security Agent v1.0.0",
                "os": OS_NAME,
                "port": PORT
            }).encode())

        else:
            self.wfile.write(json.dumps({"error": "Unknown endpoint"}).encode())

    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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
    logger.info("  INTERVIEW SECURITY DESKTOP AGENT  v1.0.0")
    logger.info(f"  OS: {OS_NAME}  |  Port: {PORT}")
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
