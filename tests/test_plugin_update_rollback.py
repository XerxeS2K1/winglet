"""Backing Winglet up before an in-app update, and putting the backup back if the new version does not come up.

plugin/update_rollback.py is a small stdlib-only script that Hermes cron runs (no agent) while an update is pending.
If the new version has not confirmed itself by the deadline it restores the plugin files, the install record and the
database from the backup and prints a message that cron delivers to Kraig. It NEVER restarts the gateway: he does
that himself when he is ready. Everything here runs in a throwaway directory; nothing touches a real ~/.hermes.
"""

import ast
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

from plugin import update_rollback as ur

SCRIPT_SOURCE = Path(ur.__file__)
NOW = 1_800_000_000.0


def make_db(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, text TEXT)")
    db.executemany("INSERT INTO messages (text) VALUES (?)", [(r,) for r in rows])
    db.commit()
    db.close()


def read_db(path: Path):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return [r[0] for r in db.execute("SELECT text FROM messages ORDER BY id")]
    finally:
        db.close()


def tree(path: Path):
    return {str(p.relative_to(path)): (p.read_bytes() if p.is_file() else None) for p in sorted(path.rglob("*"))}


@pytest.fixture
def world(tmp_path):
    root = tmp_path / "hermes"
    plugin = root / "plugins" / "winglet"
    (plugin / "web").mkdir(parents=True)
    (plugin / "__pycache__").mkdir()
    (plugin / "__pycache__" / "hub.cpython-314.pyc").write_bytes(b"cache")
    (plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.4\n")
    (plugin / "hub.py").write_text("VERSION = '0.10.4'\n")
    (plugin / "web" / "index.html").write_text("<html>old</html>")
    db = root / "plugin-data" / "winglet" / "data.db"
    make_db(db, ["hello", "world"])
    meta = root / "plugins" / ".install-metadata.json"
    meta.write_text(json.dumps({"other": {"pinned": True, "source": "x"},
                                "winglet": {"pinned": True, "source": "https://github.com/XerxeS2K1/winglet.git#plugin", "ref": "old" * 10}}))
    scripts = root / "scripts"
    scripts.mkdir()
    shutil.copy(SCRIPT_SOURCE, scripts / ur.SCRIPT_NAME)
    return type("World", (), {"root": root, "plugin": plugin, "db": db, "meta": meta, "scripts": scripts,
                              "folder": root / "backups" / ur.BACKUP_FOLDER, "script": scripts / ur.SCRIPT_NAME})()


def back_up(w, frm="0.10.4", to="0.10.5", now=NOW):
    return ur.create_backup(plugin_dir=w.plugin, db_path=w.db, from_version=frm, to_version=to, now=now)


def pretend_the_update_ran(w, extra_message="posted during the update"):
    """What a failed install leaves behind: other files, a new schema row, a new install record."""
    (w.plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.5\n")
    (w.plugin / "hub.py").write_text("raise ImportError('broken release')\n")
    (w.plugin / "web" / "index.html").write_text("<html>new</html>")
    (w.plugin / "added.py").write_text("x = 1\n")
    db = sqlite3.connect(w.db)
    db.execute("INSERT INTO messages (text) VALUES (?)", (extra_message,))
    db.commit()
    db.close()
    data = json.loads(w.meta.read_text())
    data["winglet"] = {"pinned": True, "ref": "new" * 10}
    w.meta.write_text(json.dumps(data))


def write_marker(w, backup, *, deadline=NOW + 180, state="pending", frm="0.10.4", to="0.10.5", started=True):
    """A pending update. By default the new version has started (it recorded that before opening the database)."""
    ur.write_marker(w.folder, {"from": frm, "to": to, "backup": backup.name, "deadline": deadline, "state": state,
                               "cron_job": "job123", "created": NOW, **({"started": NOW - 30} if started else {})})


# -- the backup --------------------------------------------------------------------------------------------------


def test_a_backup_holds_the_plugin_the_database_and_the_install_record(world):
    before = tree(world.plugin)
    backup = back_up(world)
    assert backup.parent == world.folder
    assert backup.name == time.strftime("plugin-0.10.4-pre-0.10.5-%Y%m%d-%H%M%S", time.gmtime(NOW))
    copied = tree(backup / "plugin")
    assert "__pycache__" not in " ".join(copied) and ".pyc" not in " ".join(copied)
    assert copied == {k: v for k, v in before.items() if "__pycache__" not in k}
    assert read_db(backup / "data.db") == ["hello", "world"]
    manifest = json.loads((backup / "manifest.json").read_text())
    assert manifest["from"] == "0.10.4" and manifest["to"] == "0.10.5"
    assert manifest["install_metadata"]["ref"] == "old" * 10 and "other" not in json.dumps(manifest["install_metadata"])
    assert tree(world.plugin) == before                  # the live plugin was not touched
    assert read_db(world.db) == ["hello", "world"]


def test_the_database_copy_is_a_consistent_snapshot_even_while_winglet_is_using_it(world):
    live = sqlite3.connect(world.db)
    live.execute("INSERT INTO messages (text) VALUES ('committed')")
    live.commit()
    live.execute("INSERT INTO messages (text) VALUES ('half-written')")      # uncommitted, like a write in flight
    backup = back_up(world)
    assert read_db(backup / "data.db") == ["hello", "world", "committed"]
    live.close()


def test_a_missing_database_is_recorded_not_an_error(world):
    world.db.unlink()
    backup = back_up(world)
    assert not (backup / "data.db").exists()
    assert json.loads((backup / "manifest.json").read_text())["db_sha256"] is None


@pytest.mark.parametrize("frm,to", [("../x", "0.10.5"), ("0.10.4", "0.10.5/../../etc"), ("", "0.10.5"), ("0.10.4", "a b"),
                                    ("0.10.4", "0.10.5\n"), ("0.10.4", "x" * 40)])
def test_odd_version_strings_cannot_shape_a_path(world, frm, to):
    with pytest.raises(ValueError):
        back_up(world, frm, to)
    assert not world.folder.exists() or not list(world.folder.iterdir())


def test_only_a_plugin_folder_under_plugins_can_be_backed_up(world, tmp_path):
    elsewhere = tmp_path / "somewhere" / "winglet"
    elsewhere.mkdir(parents=True)
    with pytest.raises(ValueError):
        ur.create_backup(plugin_dir=elsewhere, db_path=world.db, from_version="0.10.4", to_version="0.10.5", now=NOW)


def test_a_backup_that_fails_halfway_leaves_nothing_behind(world, monkeypatch):
    monkeypatch.setattr(ur.shutil, "copytree", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        back_up(world)
    assert not world.folder.exists() or list(world.folder.iterdir()) == []


def test_two_backups_in_the_same_second_do_not_overwrite_each_other(world):
    back_up(world)
    with pytest.raises(FileExistsError):
        back_up(world)


def test_only_the_last_three_backups_are_kept_and_nothing_else_is_touched(world, tmp_path):
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.txt").write_text("precious")
    world.folder.mkdir(parents=True)
    (world.folder / "notes.txt").write_text("mine")
    (world.folder / "random-folder").mkdir()
    (world.folder / "plugin-0.1.0-pre-0.1.1-20200101-000000").symlink_to(outside, target_is_directory=True)
    made = [back_up(world, "0.10.%d" % i, "0.10.%d" % (i + 1), NOW + i * 60) for i in range(5)]
    names = sorted(p.name for p in world.folder.iterdir() if p.is_dir() and not p.is_symlink() and p.name.startswith("plugin-"))
    assert names == sorted(m.name for m in made[2:])                    # the three newest
    assert (world.folder / "notes.txt").read_text() == "mine" and (world.folder / "random-folder").is_dir()
    assert (outside / "keep.txt").read_text() == "precious"             # a symlink was never followed
    assert (world.folder / "plugin-0.1.0-pre-0.1.1-20200101-000000").is_symlink()


def test_the_backup_just_made_is_never_the_one_pruned(world):
    newest = None
    for i in range(4):
        newest = back_up(world, "0.10.%d" % i, "0.10.%d" % (i + 1), NOW - i * 3600)   # each one OLDER than the last
    assert newest is not None and newest.is_dir()


# -- the rollback: files, install record and database come back --------------------------------------------------


def test_nothing_happens_before_the_deadline_or_without_a_marker(world, capsys):
    backup = back_up(world)
    assert ur.watch(world.root, NOW, sys.stdout) == 0                    # no marker at all
    pretend_the_update_ran(world)
    write_marker(world, backup)
    changed = tree(world.plugin)
    assert ur.watch(world.root, NOW + 179, sys.stdout) == 0              # one second early
    assert capsys.readouterr().out == ""                                 # silent: cron delivers nothing
    assert tree(world.plugin) == changed
    assert json.loads(world.folder.joinpath(ur.MARKER).read_text())["state"] == "pending"


def test_after_the_deadline_the_old_version_comes_back_and_nothing_is_lost(world, capsys):
    original = tree(world.plugin)
    backup = back_up(world)
    pretend_the_update_ran(world)
    other_before = json.loads(world.meta.read_text())["other"]
    write_marker(world, backup)
    assert ur.watch(world.root, NOW + 181, sys.stdout) == 0
    said = capsys.readouterr().out
    # files, install record, database: exactly as backed up
    assert {k: v for k, v in tree(world.plugin).items() if "__pycache__" not in k} == \
           {k: v for k, v in original.items() if "__pycache__" not in k}
    meta = json.loads(world.meta.read_text())
    assert meta["winglet"]["ref"] == "old" * 10 and meta["other"] == other_before
    assert read_db(world.db) == ["hello", "world"]
    # what the failed update left is kept for looking at, outside the plugins folder (Hermes would load it there)
    failed = [p for p in world.folder.iterdir() if p.name.startswith("failed-")]
    assert len(failed) == 1
    assert (failed[0] / "plugin" / "added.py").is_file()
    assert read_db(failed[0] / "data.db") == ["hello", "world", "posted during the update"]
    assert sorted(p.name for p in (world.root / "plugins").iterdir()) == [".install-metadata.json", "winglet"]
    # the message
    assert "0.10.5" in said and "0.10.4" in said and "failed" in said.lower()
    assert str(failed[0]) in said and "posted during" not in said
    assert "NOT been restarted" in said and "restart the gateway yourself" in said
    marker = json.loads(world.folder.joinpath(ur.MARKER).read_text())
    assert marker["state"] == "rolled_back"
    ur.watch(world.root, NOW + 400, sys.stdout)                          # idempotent: the next minute says nothing
    assert capsys.readouterr().out == ""


def test_a_missing_plugin_folder_is_restored_too(world, capsys):
    backup = back_up(world)
    shutil.rmtree(world.plugin)
    write_marker(world, backup)
    ur.watch(world.root, NOW + 200, sys.stdout)
    assert (world.plugin / "plugin.yaml").read_text().endswith("0.10.4\n")
    assert "restored" in capsys.readouterr().out.lower()


def test_a_database_in_use_by_a_running_winglet_is_restored_safely(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    write_marker(world, backup)
    live = sqlite3.connect(world.db)
    live.execute("SELECT * FROM messages").fetchall()
    ur.watch(world.root, NOW + 200, sys.stdout)
    live.close()
    assert read_db(world.db) == ["hello", "world"]
    assert sqlite3.connect(world.db).execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_a_damaged_backup_changes_nothing_and_says_so(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    current = tree(world.plugin)
    with open(backup / "data.db", "r+b") as f:       # one flipped byte in the saved database
        f.seek(2000)
        f.write(b"\xff")
    write_marker(world, backup)
    ur.watch(world.root, NOW + 200, sys.stdout)
    said = capsys.readouterr().out
    assert tree(world.plugin) == current
    assert read_db(world.db)[-1] == "posted during the update"
    assert "could not" in said.lower() and str(backup) in said and "NOT been restarted" in said
    assert json.loads(world.folder.joinpath(ur.MARKER).read_text())["state"] == "rollback_failed"


def test_a_missing_file_in_the_backup_is_a_damaged_backup(world, capsys):
    backup = back_up(world)
    (backup / "plugin" / "hub.py").unlink()
    pretend_the_update_ran(world)
    current = tree(world.plugin)
    write_marker(world, backup)
    ur.watch(world.root, NOW + 200, sys.stdout)
    assert tree(world.plugin) == current and "could not" in capsys.readouterr().out.lower()


@pytest.mark.parametrize("name", ["../../etc", "../x", "/etc", "plugin-0.10.4-pre-0.10.5-20261106-101010/../..", "", "plugin-x", "a/b"])
def test_a_marker_cannot_point_the_restore_at_another_folder(world, capsys, name):
    backup = back_up(world)
    pretend_the_update_ran(world)
    current = tree(world.plugin)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": name, "deadline": NOW, "state": "pending", "started": NOW - 30})
    ur.watch(world.root, NOW + 200, sys.stdout)
    assert tree(world.plugin) == current
    assert backup.is_dir()
    assert "could not" in capsys.readouterr().out.lower()


@pytest.mark.parametrize("field,value", [("plugin_dir", "/etc"), ("db_path", "/etc/passwd"), ("metadata_path", "/etc/hosts"),
                                         ("plugin_dir", "{root}/plugins/../.."), ("db_path", "{root}/../outside.db")])
def test_a_backup_manifest_cannot_aim_the_restore_outside_the_hermes_folder(world, capsys, field, value):
    backup = back_up(world)
    manifest = json.loads((backup / "manifest.json").read_text())
    manifest[field] = value.format(root=world.root)
    (backup / "manifest.json").write_text(json.dumps(manifest))
    pretend_the_update_ran(world)
    current = tree(world.plugin)
    write_marker(world, backup)
    ur.watch(world.root, NOW + 200, sys.stdout)
    assert tree(world.plugin) == current
    assert "could not" in capsys.readouterr().out.lower()
    assert not Path("/etc/passwd.bak").exists()


def test_a_wellformed_manifest_aimed_at_a_plugin_folder_elsewhere_is_refused(world, tmp_path, capsys):
    """Not just a bad path: a consistent set of paths that happens to sit outside the Hermes folder."""
    evil = tmp_path / "evil" / "plugins" / "winglet"
    evil.mkdir(parents=True)
    (evil / "keep.txt").write_text("not yours to replace")
    backup = back_up(world)
    manifest = json.loads((backup / "manifest.json").read_text())
    manifest["plugin_dir"] = str(evil)
    manifest["metadata_path"] = str(evil.parent / ".install-metadata.json")
    (backup / "manifest.json").write_text(json.dumps(manifest))
    write_marker(world, backup)
    ur.watch(world.root, NOW + 200, sys.stdout)
    assert (evil / "keep.txt").read_text() == "not yours to replace" and sorted(p.name for p in evil.parent.iterdir()) == ["winglet"]
    assert "could not" in capsys.readouterr().out.lower()


@pytest.mark.parametrize("how", ["relative", "absolute"])
def test_a_marker_cannot_borrow_a_valid_backup_from_outside_the_backup_folder(world, tmp_path, capsys, how):
    backup = back_up(world)
    stash = world.root / "backups" / "stash" if how == "relative" else tmp_path / "stash"
    shutil.copytree(backup, stash)                      # a perfectly valid backup, just not in the backup folder
    pretend_the_update_ran(world)
    current = tree(world.plugin)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "deadline": NOW, "state": "pending",
                                   "backup": "../stash" if how == "relative" else str(stash)})
    ur.watch(world.root, NOW + 200, sys.stdout)
    assert tree(world.plugin) == current                # it was not restored from there
    assert "could not" in capsys.readouterr().out.lower()


def test_an_unreadable_marker_is_reported_once_and_nothing_is_touched(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    current = tree(world.plugin)
    world.folder.joinpath(ur.MARKER).write_text("{not json")
    ur.watch(world.root, NOW + 500, sys.stdout)
    first = capsys.readouterr().out
    assert "could not read" in first.lower() and tree(world.plugin) == current and backup.is_dir()
    ur.watch(world.root, NOW + 560, sys.stdout)
    assert capsys.readouterr().out == ""


def test_the_marker_is_written_whole_or_not_at_all(world, monkeypatch):
    world.folder.mkdir(parents=True)
    ur.write_marker(world.folder, {"state": "pending", "n": 1})
    monkeypatch.setattr(ur.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(OSError):
        ur.write_marker(world.folder, {"state": "pending", "n": 2})
    assert json.loads(world.folder.joinpath(ur.MARKER).read_text())["n"] == 1
    assert [p.name for p in world.folder.iterdir()] == [ur.MARKER]       # no stray temp file


# -- the rollback never restarts the gateway (Kraig's decision) ---------------------------------------------------


FORBIDDEN_IMPORTS = {"subprocess", "socket", "urllib", "http", "httpx", "requests", "asyncio", "ctypes", "signal", "multiprocessing",
                     "threading", "pty", "shlex", "webbrowser", "smtplib", "ssl", "hermes_cli", "gateway", "cron", "tools", "agent",
                     "plugin", "importlib", "runpy"}
FORBIDDEN_METHODS = {"system", "popen", "fork", "forkpty", "kill", "killpg", "startfile", "posix_spawn", "posix_spawnp",
                     "execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe", "spawnl", "spawnv", "spawnvp"}
FORBIDDEN_BARE_CALLS = {"eval", "exec", "compile", "__import__", "getattr", "setattr"}   # re.compile(...) is fine; compile(...) is not


def imported_names(tree_):
    for node in ast.walk(tree_):
        if isinstance(node, ast.Import):
            yield from (a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            yield node.module.split(".")[0]


def test_the_script_cannot_start_a_process_open_a_socket_or_load_hermes_code():
    parsed = ast.parse(SCRIPT_SOURCE.read_text())
    assert not set(imported_names(parsed)) & FORBIDDEN_IMPORTS, set(imported_names(parsed)) & FORBIDDEN_IMPORTS
    def methods(tree_):
        return {n.func.attr for n in ast.walk(tree_) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}

    def bare(tree_):
        return {n.func.id for n in ast.walk(tree_) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    assert not methods(parsed) & FORBIDDEN_METHODS, methods(parsed) & FORBIDDEN_METHODS
    assert not bare(parsed) & FORBIDDEN_BARE_CALLS, bare(parsed) & FORBIDDEN_BARE_CALLS
    # the guard must be able to see a violation, or it proves nothing
    bad = ast.parse("import os, subprocess\nos.system('x')\neval('1')")
    assert set(imported_names(bad)) & FORBIDDEN_IMPORTS and methods(bad) & FORBIDDEN_METHODS and bare(bad) & FORBIDDEN_BARE_CALLS


def test_the_script_names_no_gateway_or_service_control():
    source = SCRIPT_SOURCE.read_text().lower()
    for word in ("systemctl", "launchctl", "spawn_restart", "gateway restart", "hermes gateway", "control_socket", "reload-plugins",
                 "service restart", "kill -", "pkill", "supervisor"):
        assert word not in source, word


def test_hermes_own_guard_accepts_the_script_as_a_cron_job(world):
    guard = pytest.importorskip("cron.lifecycle_guard", reason="needs the Hermes source on the path")
    guard.check_gateway_lifecycle(None, str(world.script))               # raises GatewayLifecycleBlocked if it sees a restart


def test_a_whole_rollback_runs_with_every_way_to_restart_anything_switched_off(world, monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        raise AssertionError("the rollback tried to start a process or reach a socket")
    backup = back_up(world)
    pretend_the_update_ran(world)
    write_marker(world, backup)
    for name in ("Popen", "run", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, forbidden)
    for name in ("system", "popen", "fork", "kill", "killpg", "posix_spawn", "execv", "execve", "execvp", "spawnv"):
        if hasattr(os, name):
            monkeypatch.setattr(os, name, forbidden)
    for name in ("connect", "connect_ex", "sendto", "bind", "listen"):
        monkeypatch.setattr(socket.socket, name, forbidden)
    assert ur.watch(world.root, NOW + 200, sys.stdout) == 0
    assert json.loads(world.folder.joinpath(ur.MARKER).read_text())["state"] == "rolled_back"
    assert "NOT been restarted" in capsys.readouterr().out


def test_the_installed_script_does_the_job_when_cron_runs_it_as_a_separate_program(world):
    backup = back_up(world)
    pretend_the_update_ran(world)
    write_marker(world, backup, deadline=time.time() - 5)
    quiet = subprocess.run([sys.executable, str(world.script)], capture_output=True, text=True, timeout=60,
                           env={"PATH": os.environ.get("PATH", ""), "HOME": str(world.root / "elsewhere")})
    assert quiet.returncode == 0 and "NOT been restarted" in quiet.stdout, quiet.stdout + quiet.stderr
    assert read_db(world.db) == ["hello", "world"]
    again = subprocess.run([sys.executable, str(world.script)], capture_output=True, text=True, timeout=60)
    assert again.returncode == 0 and again.stdout == ""


def test_the_installed_script_is_silent_when_no_update_is_pending(world):
    done = subprocess.run([sys.executable, str(world.script)], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and done.stdout == "" and done.stderr == ""


# -- an installed update that is waiting for a quiet moment to restart --------------------------------------------------


def test_a_pending_note_is_delivered_once_and_never_rolls_anything_back(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW + 170, "state": "pending",
                                   "cron_job": "job123", "created": NOW, "note": "Winglet 0.10.5 is installed; the gateway restarts when chats finish."})
    current = tree(world.plugin)
    assert ur.watch(world.root, NOW + 60, sys.stdout) == 0
    assert capsys.readouterr().out == "Winglet 0.10.5 is installed; the gateway restarts when chats finish.\n"
    assert tree(world.plugin) == current and json.loads(world.folder.joinpath(ur.MARKER).read_text())["state"] == "pending"
    ur.watch(world.root, NOW + 120, sys.stdout)
    assert capsys.readouterr().out == ""                                  # said once, not every minute


def test_the_note_is_only_marked_as_said_beside_the_record_so_the_waiting_hub_cannot_undo_it(world, capsys):
    backup = back_up(world)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW + 170, "state": "pending",
                                   "created": NOW, "note": "hello"})
    ur.watch(world.root, NOW + 1, sys.stdout)
    capsys.readouterr()
    marker = ur.read_marker(world.folder)
    ur.write_marker(world.folder, {**marker, "deadline": NOW + 200})      # the hub renews its lease, rewriting the whole record
    ur.watch(world.root, NOW + 30, sys.stdout)
    assert capsys.readouterr().out == ""


def test_a_new_update_may_say_its_own_note_and_a_cleared_one_forgets(world, capsys):
    backup = back_up(world)
    record = {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW + 170, "state": "pending", "created": NOW, "note": "first"}
    ur.write_marker(world.folder, record)
    ur.watch(world.root, NOW + 1, sys.stdout)
    ur.clear_marker(world.folder)
    ur.write_marker(world.folder, {**record, "note": "second"})
    capsys.readouterr()
    ur.watch(world.root, NOW + 2, sys.stdout)
    assert capsys.readouterr().out == "second\n"
    ur.write_marker(world.folder, {k: v for k, v in record.items() if k != "note"})   # an update with no note starts clean
    ur.write_marker(world.folder, {**record, "note": "third"})
    ur.watch(world.root, NOW + 3, sys.stdout)
    assert capsys.readouterr().out == "third\n"


@pytest.mark.parametrize("state", ["rolled_back", "rollback_failed"])
def test_a_note_on_a_finished_update_is_not_said(world, capsys, state):
    backup = back_up(world)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW, "state": state, "note": "late"})
    ur.watch(world.root, NOW + 500, sys.stdout)
    assert capsys.readouterr().out == ""


def test_a_note_never_hides_a_rollback_that_is_due(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW + 10, "state": "pending",
                                   "created": NOW, "note": "waiting", "started": NOW - 30})
    ur.watch(world.root, NOW + 100, sys.stdout)
    said = capsys.readouterr().out
    assert "waiting" in said and "put 0.10.4 back" in said and read_db(world.db) == ["hello", "world"]


def test_a_note_cannot_be_huge_or_multi_line_noise(world, capsys):
    backup = back_up(world)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW + 170, "state": "pending",
                                   "created": NOW, "note": "x" * 5000 + "\x07"})
    ur.watch(world.root, NOW + 1, sys.stdout)
    said = capsys.readouterr().out
    assert 0 < len(said) <= 801 and "\x07" not in said


def test_the_lease_keeps_a_waiting_update_safe_for_as_long_as_the_hub_vouches_and_no_longer(world, capsys):
    """The hub renews the deadline while it waits for a quiet moment. Cron stays silent for hours of that, and rolls back
    within the boot window once the renewals stop (the gateway was restarted, or the hub died)."""
    backup = back_up(world)
    pretend_the_update_ran(world)
    for minute in range(0, 120):                                          # two hours of waiting, renewed every 30 seconds
        now = NOW + minute * 60
        ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "state": "pending", "created": NOW,
                                       "started": NOW - 30, "deadline": now + 30 + ur.DEADLINE_SECONDS})
        ur.watch(world.root, now + 30, sys.stdout)
        assert capsys.readouterr().out == "", minute
    assert (world.plugin / "hub.py").read_text().startswith("raise ImportError")
    last = NOW + 119 * 60 + 30
    ur.watch(world.root, last + ur.DEADLINE_SECONDS - 1, sys.stdout)       # the gateway restarted; the new version is still booting
    assert capsys.readouterr().out == ""
    ur.watch(world.root, last + ur.DEADLINE_SECONDS + 60, sys.stdout)      # it never confirmed
    assert "put 0.10.4 back" in capsys.readouterr().out


# -- a fresh database copy for an update that waited -------------------------------------------------------------------


def test_a_refreshed_copy_brings_back_the_chats_written_while_the_update_waited(world):
    backup = back_up(world)
    db = sqlite3.connect(world.db)
    db.execute("INSERT INTO messages (text) VALUES ('written while waiting')")
    db.commit()
    db.close()
    ur.refresh_database(backup)
    report = ur.verify_backup(backup, world.root)
    assert report["db_sha256"] == ur._sha256_file(backup / "data.db")
    pretend_the_update_ran(world)
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW, "state": "pending", "started": NOW - 30})
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert read_db(world.db) == ["hello", "world", "written while waiting"]       # nothing the owner wrote is lost


def test_the_plugin_files_in_the_backup_are_not_touched_by_a_refresh(world):
    backup = back_up(world)
    before = tree(backup / "plugin")
    ur.refresh_database(backup)
    assert tree(backup / "plugin") == before


def test_a_refresh_that_fails_leaves_the_earlier_copy_and_a_valid_backup(world, monkeypatch):
    backup = back_up(world)
    original = (backup / "data.db").read_bytes()
    monkeypatch.setattr(ur, "_snapshot_db", lambda source, dest: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        ur.refresh_database(backup)
    assert (backup / "data.db").read_bytes() == original and ur.verify_backup(backup, world.root)
    assert sorted(p.name for p in backup.iterdir()) == ["data.db", "manifest.json", "plugin"]       # no half-made copy left behind


def test_a_backup_made_without_a_database_is_left_alone(world):
    world.db.unlink()
    backup = back_up(world)
    ur.refresh_database(backup)
    assert not (backup / "data.db").exists() and ur.verify_backup(backup, world.root)


@pytest.mark.parametrize("name", ["not-a-backup", "plugin-1.2.3-pre-1.2.4-2027010-080000", "../escape"])
def test_only_a_real_backup_folder_can_be_refreshed(world, name, tmp_path):
    bad = world.folder / name
    bad.mkdir(parents=True, exist_ok=True)
    with pytest.raises((ur.RollbackError, ValueError)):
        ur.refresh_database(bad)


def test_a_refresh_never_runs_unless_the_backup_verifies(world):
    backup = back_up(world)
    (backup / "plugin" / "hub.py").write_text("tampered")
    with pytest.raises(ur.RollbackError):
        ur.refresh_database(backup)


# -- the database is put back only if the new version ever ran ----------------------------------------------------------------


def pending_record(w, backup, **extra):
    record = {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "deadline": NOW, "state": "pending", "created": NOW - 60, **extra}
    ur.write_marker(w.folder, record)
    return record


def test_a_new_version_that_never_started_leaves_the_database_alone(world, capsys):
    """The restart silently failed and the OLD gateway kept writing to data.db. The watch must not overwrite it."""
    backup = back_up(world)
    db = sqlite3.connect(world.db)
    db.execute("INSERT INTO messages (text) VALUES ('written by the old version after the install')")
    db.commit()
    db.close()
    pretend_the_update_ran(world, extra_message="posted while still on the old gateway")
    pending_record(world, backup)                                   # no "started": the new code never opened the database
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert read_db(world.db) == ["hello", "world", "written by the old version after the install", "posted while still on the old gateway"]
    assert (world.plugin / "plugin.yaml").read_text().endswith("0.10.4\n") and not (world.plugin / "added.py").exists()   # files are restored
    said = capsys.readouterr().out
    assert "database" in said and ("left" in said or "not touched" in said or "untouched" in said)
    assert "the database" not in said.split("Restored from the backup:")[-1].split("\n")[0]       # it does not claim to have restored it
    assert ur.read_marker(world.folder)["state"] == "rolled_back"


def test_a_new_version_that_did_start_gets_its_database_restored(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, started=NOW - 30)
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert read_db(world.db) == ["hello", "world"]
    said = capsys.readouterr().out
    assert "the database" in said.split("Restored from the backup:")[-1].split("\n")[0]


@pytest.mark.parametrize("started", [None, "", 0, False, True, -5, "yes", [], {}])
def test_only_a_real_start_time_counts_as_having_started(world, started):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, **({} if started is None else {"started": started}))
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert read_db(world.db) == ["hello", "world", "posted during the update"]


def test_the_message_does_not_claim_the_gateway_comes_back_on_the_restored_version_when_it_never_left_it(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup)
    ur.watch(world.root, NOW + 100, sys.stdout)
    said = capsys.readouterr().out
    assert "comes back on the version that was restored" not in said
    assert "never started" in said or "did not start" in said or "not start" in said
    assert "NOT been restarted" in said or "not been restarted" in said


def test_the_lease_renewals_keep_the_started_mark(world):
    backup = back_up(world)
    pending_record(world, backup, started=NOW - 30)
    marker = ur.read_marker(world.folder)
    ur.write_marker(world.folder, {**marker, "deadline": NOW + 500})
    assert ur.read_marker(world.folder)["started"] == NOW - 30


# -- a rollback happens once -------------------------------------------------------------------------------------------------


def test_running_the_watch_twice_restores_once(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, started=NOW - 30)
    ur.watch(world.root, NOW + 100, sys.stdout)
    capsys.readouterr()
    db = sqlite3.connect(world.db)
    db.execute("INSERT INTO messages (text) VALUES ('written after the rollback')")
    db.commit()
    db.close()
    ur.watch(world.root, NOW + 160, sys.stdout)
    assert capsys.readouterr().out == "" and read_db(world.db) == ["hello", "world", "written after the rollback"]


def test_a_record_that_cannot_be_written_stops_the_rollback_before_it_touches_anything(world, capsys, monkeypatch):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, started=NOW - 30)
    files, live = tree(world.plugin), read_db(world.db)
    monkeypatch.setattr(ur, "write_marker", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only file system")))
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert tree(world.plugin) == files and read_db(world.db) == live                     # nothing was changed
    said = capsys.readouterr().out
    assert "nothing was changed" in said.lower() and "NOT been restarted" in said.replace("not been restarted", "NOT been restarted")


def test_a_rollback_whose_result_could_not_be_recorded_is_never_repeated(world, capsys, monkeypatch):
    """Writing 'rolling back' works, the restore works, but recording the result fails. The next minute must not restore again."""
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, started=NOW - 30)
    real = ur.write_marker
    calls = []

    def flaky(folder, data):
        calls.append(data.get("state"))
        if data.get("state") in ("rolled_back", "rollback_failed"):
            raise OSError("disk full")
        return real(folder, data)
    monkeypatch.setattr(ur, "write_marker", flaky)
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert calls == ["rolling_back", "rolled_back"]
    capsys.readouterr()
    monkeypatch.setattr(ur, "write_marker", real)
    db = sqlite3.connect(world.db)
    db.execute("INSERT INTO messages (text) VALUES ('written after the rollback')")
    db.commit()
    db.close()
    ur.watch(world.root, NOW + 160, sys.stdout)
    assert read_db(world.db) == ["hello", "world", "written after the rollback"]         # not overwritten with the backup again
    said = capsys.readouterr().out
    assert "did not repeat" in said or "not repeated" in said or "have not repeated" in said
    assert ur.read_marker(world.folder)["state"] == "rollback_failed"
    ur.watch(world.root, NOW + 220, sys.stdout)
    assert capsys.readouterr().out == ""                                                 # said once


def test_a_rollback_that_stopped_halfway_is_reported_not_repeated(world, capsys):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, state="rolling_back", started=NOW - 30, started_rollback_at=NOW)
    files, live = tree(world.plugin), read_db(world.db)
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert tree(world.plugin) == files and read_db(world.db) == live
    said = capsys.readouterr().out
    assert "did not repeat" in said or "not repeated" in said or "have not repeated" in said
    assert str(backup) in said and "NOT been restarted" in said.replace("not been restarted", "NOT been restarted")
    assert ur.read_marker(world.folder)["state"] == "rollback_failed"


def test_the_record_says_rolling_back_before_the_first_file_moves(world, monkeypatch):
    backup = back_up(world)
    pretend_the_update_ran(world)
    pending_record(world, backup, started=NOW - 30)
    seen = []
    real_restore = ur.restore

    def spy(*a, **k):
        seen.append(ur.read_marker(world.folder)["state"])
        return real_restore(*a, **k)
    monkeypatch.setattr(ur, "restore", spy)
    ur.watch(world.root, NOW + 100, sys.stdout)
    assert seen == ["rolling_back"]


def test_rolling_back_is_a_state_the_server_understands_as_a_failed_rollback(world):
    """If a rollback is cut short and nobody has run the watch again, the server must not read the record as 'pending'."""
    from plugin import hermes_api as api
    backup = back_up(world)
    pending_record(world, backup, state="rolling_back")
    assert ur.read_marker(world.folder)["state"] == "rolling_back"
