#!/usr/bin/env python3
"""Sức khoẻ ghost-mcp-secure: git, server remote trên Railway (/healthz), node_modules. Chỉ đọc, không sửa gì.

  python3 tools/health.py            bảng ✓ / ⚠ / ✗, mã thoát 1 nếu có ✗
  python3 tools/health.py --json     {at, site, checks:[{area, name, level, detail}]}
  python3 tools/health.py --only git|api|build

Python 3.9 stdlib (/usr/bin/python3). Chỉ GET /healthz công khai — không gửi token, không in bí mật.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = os.environ.get("GHOST_MCP_SITE", "https://ghost-mcp-secure-production.up.railway.app")
TIMEOUT = 5.0
SLOW = 3.0


def item(area: str, name: str, level: str, detail: str = "") -> dict:
    return {"area": area, "name": name, "level": level, "detail": detail}


def git(*args: str) -> tuple[int, str]:
    p = subprocess.run(["git", *args], capture_output=True, text=True, cwd=ROOT)
    return p.returncode, p.stdout.strip()


def check_git() -> list[dict]:
    out = []
    code, branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if code != 0:
        return [item("git", "repo", "bad", "không phải repo git")]
    out.append(item("git", "nhánh", "ok" if branch == "main" else "warn", branch))
    code, n = git("rev-list", "--count", "@{u}..HEAD")
    if code != 0:
        out.append(item("git", "commit chưa push", "warn", "nhánh chưa có upstream"))
    else:
        out.append(item("git", "commit chưa push", "ok" if n == "0" else "warn", n))
    _, status = git("status", "--porcelain")
    dirty = [l for l in status.splitlines() if l.strip()]
    out.append(item("git", "file chưa commit", "ok" if not dirty else "warn", f"{len(dirty)} file"))
    return out


def check_api() -> list[dict]:
    path = "/healthz"
    req = urllib.request.Request(SITE + path, headers={"User-Agent": "ghost-mcp-health/1", "Accept": "text/plain"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            code, body = r.status, r.read(64).decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        return [item("api", path, "bad", f"{e.code} · {time.monotonic() - t0:.1f}s")]
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, socket.timeout) or "timed out" in str(reason).lower():
            return [item("api", path, "bad", f"timeout {TIMEOUT:.0f}s")]
        return [item("api", path, "bad", str(reason)[:120])]
    dt = time.monotonic() - t0
    if code != 200 or body != "ok":
        return [item("api", path, "bad", f"{code} · {dt:.1f}s · body {body[:20]!r}")]
    return [item("api", path, "warn" if dt > SLOW else "ok", f"{code} ok · {dt:.1f}s")]


def check_build() -> list[dict]:
    nm = ROOT / "node_modules"
    return [item("build", "node_modules", "ok" if nm.is_dir() else "warn",
                 "có" if nm.is_dir() else "chưa npm ci — test chỉ node --check, bỏ smoke:remote")]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="tools/health.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", choices=["git", "api", "build"])
    a = ap.parse_args(argv)
    parts = {"git": check_git, "api": check_api, "build": check_build}
    results = [r for k, fn in parts.items() if not a.only or a.only == k for r in fn()]
    if a.json:
        print(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "site": SITE, "checks": results}, ensure_ascii=False, indent=2))
    else:
        icon = {"ok": "✓", "warn": "⚠", "bad": "✗"}
        area = None
        for r in results:
            if r["area"] != area:
                area = r["area"]
                print({"git": "Git", "api": f"Production {SITE}", "build": "Build local"}[area])
            print(f"  {icon[r['level']]} {r['name']}: {r['detail']}")
        bad = sum(r["level"] == "bad" for r in results)
        warn = sum(r["level"] == "warn" for r in results)
        print(f"== {len(results)} mục: {bad} lỗi, {warn} cảnh báo")
    return 1 if any(r["level"] == "bad" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
