"""
build_agent.py
==============
Builds agent.py into a standalone executable using PyInstaller.
Run this before `pnpm run build:full` to produce the binary that gets
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
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT      = Path(__file__).parent.parent          # repo root
AGENT_SRC = ROOT / "agent.py"
OUT_DIR   = ROOT / "resources"                    # electron-builder picks up from here
DIST_DIR  = ROOT / "dist"                         # PyInstaller default output
STAMP_SRC = ROOT / "_build_stamp.py"              # generated, imported by agent.py
STAMP_OUT = OUT_DIR / "agent.build.json"          # read by check-agent-freshness.js
EXPECT_OUT = ROOT / "src" / "shared" / "agentBuild.json"  # packaged; runtime drift check


def source_sha():
    return hashlib.sha256(AGENT_SRC.read_bytes()).hexdigest()

def check_pyinstaller():
    try:
        import PyInstaller
    except ImportError:
        print("[build_agent] PyInstaller not found — installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller", "psutil"])

def build():
    check_pyinstaller()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Stamps the source hash into the binary so an installed agent can say which
    # agent.py produced it. Written before the build, removed after.
    sha = source_sha()
    STAMP_SRC.write_text(f'SOURCE_SHA = "{sha}"\n', encoding="utf8")

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
        "--hidden-import", "_build_stamp",
        str(AGENT_SRC),
    ]

    try:
        result = subprocess.run(cmd, cwd=str(ROOT))
    finally:
        STAMP_SRC.unlink(missing_ok=True)
    if result.returncode != 0:
        print("[build_agent] ❌ PyInstaller build failed.")
        sys.exit(result.returncode)

    # Copy the binary from dist/ → resources/
    src_bin = DIST_DIR / bin_name
    dst_bin = OUT_DIR  / bin_name

    shutil.copy2(src_bin, dst_bin)

    if not is_win:
        os.chmod(dst_bin, 0o755)   # make executable on Unix

    STAMP_OUT.write_text(
        json.dumps(
            {
                "source_sha": sha,
                "binary": bin_name,
                "built_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf8",
    )

    # The app compares this against the source_sha a running agent reports, so a
    # swapped or stale binary can't pass preflight.
    EXPECT_OUT.write_text(
        json.dumps({"source_sha": sha}, indent=2) + "\n", encoding="utf8"
    )

    print(f"[build_agent] OK Built -> {dst_bin}  ({dst_bin.stat().st_size // 1024} KB)")
    print(f"[build_agent] source_sha {sha[:12]}")

if __name__ == "__main__":
    build()
