"""Unattended Winglet server updates.

This module is deliberately small and import-light: the gateway, the CLI and the
out-of-process watchdog all use it, and the watchdog must keep working when the
plugin package cannot be imported.  It therefore never imports ``hub`` or
``adapter``.

The update itself still goes through ``hermes_api.begin_update`` /
``install_release`` and ``hub._run_winglet_update``; this module only decides
whether an update may start and owns the durable hand-off marker that makes an
out-of-process rollback possible.
"""
from __future__ import annotations

import json
import os
import random
import shlex
import shutil
import stat
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

MARKER_NAME = "winglet-update.json"
AUTO_UPDATE_KEY = "auto_update"

CHECK_INTERVAL_SECONDS = 6 * 60 * 60
CHECK_START_DELAY_SECONDS = 20
CHECK_START_JITTER_SECONDS = 20
RETRY_AFTER_FAILURE_SECONDS = 30 * 60
WATCHDOG_GRACE_SECONDS = 10 * 60

WATCHDOG_SERVICE = "winglet-update-watchdog.service"
WATCHDOG_TIMER = "winglet-update-watchdog.timer"
WATCHDOG_SCRIPT = "winglet-update-watchdog.py"
ROLLBACK_SCRIPT = "winglet-update-watch.py"

GATES = ("autoUpdate", "newer", "major", "busy", "asset", "manifest", "attempt", "retry")


def hermes_home(home=None) -> Path:
    """The Hermes root that owns ``plugins/``, ``backups/`` and the marker.

    ``HERMES_HOME`` wins when set (that is what the gateway runs with); otherwise
    the documented ``~/.hermes`` location is used.  A profile home is reduced to
    the root that holds ``plugins/``.
    """
    if home is not None:
        path = Path(home).expanduser()
    else:
        path = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()
    if path.parent.name == "profiles":
        return path.parent.parent
    return path


def marker_path(home=None) -> Path:
    return hermes_home(home) / MARKER_NAME


def read_marker(home=None) -> Optional[dict]:
    path = marker_path(home)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(f"the update marker cannot be read: {exc}") from exc
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ValueError("the update marker is not valid JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("the update marker is not a record")
    return data


def _atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp.write_text(json.dumps(data, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        try:
            os.chmod(temp, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except OSError:
            pass


def write_marker(*, from_version: str, to_version: str, backup, started=None, home=None) -> Path:
    """Write the marker *before* the swap.  The caller is responsible for doing
    this only after the backup exists and before the plugin files change."""
    path = marker_path(home)
    _atomic_json(path, {"from": from_version, "to": to_version, "backup": str(Path(backup)),
                        "started": time.time() if started is None else started})
    return path


def clear_marker(home=None) -> bool:
    try:
        marker_path(home).unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ValueError(f"the update marker cannot be cleared: {exc}") from exc


def record_health(current_version: str, home=None) -> bool:
    """The single happy-path write: the new version is serving, so its marker is
    cleared.  The marker's absence *is* the health signal the watchdog reads.

    Returns True only when this start cleared a marker that named this version.
    """
    try:
        marker = read_marker(home)
    except ValueError:
        return False
    if not marker or marker.get("to") != current_version:
        return False
    clear_marker(home)
    return True


def auto_update_enabled(store) -> bool:
    value = store.get_kv(AUTO_UPDATE_KEY) if store is not None else None
    if value is None:
        return True
    return str(value).strip().lower() not in ("0", "false", "off", "no")


def set_auto_update(store, enabled: bool) -> bool:
    enabled = bool(enabled)
    store.set_kv(AUTO_UPDATE_KEY, "1" if enabled else "0")
    return enabled


def gate_reason(*, enabled: bool, release: Optional[dict], current_version: str,
                running_hermes: str, idle: bool, asset_ok: bool, manifest_ok: bool,
                attempted_release: bool, failed_at: Optional[float], now: float) -> Optional[str]:
    """The first gate that refuses, or None when every gate allows the update.

    The order is the design's order.  Pure function: the caller supplies the
    results of the checks that need I/O (the GitHub asset and the zip manifest).
    """
    if not enabled:
        return "autoUpdate"
    version = (release or {}).get("version")
    if not release or not _newer(version, current_version):
        return "newer"
    if not _same_major(version, current_version):
        return "major"
    if not idle:
        return "busy"
    if not asset_ok:
        return "asset"
    if not manifest_ok:
        return "manifest"
    if attempted_release:
        return "attempt"
    if failed_at is not None and now - failed_at < RETRY_AFTER_FAILURE_SECONDS:
        return "retry"
    return None


def _version(text) -> Optional[Tuple[int, int, int]]:
    if not isinstance(text, str):
        return None
    parts = text.split(".")
    if len(parts) != 3 or not all(p.isdigit() and (p == "0" or not p.startswith("0")) for p in parts):
        return None
    try:
        values = (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None
    return values if all(0 <= v <= 9999 for v in values) else None


def _newer(candidate, current) -> bool:
    a, b = _version(candidate), _version(current)
    return a is not None and b is not None and a > b


def _same_major(candidate, current) -> bool:
    a, b = _version(candidate), _version(current)
    return a is not None and b is not None and a[0] == b[0]


def watchdog_decision(marker: Optional[dict], *, now: float, current_version: Optional[str] = None) -> str:
    """What the out-of-process watchdog should do with the marker.

    ``idle``  - there is no update waiting.
    ``ok``    - the marker names the version that is now serving; clear it.
    ``wait``  - the new version has not had its ten minutes yet.
    ``rollback`` - ten minutes have passed and the marker is still there.
    ``broken`` - the marker exists but cannot be used safely.
    """
    if not marker:
        return "idle"
    to = marker.get("to")
    if current_version is not None and to == current_version:
        return "ok"
    started = marker.get("started")
    if not isinstance(started, (int, float)) or isinstance(started, bool) or started <= 0:
        return "broken"
    if not isinstance(marker.get("from"), str) or not _version(marker.get("from")):
        return "broken"
    if not isinstance(to, str) or not _version(to):
        return "broken"
    if not isinstance(marker.get("backup"), str) or not marker["backup"]:
        return "broken"
    return "rollback" if now - started >= WATCHDOG_GRACE_SECONDS else "wait"


# -- systemd watchdog ---------------------------------------------------------------------------------------------

def _systemd_user_dir(home=None) -> Path:
    override = os.environ.get("XDG_CONFIG_HOME")
    base = Path(override).expanduser() if override else Path.home() / ".config"
    return base / "systemd" / "user"


def _systemctl(args, *, runner=None) -> subprocess.CompletedProcess:
    runner = runner or subprocess.run
    return runner(["systemctl", "--user", *args], capture_output=True, text=True, timeout=30)


def install_watchdog(home=None, *, python=None, runner: Optional[Callable] = None) -> dict:
    """Install the out-of-process watchdog.  Never raises: setup must still work
    on a machine without systemd, but the caller is told what is missing."""
    root = hermes_home(home)
    scripts = root / "scripts"
    unit_dir = _systemd_user_dir(root)
    script = scripts / WATCHDOG_SCRIPT
    helper = scripts / ROLLBACK_SCRIPT
    try:
        scripts.mkdir(parents=True, exist_ok=True)
        here = Path(__file__).resolve().parent
        shutil.copyfile(here / "update_watchdog.py", script)
        shutil.copyfile(here / "update_rollback.py", helper)
        shutil.copyfile(here / "update_rollback.py", scripts / "update_rollback.py")
        shutil.copyfile(here / "rollback.py", scripts / "rollback.py")
        shutil.copyfile(here / "self_update.py", scripts / "self_update.py")
        os.chmod(script, 0o700)
        os.chmod(helper, 0o700)
        unit_dir.mkdir(parents=True, exist_ok=True)
        python = python or os.environ.get("WINGLET_PYTHON") or shutil.which("python3") or "python3"
        service = (
            "[Unit]\n"
            "Description=Winglet update watchdog\n"
            "After=network-online.target\n\n"
            "[Service]\n"
            "Type=oneshot\n"
            f"ExecStart={shlex.quote(str(python))} {shlex.quote(str(script))} --home {shlex.quote(str(root))}\n"
            "Nice=10\n"
        )
        timer = (
            "[Unit]\n"
            "Description=Check a Winglet update that did not report health\n\n"
            "[Timer]\n"
            "OnBootSec=2min\n"
            "OnUnitActiveSec=10min\n"
            "AccuracySec=30s\n"
            "Persistent=true\n\n"
            "[Install]\n"
            "WantedBy=timers.target\n"
        )
        (unit_dir / WATCHDOG_SERVICE).write_text(service, encoding="utf-8")
        (unit_dir / WATCHDOG_TIMER).write_text(timer, encoding="utf-8")
    except OSError as exc:
        return {"installed": False, "reason": f"could not write the watchdog: {exc}", "unit": str(unit_dir)}
    try:
        _systemctl(["daemon-reload"], runner=runner)
        _systemctl(["enable", "--now", WATCHDOG_TIMER], runner=runner)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"installed": False, "reason": f"systemd is unavailable: {exc}", "unit": str(unit_dir)}
    except Exception as exc:  # a fake runner in tests may simply say no
        return {"installed": False, "reason": str(exc) or "systemd is unavailable", "unit": str(unit_dir)}
    return {"installed": True, "unit": str(unit_dir), "script": str(script)}


def uninstall_watchdog(home=None, *, runner: Optional[Callable] = None) -> dict:
    root = hermes_home(home)
    unit_dir = _systemd_user_dir(root)
    try:
        _systemctl(["disable", "--now", WATCHDOG_TIMER], runner=runner)
    except Exception:
        pass
    removed = []
    for name in (WATCHDOG_SERVICE, WATCHDOG_TIMER):
        try:
            (unit_dir / name).unlink()
            removed.append(name)
        except FileNotFoundError:
            pass
        except OSError as exc:
            return {"uninstalled": False, "reason": str(exc), "removed": removed}
    try:
        _systemctl(["daemon-reload"], runner=runner)
    except Exception:
        pass
    return {"uninstalled": True, "removed": removed}


def watchdog_status(home=None, *, runner: Optional[Callable] = None) -> dict:
    root = hermes_home(home)
    unit_dir = _systemd_user_dir(root)
    present = (unit_dir / WATCHDOG_SERVICE).is_file() and (unit_dir / WATCHDOG_TIMER).is_file()
    if not present:
        return {"installed": False, "reason": "the systemd unit is not installed", "unit": str(unit_dir)}
    try:
        result = _systemctl(["is-enabled", WATCHDOG_TIMER], runner=runner)
        enabled = getattr(result, "returncode", 1) == 0
    except Exception:
        enabled = None
    return {"installed": True, "enabled": enabled, "unit": str(unit_dir)}
