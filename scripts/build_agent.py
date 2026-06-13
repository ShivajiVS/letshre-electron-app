"""
build_agent.py
==============
Builds agent.py into a standalone executable using PyInstaller.
Run this before `npm run build` to produce the binary that gets
bundled into the Electron app via extraResources.

Usage:
    python scripts/build_agent.py

Output (Windows):  resources/agent.exe
Output (macOS):    resources/agent          (Unix binary)
"""

import subprocess
import sys
import shutil
import os
from pathlib import Path

ROOT      = Path(__file__).parent.parent          # repo root
AGENT_SRC = ROOT / "agent.py"
OUT_DIR   = ROOT / "resources"                    # electron-builder picks up from here
DIST_DIR  = ROOT / "dist"                         # PyInstaller default output

def check_pyinstaller():
    try:
        import PyInstaller
    except ImportError:
        print("[build_agent] PyInstaller not found — installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller", "psutil"])

def build():
    check_pyinstaller()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Determine output binary name per platform
    is_win   = sys.platform == "win32"
    bin_name = "agent.exe" if is_win else "agent"

    print(f"[build_agent] Building {AGENT_SRC.name} -> {OUT_DIR / bin_name}")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",                         # single self-contained binary
        "--clean",                           # clean PyInstaller cache first
        "--noconfirm",                       # overwrite without asking
        "--distpath", str(DIST_DIR),         # where PyInstaller puts the binary
        "--workpath", str(ROOT / "build_tmp"),
        "--specpath", str(ROOT / "build_tmp"),
        "--name", "agent",
        "--hidden-import", "psutil",
        str(AGENT_SRC),
    ]

    result = subprocess.run(cmd, cwd=str(ROOT))
    if result.returncode != 0:
        print("[build_agent] ❌ PyInstaller build failed.")
        sys.exit(result.returncode)

    # Copy the binary from dist/ → resources/
    src_bin = DIST_DIR / bin_name
    dst_bin = OUT_DIR  / bin_name

    shutil.copy2(src_bin, dst_bin)

    if not is_win:
        os.chmod(dst_bin, 0o755)   # make executable on Unix

    print(f"[build_agent] OK Built -> {dst_bin}  ({dst_bin.stat().st_size // 1024} KB)")

if __name__ == "__main__":
    build()
