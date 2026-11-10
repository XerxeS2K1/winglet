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

import contextlib
try:  # POSIX
    import fcntl
except ImportError:  # Windows: the gateway runs on Linux, but the suite imports this everywhere
    fcntl = None
try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None
import hashlib
import json
import os
import random
import re
import shlex
import shutil
import stat
import subprocess
import time
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

MARKER_NAME = "winglet-update.json"
ATTEMPTS_NAME = "winglet-update-attempts.json"
HEALTH_NAME = "winglet-update-health.json"
LAST_SUCCESS_NAME = "winglet-update-last-success.json"
AUTO_UPDATE_KEY = "auto_update"

CHECK_INTERVAL_SECONDS = 6 * 60 * 60
CHECK_START_DELAY_SECONDS = 20
CHECK_START_JITTER_SECONDS = 20
RETRY_AFTER_FAILURE_SECONDS = 30 * 60
RETRY_ATTEMPTS = 3
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


def attempts_path(home=None) -> Path:
    return hermes_home(home) / ATTEMPTS_NAME


def health_path(home=None) -> Path:
    return hermes_home(home) / HEALTH_NAME


def last_success_path(home=None) -> Path:
    return hermes_home(home) / LAST_SUCCESS_NAME


def _read_json(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def read_attempts(home=None) -> Dict[str, Any]:
    """Attempts and failures by release version, kept outside the plugin tree and
    outside the database so a rollback cannot erase the evidence that this
    release has already been tried.

    A corrupt file is not silently treated as empty: that would allow the same
    broken release to be installed again.  Callers turn the error into a refusal.
    """
    path = attempts_path(home)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"attempts": {}, "failures": {}, "permanent": {}}
    except (OSError, ValueError) as exc:
        raise ValueError(f"the update attempt record cannot be read: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("the update attempt record is not a record")
    raw_attempts = data.get("attempts")
    raw_failures = data.get("failures")
    raw_permanent = data.get("permanent")
    raw_attempts = raw_attempts if isinstance(raw_attempts, dict) else {}
    raw_failures = raw_failures if isinstance(raw_failures, dict) else {}
    raw_permanent = raw_permanent if isinstance(raw_permanent, dict) else {}
    attempts: Dict[str, Dict[str, Any]] = {}
    legacy_permanent = {}
    for key, value in raw_attempts.items():
        if isinstance(value, dict):
            at = value.get("at")
            count = value.get("count")
        else:
            at, count = value, 1
            legacy_permanent[str(key)] = True
        if isinstance(at, (int, float)) and not isinstance(at, bool):
            attempts[str(key)] = {"at": float(at),
                                  "count": int(count) if isinstance(count, int) and count > 0 else 1}
    failures = {str(k): float(v) for k, v in raw_failures.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool)}
    permanent = {str(k): True for k, v in raw_permanent.items() if v is True}
    permanent.update(legacy_permanent)
    return {"attempts": attempts, "failures": failures, "permanent": permanent}


def _lock_file(handle) -> None:
    """Serialize the attempts file across processes. POSIX flocks; Windows locks a byte."""
    if fcntl is not None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    elif msvcrt is not None:
        handle.seek(0)
        # getattr keeps type checkers quiet on POSIX, where the module has no locking().
        getattr(msvcrt, "locking")(handle.fileno(), getattr(msvcrt, "LK_LOCK"), 1)
    # Neither available: no lock, which is why the watchdog path is POSIX-only anyway.


def _unlock_file(handle) -> None:
    if fcntl is not None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    elif msvcrt is not None:
        handle.seek(0)
        getattr(msvcrt, "locking")(handle.fileno(), getattr(msvcrt, "LK_UNLCK"), 1)


@contextlib.contextmanager
def _attempts_lock(home=None):
    """An on-disk lock: the watchdog rollback is a different process."""
    path = attempts_path(home).with_suffix(".lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+", encoding="utf-8") as handle:
        _lock_file(handle)
        try:
            yield
        finally:
            _unlock_file(handle)


def _write_attempts(data: Dict[str, Any], home=None) -> None:
    _atomic_json(attempts_path(home), {
        "attempts": dict(sorted(data.get("attempts", {}).items())),
        "failures": dict(sorted(data.get("failures", {}).items())),
        "permanent": dict(sorted(data.get("permanent", {}).items())),
    })


def _mutate_attempts(home, change) -> None:
    with _attempts_lock(home):
        data = read_attempts(home)
        change(data)
        _write_attempts(data, home)


def attempted(version: str, home=None) -> bool:
    data = read_attempts(home)
    return str(version) in data["attempts"] or str(version) in data["permanent"]


def permanent_failure(version: str, home=None) -> bool:
    return str(version) in read_attempts(home)["permanent"]


def attempt_count(version: str, home=None) -> int:
    entry = read_attempts(home)["attempts"].get(str(version))
    return int(entry["count"]) if isinstance(entry, dict) else 0


def failed_at(version: str, home=None) -> Optional[float]:
    return read_attempts(home)["failures"].get(str(version))


def note_attempt(version: str, home=None, *, now=None) -> None:
    def change(data):
        entry = data["attempts"].get(str(version))
        count = int(entry["count"]) if isinstance(entry, dict) else 0
        data["attempts"][str(version)] = {"at": float(time.time() if now is None else now),
                                          "count": count + 1}
    _mutate_attempts(home, change)


def note_failure(version: str, home=None, *, now=None, kind: str = "transient",
                 count_as_attempt: bool = False) -> None:
    def change(data):
        stamp = float(time.time() if now is None else now)
        data["failures"][str(version)] = stamp
        if count_as_attempt:
            entry = data["attempts"].get(str(version))
            count = int(entry["count"]) if isinstance(entry, dict) else 0
            data["attempts"][str(version)] = {"at": stamp, "count": count + 1}
        if kind == "rollback":
            data["permanent"][str(version)] = True
    _mutate_attempts(home, change)


def clear_attempts(home=None) -> None:
    """Owner turned autoUpdate off and on: forget every attempted release."""
    with _attempts_lock(home):
        try:
            attempts_path(home).unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise ValueError(f"the update attempt record cannot be cleared: {exc}") from exc


def prune_attempts(version: str, home=None) -> None:
    """Only a strictly newer release may erase an older attempt."""
    latest = _version(version)
    if latest is None:
        return

    def change(data):
        for group in ("attempts", "failures", "permanent"):
            for key in list(data[group]):
                older = _version(key)
                if older is not None and older < latest:
                    del data[group][key]
    _mutate_attempts(home, change)


def write_health(current_version: str, home=None, *, now=None) -> Path:
    """A stamp independent of the marker: this version is actually serving."""
    path = health_path(home)
    _atomic_json(path, {"version": current_version, "ts": float(time.time() if now is None else now)})
    return path


def read_health(home=None) -> Optional[dict]:
    data = _read_json(health_path(home))
    if not data or not isinstance(data.get("version"), str):
        return None
    ts = data.get("ts")
    if not isinstance(ts, (int, float)) or isinstance(ts, bool):
        return None
    return data


def last_success(home=None) -> Optional[dict]:
    data = _read_json(last_success_path(home))
    if not data or not isinstance(data.get("version"), str):
        return None
    ts = data.get("updatedAt")
    if not isinstance(ts, (int, float)) or isinstance(ts, bool):
        return None
    return {"version": data["version"], "updatedAt": float(ts)}


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


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
        with open(temp, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, sort_keys=True, separators=(",", ":")))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        os.replace(temp, path)
        _fsync_dir(path.parent)
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


def record_health(current_version: str, home=None, *, now=None) -> bool:
    """The single happy-path write: the new version is serving, so its marker is
    cleared and its success time is recorded.

    A health stamp is written on every start, even when the marker is missing or
    unreadable.  That stamp is what the out-of-process watchdog trusts when the
    marker itself has been damaged; a healthy update must never be rolled back
    just because the marker file cannot be parsed.

    Returns True only when this start cleared a marker that named this version.
    """
    write_health(current_version, home, now=now)
    try:
        marker = read_marker(home)
    except ValueError:
        return False
    if not marker or marker.get("to") != current_version:
        return False
    clear_marker(home)
    _atomic_json(last_success_path(home), {"version": current_version,
                                           "updatedAt": float(time.time() if now is None else now)})
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
                attempted_release: bool, failed_at: Optional[float], now: float,
                attempt_count: int = 0) -> Optional[str]:
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
    if failed_at is not None and attempt_count >= RETRY_ATTEMPTS:
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
    if a is None or b is None or a[0] != b[0]:
        return False
    # While Winglet is 0.x, a minor bump is a contract change: 0.10 -> 0.11 is
    # not an unattended update.  Major 0 has no stable compatibility promise.
    return a[0] != 0 or a[1] == b[1]


def watchdog_decision(marker: Optional[dict], *, now: float, current_version: Optional[str] = None,
                      health: Optional[dict] = None) -> str:
    """What the out-of-process watchdog should do with the marker.

    ``idle``  - there is no update waiting.
    ``ok``    - the marker names the version that is now serving, or a health
                stamp newer than the marker proves the new version started.
    ``wait``  - the new version has not had its ten minutes yet.
    ``rollback`` - ten minutes have passed and the marker is still there.
    ``broken`` - the marker exists but cannot be used safely.
    """
    if not marker:
        return "idle"
    to = marker.get("to")
    started = marker.get("started")
    if health and isinstance(health, dict) and health.get("version") == to:
        stamped = health.get("ts")
        if (isinstance(stamped, (int, float)) and not isinstance(stamped, bool)
                and isinstance(started, (int, float)) and not isinstance(started, bool)
                and stamped >= started):
            return "ok"
    if current_version is not None and to == current_version:
        return "ok"
    if not isinstance(started, (int, float)) or isinstance(started, bool) or started <= 0:
        return "broken"
    if not isinstance(marker.get("from"), str) or not _version(marker.get("from")):
        return "broken"
    if not isinstance(to, str) or not _version(to):
        return "broken"
    if not isinstance(marker.get("backup"), str) or not marker["backup"]:
        return "broken"
    return "rollback" if now - started >= WATCHDOG_GRACE_SECONDS else "wait"


# -- verifying that the installed tree is the asset that was verified -----------------------------------------------

_IGNORED_PARTS = {"__pycache__", ".git", ".pytest_cache", ".mypy_cache"}


def _digest_entries(entries: Dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for rel in sorted(entries):
        body = entries[rel]
        name = rel.encode()
        digest.update(len(name).to_bytes(8, "big") + name + len(body).to_bytes(8, "big") + body)
    return digest.hexdigest()


def zip_tree_digest(data: bytes) -> str:
    """A deterministic digest of the plugin tree inside a release zip.

    The zip may contain the plugin folder itself rather than the repository
    root, so the shallowest ``plugin.yaml`` decides the prefix.
    """
    with zipfile.ZipFile(BytesIO(data)) as archive:
        manifests = [name for name in archive.namelist()
                     if name == "plugin.yaml" or name.endswith("/plugin.yaml")]
        if not manifests:
            raise ValueError("the release asset has no plugin.yaml")
        manifests.sort(key=lambda name: (name.count("/"), len(name)))
        prefix = manifests[0].rsplit("/", 1)[0] + "/" if "/" in manifests[0] else ""
        entries: Dict[str, bytes] = {}
        for info in archive.infolist():
            if info.is_dir() or not info.filename.startswith(prefix):
                continue
            rel = info.filename[len(prefix):]
            if not rel or any(part in _IGNORED_PARTS for part in rel.split("/")):
                continue
            entries[rel] = archive.read(info)
        return _digest_entries(entries)


def installed_tree_digest(plugin_dir) -> str:
    base = Path(plugin_dir)
    entries: Dict[str, bytes] = {}
    for path in sorted(base.rglob("*")):
        if path.is_dir():
            continue
        if any(part in _IGNORED_PARTS for part in path.relative_to(base).parts):
            continue
        rel = path.relative_to(base).as_posix()
        entries[rel] = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
    return _digest_entries(entries)


def _manifest_field(text: str, name: str) -> Optional[str]:
    match = re.search(rf"(?m)^{name}:[ \t]*(.*)$", text)
    if not match:
        return None
    value = re.sub(r"\s#.*$", "", match.group(1)).strip().strip("\"'").strip()
    return value or None


def verify_installed_plugin(plugin_dir, data: bytes, manifest: Optional[dict] = None) -> Tuple[bool, str]:
    """Prove the code Hermes installed is the code whose digest GitHub published.

    The manifest gate is re-read from the installed ``plugin.yaml``, not from the
    zip's copy, because that is the file the running plugin will load.
    """
    try:
        expected = zip_tree_digest(data)
        actual = installed_tree_digest(plugin_dir)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        return False, f"the installed plugin could not be checked: {exc}"
    if expected != actual:
        return False, "the installed plugin files do not match the verified release asset"
    try:
        text = (Path(plugin_dir) / "plugin.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"the installed plugin manifest cannot be read: {exc}"
    installed_version = _manifest_field(text, "version")
    installed_requires = _manifest_field(text, "requires_hermes")
    wanted = manifest or {}
    if wanted.get("version") and installed_version != wanted["version"]:
        return False, (f"the installed plugin says {installed_version or 'no version'}, "
                       f"not {wanted['version']}")
    if wanted.get("requires_hermes") and installed_requires != wanted["requires_hermes"]:
        return False, "the installed plugin's Hermes requirement does not match the release asset"
    return True, ""


# -- systemd watchdog ---------------------------------------------------------------------------------------------

def _systemd_user_dir(home=None) -> Path:
    override = os.environ.get("XDG_CONFIG_HOME")
    base = Path(override).expanduser() if override else Path.home() / ".config"
    return base / "systemd" / "user"


def _systemctl(args, *, runner=None) -> subprocess.CompletedProcess:
    runner = runner or subprocess.run
    return runner(["systemctl", "--user", *args], capture_output=True, text=True, timeout=30)


def _linger(user: Optional[str] = None, *, runner: Optional[Callable] = None) -> Optional[bool]:
    """Whether a systemd ``--user`` timer can run while the user is logged out.

    We never enable linger ourselves: that is a machine-wide permission change.
    ``None`` means loginctl is unavailable or its answer was unreadable.
    """
    runner = runner or subprocess.run
    try:
        result = runner(["loginctl", "show-user", user or str(os.getuid()), "-p", "Linger"],
                        capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    if getattr(result, "returncode", 1) != 0:
        return None
    text = str(getattr(result, "stdout", "") or "")
    match = re.search(r"(?m)^Linger=(\w+)\s*$", text)
    if not match:
        return None
    return match.group(1).lower() == "yes"


def refresh_watchdog_scripts(home=None) -> Dict[str, Any]:
    """Copy the watchdog's code next to the unit, replacing only changed files.

    Called by ``winglet setup`` *and* by every successful update, because a fix
    to the watchdog is useless if the copy systemd runs is never refreshed.
    """
    root = hermes_home(home)
    scripts = root / "scripts"
    here = Path(__file__).resolve().parent
    copies = {
        WATCHDOG_SCRIPT: here / "update_watchdog.py",
        ROLLBACK_SCRIPT: here / "update_rollback.py",
        "update_rollback.py": here / "update_rollback.py",
        "rollback.py": here / "rollback.py",
        "self_update.py": here / "self_update.py",
    }
    changed = []
    scripts.mkdir(parents=True, exist_ok=True)
    for name, source in copies.items():
        target = scripts / name
        try:
            wanted = source.read_bytes()
        except OSError as exc:
            raise OSError(f"cannot read {source}: {exc}") from exc
        try:
            current = target.read_bytes()
        except OSError:
            current = None
        if current != wanted:
            target.write_bytes(wanted)
            changed.append(name)
        try:
            os.chmod(target, 0o700)
        except OSError:
            pass
    return {"scripts": str(scripts), "changed": changed}


def install_watchdog(home=None, *, python=None, runner: Optional[Callable] = None) -> dict:
    """Install the out-of-process watchdog.  Never raises: setup must still work
    on a machine without systemd, but the caller is told what is missing."""
    root = hermes_home(home)
    scripts = root / "scripts"
    unit_dir = _systemd_user_dir(root)
    script = scripts / WATCHDOG_SCRIPT
    try:
        refresh_watchdog_scripts(home)
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
    linger = _linger(runner=runner)
    return {"installed": True, "unit": str(unit_dir), "script": str(script), "linger": linger,
            "canFire": linger is True,
            "reason": None if linger is True else "the user timer needs linger to fire while logged out"}


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
    linger = _linger(runner=runner)
    if not present:
        return {"installed": False, "reason": "the systemd unit is not installed", "unit": str(unit_dir),
                "linger": linger, "canFire": False}
    try:
        result = _systemctl(["is-enabled", WATCHDOG_TIMER], runner=runner)
        enabled = getattr(result, "returncode", 1) == 0
    except Exception:
        enabled = None
    return {"installed": True, "enabled": enabled, "unit": str(unit_dir), "linger": linger,
            "canFire": bool(enabled and linger), "reason": None if linger is True else "the user timer needs linger to fire while logged out"}
