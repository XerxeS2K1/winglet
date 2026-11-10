"""Out-of-process rollback for a Winglet update that never reported health.

The CLI entry point (``hermes winglet rollback``) and the systemd watchdog both
use this module.  It imports only ``update_rollback`` and the standard library,
so it still runs when the installed plugin package cannot be imported at all.
"""
from __future__ import annotations

import argparse
import json
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


def _proc_start_time(pid: int) -> Optional[int]:
    """Field 22 of /proc/<pid>/stat: the process start time in clock ticks."""
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        rest = text.rsplit(")", 1)[1].split()
        return int(rest[19])
    except (OSError, IndexError, ValueError):
        return None


def _pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _gateway_pid_info(home: Path):
    """The live gateway pid and, when relevant, why it could not be verified.

    Hermes writes ``{"pid": 123, "start_time": 456, ...}``.  The recorded start
    time is checked against /proc so a recycled pid cannot be mistaken for the
    gateway.  If /proc cannot be read, the pid is still alive: fail closed by
    returning it with a reason instead of treating the gateway as dead.
    """
    for candidate in (Path(home) / "gateway.pid", self_update.hermes_home(home) / "gateway.pid"):
        try:
            raw = candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            record = None
        if isinstance(record, dict):
            kind = record.get("kind")
            if kind is not None and kind != "hermes-gateway":
                continue
            pid = record.get("pid")
            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                continue
            recorded_start = record.get("start_time")
            if recorded_start is not None:
                actual = _proc_start_time(pid)
                try:
                    recorded = int(recorded_start)
                except (TypeError, ValueError):
                    continue
                if actual is None:
                    if _pid_is_alive(pid):
                        return pid, (f"the gateway pid {pid} is alive, but its /proc start time "
                                     "could not be read; treating it as running")
                    continue
                if actual != recorded:
                    continue  # the pid now belongs to another process
            if _pid_is_alive(pid):
                return pid, None
            continue
        try:
            pid = int(raw)
        except ValueError:
            continue
        if pid > 0 and _pid_is_alive(pid):
            return pid, None
    return None, None


def _gateway_pid(home: Path) -> Optional[int]:
    return _gateway_pid_info(home)[0]


def _hermes_command(args) -> list:
    explicit = os.environ.get("HERMES_BIN")
    if explicit and Path(explicit).expanduser().is_file():
        return [str(Path(explicit).expanduser()), *args]
    found = shutil.which("hermes")
    if found:
        return [found, *args]
    # A systemd --user unit has a minimal PATH, and the venv's console script
    # may not be on it.  The interpreter that is running us can still import
    # the same CLI.
    return [sys.executable, "-m", "hermes_cli.main", *args]


def _run_hermes(args, timeout=60, out=None) -> bool:
    command = _hermes_command(args)
    try:
        result = subprocess.run(command, check=False, timeout=timeout,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        if out:
            out(f"Could not run `{command[0]}`: {exc}")
        return False
    if result.returncode != 0:
        tail = (result.stdout or b"").decode("utf-8", "replace").strip().splitlines()[-3:]
        if out:
            out(f"`{command[0]} {' '.join(command[1:])}` exited {result.returncode}."
                + ((" " + " / ".join(tail)) if tail else ""))
        return False
    return True


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

    note = None
    if running is None:
        def gateway_running() -> bool:
            nonlocal note
            pid, reason = _gateway_pid_info(root)
            if reason:
                note = reason
            return pid is not None
        running = gateway_running
    was_running = bool(running())
    if was_running:
        stopped = (stop or (lambda: _run_hermes(["gateway", "stop"], out=out)))()
        deadline = time.monotonic() + 30
        while running() and time.monotonic() < deadline:
            time.sleep(0.5)
        if running():
            if note:
                out(note + ".")
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
        self_update.note_failure(to, root, kind="rollback")
    except ValueError as exc:
        out(f"Restored, but the failed attempt could not be recorded: {exc}")
    try:
        self_update.clear_marker(root)
    except ValueError as exc:
        out(f"Restored, but the marker could not be cleared: {exc}")

    out(f"Restored Winglet {report.get('from')} from {backup}.")
    out("Restored: " + ", ".join(report.get("done") or []) + ".")
    out(f"The failed version is kept in {report.get('kept')}.")
    _audit(root, f"restored {report.get('from')} after {to} failed")
    started = (start or (lambda: _run_hermes(["gateway", "start"], out=out)))()
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
