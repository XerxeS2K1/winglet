#!/usr/bin/env python3
"""Back Winglet up before an in-app update, and put the backup back if the new version does not come up.

Two jobs in one standalone file, standard library only (no Hermes, no Winglet imports):

* ``create_backup`` is called by the server before it installs a release. It copies the plugin folder, takes a
  consistent snapshot of the database and records the plugin's install record, then keeps only the last three
  backups.
* ``main`` / ``watch`` is what Hermes cron runs (a no-agent job, once a minute) while an update is pending. The new
  Winglet clears the pending-update record itself as soon as it is up. If the record is still there after the
  deadline, the new version did not start: this script puts the files, the install record and the database back and
  prints a message, which cron delivers to Kraig.

It NEVER restarts the gateway, and it cannot: it starts no process, opens no socket and loads no Hermes code. Kraig
restarts the gateway himself when he is ready. Hermes also scans cron scripts and refuses one that restarts the
gateway, so the job could not be created if this file tried.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

BACKUP_FOLDER = "winglet-plugin"        # <hermes root>/backups/winglet-plugin/
MARKER = "pending-update.json"          # the update that is waiting to be confirmed
SCRIPT_NAME = "winglet-update-watch.py"  # where the server installs this file: <hermes home>/scripts/
KEEP_BACKUPS = 3
DEADLINE_SECONDS = 180

_VERSION = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}\Z")
_BACKUP_NAME = re.compile(r"plugin-[0-9.]{5,14}-pre-[0-9.]{5,14}-[0-9]{8}-[0-9]{6}\Z")
_STATES = ("pending", "rolled_back", "rollback_failed")


class RollbackError(RuntimeError):
    """The backup could not be put back. ``done`` lists what had already been restored."""

    def __init__(self, message: str, done: Optional[list] = None):
        super().__init__(message)
        self.done = done or []


# -- small helpers ----------------------------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tree_digest(base: Path) -> str:
    """A fingerprint of a folder's names, links and file contents (not times or permissions)."""
    digest = hashlib.sha256()
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(base).as_posix().encode()
        if path.is_symlink():
            kind, body = b"L", os.readlink(path).encode()
        elif path.is_dir():
            kind, body = b"D", b""
        else:
            kind, body = b"F", path.read_bytes()
        digest.update(kind + len(rel).to_bytes(8, "big") + rel + len(body).to_bytes(8, "big") + body)
    return digest.hexdigest()


def _snapshot_db(source_path: Path, dest: Path) -> None:
    """A consistent copy of a database that may be in use (SQLite's own backup, read-only on the source)."""
    source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)
    try:
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    os.chmod(dest, 0o600)


def _write_json_atomically(path: Path, data: dict) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=1)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def hermes_root(home: Path) -> Path:
    """The folder that holds ``plugins/`` and ``backups/``: the home itself, or above ``profiles/<name>``."""
    home = Path(home)
    return home.parent.parent if home.parent.name == "profiles" else home


def _inside(path: Path, root: Path) -> bool:
    real, base = Path(os.path.realpath(path)), Path(os.path.realpath(root))
    return real == base or base in real.parents


# -- the backup -------------------------------------------------------------------------------------------------


def create_backup(*, plugin_dir, db_path, from_version: str, to_version: str, now: Optional[float] = None,
                  keep: int = KEEP_BACKUPS) -> Path:
    """Back up before an install: ``<root>/backups/winglet-plugin/plugin-<from>-pre-<to>-<time>/`` holding the plugin
    folder, ``data.db`` (a snapshot), and ``manifest.json``. Returns the backup folder."""
    for version in (from_version, to_version):
        if not isinstance(version, str) or not _VERSION.match(version):
            raise ValueError("a backup is named after plain x.y.z versions")
    plugin_dir = Path(os.path.abspath(plugin_dir))
    if plugin_dir.parent.name != "plugins" or plugin_dir.is_symlink() or not plugin_dir.is_dir():
        raise ValueError("the plugin is not a normal folder under plugins/")
    root = plugin_dir.parent.parent
    folder = root / "backups" / BACKUP_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    name = f"plugin-{from_version}-pre-{to_version}-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime(now if now is not None else time.time()))
    backup = folder / name
    backup.mkdir(mode=0o700)  # FileExistsError if there already is one: never overwrite a backup
    try:
        shutil.copytree(plugin_dir, backup / "plugin", symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        db_path = Path(os.path.abspath(db_path)) if db_path else None
        db_sha = None
        if db_path is not None and db_path.is_file():
            _snapshot_db(db_path, backup / "data.db")
            db_sha = _sha256_file(backup / "data.db")
        metadata_path = plugin_dir.parent / ".install-metadata.json"
        entry = None
        try:
            records = json.loads(metadata_path.read_text(encoding="utf-8"))
            entry = records.get(plugin_dir.name) if isinstance(records, dict) else None
        except (OSError, ValueError):
            pass
        manifest = {"format": 1, "from": from_version, "to": to_version, "created": now if now is not None else time.time(),
                    "plugin_name": plugin_dir.name, "plugin_dir": str(plugin_dir), "db_path": str(db_path) if db_path else None,
                    "db_sha256": db_sha, "metadata_path": str(metadata_path), "install_metadata": entry,
                    "plugin_tree_sha256": _tree_digest(backup / "plugin")}
        _write_json_atomically(backup / "manifest.json", manifest)
    except BaseException:
        shutil.rmtree(backup, ignore_errors=True)  # a half-made backup is worse than none
        raise
    prune_backups(folder, keep, protect=backup)
    return backup


def prune_backups(folder: Path, keep: int = KEEP_BACKUPS, protect: Optional[Path] = None) -> None:
    """Keep the newest ``keep`` backups. Only folders named like a backup are considered; links are never followed."""
    candidates = []
    for entry in folder.iterdir():
        if entry.is_symlink() or not entry.is_dir() or not _BACKUP_NAME.match(entry.name):
            continue
        try:
            created = float(json.loads((entry / "manifest.json").read_text())["created"])
        except (OSError, ValueError, KeyError, TypeError):
            created = entry.stat().st_mtime
        candidates.append((created, entry.name, entry))
    candidates.sort(reverse=True)
    for _, _, entry in candidates[max(keep, 1):]:
        if protect is not None and entry == protect:
            continue
        shutil.rmtree(entry, ignore_errors=True)


# -- the pending-update record ----------------------------------------------------------------------------------


def write_marker(folder: Path, data: dict) -> None:
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    _write_json_atomically(folder / MARKER, data)


def read_marker(folder: Path) -> Optional[dict]:
    """The record, None when there is none. Raises ValueError when it exists but cannot be read."""
    path = Path(folder) / MARKER
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(str(exc)) from exc
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("not a record")
    return data


def clear_marker(folder: Path) -> None:
    try:
        (Path(folder) / MARKER).unlink()
    except FileNotFoundError:
        pass


# -- putting the backup back ------------------------------------------------------------------------------------


def verify_backup(backup: Path, root: Path) -> dict:
    """Read the manifest and prove the saved files are what was saved, and that every path stays in the Hermes folder."""
    try:
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        plugin_dir, metadata = Path(manifest["plugin_dir"]), Path(manifest["metadata_path"])
        db_path = Path(manifest["db_path"]) if manifest.get("db_path") else None
        tree_sha, db_sha = manifest["plugin_tree_sha256"], manifest.get("db_sha256")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RollbackError("the backup's manifest is missing or unreadable") from exc
    if not plugin_dir.is_absolute() or plugin_dir.parent.name != "plugins" or not _inside(plugin_dir, root):
        raise RollbackError("the backup names a plugin folder outside the Hermes folder")
    if metadata != plugin_dir.parent / ".install-metadata.json":
        raise RollbackError("the backup names an unexpected install record")
    if db_path is not None and (not db_path.is_absolute() or not _inside(db_path, root)):
        raise RollbackError("the backup names a database outside the Hermes folder")
    saved = backup / "plugin"
    if not saved.is_dir() or _tree_digest(saved) != tree_sha:
        raise RollbackError("the saved plugin files are damaged or incomplete")
    if db_sha is not None and (not (backup / "data.db").is_file() or _sha256_file(backup / "data.db") != db_sha):
        raise RollbackError("the saved database is damaged or incomplete")
    manifest["_plugin_dir"], manifest["_db_path"], manifest["_metadata"] = plugin_dir, db_path, metadata
    return manifest


def restore(root: Path, backup: Path, now: float, *, with_database: bool = True) -> dict:
    """Put the plugin files, the install record and (unless ``with_database`` is False) the database back. Nothing is
    changed until the backup has been proven sound. The database is left alone when the new code never ran, e.g. after
    an install that failed: nothing has written to it, and whatever users sent meanwhile must stay. What the failed update left behind (its files, and the database as it was) is kept next to the
    backups, outside ``plugins/`` where Hermes would load it. Returns {done, kept, from, to}."""
    manifest = verify_backup(backup, root)
    plugin_dir, db_path, metadata = manifest["_plugin_dir"], manifest["_db_path"], manifest["_metadata"]
    kept = backup.parent / ("failed-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)))
    done: list = []
    try:
        kept.mkdir(mode=0o700, exist_ok=True)
        staged = kept / "restoring"
        shutil.copytree(backup / "plugin", staged, symlinks=True)
        if plugin_dir.exists() or plugin_dir.is_symlink():
            os.replace(plugin_dir, kept / "plugin")
        try:
            os.replace(staged, plugin_dir)
        except OSError:
            if (kept / "plugin").exists() and not plugin_dir.exists():
                os.replace(kept / "plugin", plugin_dir)  # put the failed one back rather than leave no plugin at all
            raise
        done.append("the Winglet plugin files")
        try:
            records = json.loads(metadata.read_text(encoding="utf-8"))
        except FileNotFoundError:
            records = {}
        if not isinstance(records, dict):
            raise ValueError("install record is not a mapping")
        if manifest.get("install_metadata") is None:
            records.pop(manifest["plugin_name"], None)
        else:
            records[manifest["plugin_name"]] = manifest["install_metadata"]
        _write_json_atomically(metadata, records)
        done.append("its install record")
        if with_database and manifest.get("db_sha256") is not None and db_path is not None:
            if db_path.is_file():
                _snapshot_db(db_path, kept / "data.db")  # whatever was written since the backup is kept, not thrown away
            source = sqlite3.connect(backup / "data.db")
            try:
                target = sqlite3.connect(db_path)
                try:
                    source.backup(target)
                    ok = target.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                finally:
                    target.close()
            finally:
                source.close()
            if not ok:
                raise RollbackError("the restored database failed its own check")
            done.append("the database")
    except RollbackError as exc:
        raise RollbackError(str(exc), done) from exc
    except (OSError, ValueError, sqlite3.Error, shutil.Error) as exc:
        raise RollbackError(f"{type(exc).__name__}: {exc}", done) from exc
    return {"done": done, "kept": kept, "from": manifest["from"], "to": manifest["to"]}


# -- what cron runs ---------------------------------------------------------------------------------------------

NOT_RESTARTED = ("The gateway has NOT been restarted. Please restart the gateway yourself when you are ready; "
                 "Winglet comes back on the version that was restored.")


def _rolled_back_message(marker: dict, report: dict, backup: Path) -> str:
    return (f"Winglet update {marker['from']} -> {marker['to']} failed, so I put {marker['from']} back.\n\n"
            f"Restored from the backup: {', '.join(report['done'])}.\n"
            f"The failed version, and the database as it was when I put the backup back, are kept in {report['kept']}. "
            f"Anything sent to Winglet during the update is in that copy, not in the restored database.\n\n"
            f"{NOT_RESTARTED}\nBackup used: {backup}")


def _failed_message(marker: dict, reason: str, done: list, backup: Optional[Path]) -> str:
    frm, to = _clean(marker.get("from")), _clean(marker.get("to"))
    return (f"Winglet update {frm} -> {to} failed, and I could not put the old version back automatically.\n\n"
            f"Why: {reason}.\n"
            f"Restored before it stopped: {', '.join(done) if done else 'nothing, no file was changed'}.\n"
            + (f"The backup is kept at {backup}.\n" if backup else "") + f"\n{NOT_RESTARTED}")


def _clean(value) -> str:
    return value if isinstance(value, str) and _VERSION.match(value) else "?"


def watch(home, now: float, out) -> int:
    """One cron tick. Silent unless an update is pending past its deadline (or its record cannot be read)."""
    root = hermes_root(Path(home))
    folder = root / "backups" / BACKUP_FOLDER
    try:
        marker = read_marker(folder)
    except ValueError:
        try:
            os.replace(folder / MARKER, folder / "pending-update.unreadable.json")
        except OSError:
            pass
        out.write("Winglet could not read its update record, so it did not check whether the last update worked. "
                  "Nothing was changed. The record was kept as pending-update.unreadable.json next to the backups.\n"
                  + NOT_RESTARTED + "\n")
        return 0
    if marker is None or marker.get("state") != "pending":
        return 0
    deadline = marker.get("deadline")
    if not isinstance(deadline, (int, float)) or isinstance(deadline, bool) or now < deadline:
        return 0
    name = marker.get("backup")
    backup = folder / name if isinstance(name, str) and _BACKUP_NAME.match(name) else None
    try:
        if backup is None or not backup.is_dir() or backup.is_symlink():
            raise RollbackError("the update record does not name a backup I can use")
        report = restore(root, backup, now)
        marker.update(state="rolled_back", finished_at=now, kept=str(report["kept"]))
        message = _rolled_back_message(marker, report, backup)
    except RollbackError as exc:
        marker.update(state="rollback_failed", finished_at=now, error=str(exc)[:300])
        message = _failed_message(marker, str(exc), exc.done, backup)
    try:
        write_marker(folder, marker)  # so the next minute stays quiet, and Winglet can say how it went
    except OSError:
        pass
    out.write(message + "\n")
    return 0


def main() -> int:
    """Cron entry. The server installs this file as <hermes home>/scripts/winglet-update-watch.py."""
    return watch(Path(__file__).resolve().parent.parent, time.time(), sys.stdout)


if __name__ == "__main__":
    sys.exit(main())
