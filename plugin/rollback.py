"""Out-of-process rollback for a Winglet update that never reported health.

The CLI entry point (``hermes winglet rollback``) and the systemd watchdog both
use this module.  It imports only ``update_rollback`` and the standard library,
so it still runs when the installed plugin package cannot be imported at all.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

try:  # package import (the gateway and the CLI)
    from . import update_rollback
    from . import self_update
except ImportError:  # installed as a standalone script next to update_rollback.py
    import update_rollback  # type: ignore
    import self_update  # type: ignore


def _gateway_pid(home: Path) -> Optional[int]:
    for candidate in (Path(home) / "gateway.pid", self_update.hermes_home(home) / "gateway.pid"):
        try:
            pid = int(candidate.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            continue
        if pid > 0:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            except PermissionError:
                pass
            return pid
    return None


def _run_hermes(args, timeout=60) -> bool:
    executable = shutil.which("hermes")
    if not executable:
        return False
    try:
        subprocess.run([executable, *args], check=False, timeout=timeout,
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _audit(root: Path, summary: str, outcome: str = "ok") -> None:
    """Write the rollback entry without importing the gateway (the plugin may be broken)."""
    db = root / "plugin-data" / "winglet" / "data.db"
    if not db.is_file():
        return
    try:
        with sqlite3.connect(db) as conn:
            conn.execute("INSERT INTO audit (ts, device_id, device_name, role, action, summary, outcome) "
                         "VALUES (?, '', '', '', 'self_update.rollback', ?, ?)",
                         (time.time(), summary[:300], outcome[:32]))
    except (OSError, sqlite3.Error):
        pass


def rollback(home=None, *, now=None, stop: Optional[Callable[[], bool]] = None,
             start: Optional[Callable[[], bool]] = None, running: Optional[Callable[[], bool]] = None,
             out=None) -> int:
    """Read the marker, restore its backup and restart the gateway.

    Returns 0 when the backup was restored and the gateway was asked to start
    again, 1 when the marker is missing or unusable, and 2 when the restore was
    refused because the gateway could not be stopped (never restore a database
    under a running gateway).
    """
    out = out or (lambda text: print(text))
    root = self_update.hermes_home(home)
    try:
        marker = self_update.read_marker(root)
    except ValueError as exc:
        out(f"Cannot roll back: {exc}")
        return 1
    if not marker:
        out("No Winglet update marker is present; nothing to roll back.")
        return 0
    frm, to = marker.get("from"), marker.get("to")
    backup_text = marker.get("backup")
    if not isinstance(frm, str) or not isinstance(to, str) or not isinstance(backup_text, str) or not backup_text:
        out("Cannot roll back: the update marker is incomplete.")
        return 1
    backup = Path(backup_text).expanduser()
    if not backup.is_absolute():
        backup = (root / backup).resolve()
    backups_root = (root / "backups" / update_rollback.BACKUP_FOLDER).resolve()
    try:
        inside = backup.resolve() == backups_root or backups_root in backup.resolve().parents
    except OSError:
        inside = False
    if not inside or not (backup / "manifest.json").is_file():
        out(f"Cannot roll back: the backup named by the marker is not a Winglet backup: {backup}")
        return 1

    running = running or (lambda: _gateway_pid(root) is not None)
    was_running = bool(running())
    if was_running:
        stopped = (stop or (lambda: _run_hermes(["gateway", "stop"])))()
        deadline = time.monotonic() + 30
        while running() and time.monotonic() < deadline:
            time.sleep(0.5)
        if running():
            out("The gateway did not stop, so the database was not restored (never restore a database under a "
                "running gateway). Stop the gateway and run `hermes winglet rollback` again.")
            _audit(root, f"refused to restore {frm} from {backup}: the gateway did not stop", "refused")
            return 2

    try:
        report = update_rollback.restore(root, backup, time.time() if now is None else now, with_database=True)
    except update_rollback.RollbackError as exc:
        out(f"Rollback failed: {exc}")
        if getattr(exc, "done", None):
            out("Restored before it stopped: " + ", ".join(exc.done))
        return 1
    except Exception as exc:
        out(f"Rollback failed: {exc}")
        return 1

    try:
        self_update.clear_marker(root)
    except ValueError as exc:
        out(f"Restored, but the marker could not be cleared: {exc}")

    out(f"Restored Winglet {report.get('from')} from {backup}.")
    out("Restored: " + ", ".join(report.get("done") or []) + ".")
    out(f"The failed version is kept in {report.get('kept')}.")
    _audit(root, f"restored {report.get('from')} after {to} failed")
    started = (start or (lambda: _run_hermes(["gateway", "start"])))()
    if started:
        out("The gateway was asked to start again.")
    else:
        out("The gateway is not running. Start it with `hermes gateway start`.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="hermes winglet rollback",
                                     description="Restore the Winglet plugin from the last update's backup")
    parser.add_argument("--home", default=None, help="Hermes home (default: HERMES_HOME or ~/.hermes)")
    args = parser.parse_args(argv)
    return rollback(args.home)


if __name__ == "__main__":
    raise SystemExit(main())
