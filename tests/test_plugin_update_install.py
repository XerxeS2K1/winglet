"""Installing a release from the app: the install command, the safety net set up before it, and what happens after.

Order matters and is tested here: backup, then the watch script, then the cron job, then the pending-update record,
and only then the install. If any step fails nothing is installed. A failed install is rolled back in-process (files and
install record only: the new code never ran, so the database is not touched) and never restarts the gateway.
"""

import asyncio
import json
import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

from plugin import hermes_api as api
from plugin import update_rollback as ur

NOW = 1_800_000_000.0
SHA = "a" * 40
RELEASE = {"version": "0.10.5", "tag": "v0.10.5", "sha": SHA, "notes": "n", "url": "u", "requires_hermes": ">=0.22.7"}


class FakeCron:
    """The two cron functions the update uses, recording how they were called."""

    def __init__(self):
        self.created, self.removed, self.fail_create, self.fail_remove = [], [], False, False

    def create_job(self, prompt, schedule, **kwargs):
        if self.fail_create:
            raise RuntimeError("cron is unavailable")
        self.created.append({"prompt": prompt, "schedule": schedule, **kwargs})
        return {"id": f"job{len(self.created)}"}

    def remove_job(self, job_id):
        if self.fail_remove:
            raise RuntimeError("cannot remove")
        self.removed.append(job_id)
        return True


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    plugin = root / "plugins" / "winglet"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.4\n")
    (plugin / "hub.py").write_text("VERSION = '0.10.4'\n")
    db = root / "plugin-data" / "winglet" / "data.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT)")
    conn.execute("INSERT INTO messages (text) VALUES ('before')")
    conn.commit()
    conn.close()
    (root / "plugins" / ".install-metadata.json").write_text(json.dumps({"winglet": {"pinned": True, "ref": "old"}}))
    cron = FakeCron()
    monkeypatch.setattr(api, "_cron", lambda: cron)
    return type("World", (), {"root": root, "plugin": plugin, "db": db, "cron": cron, "folder": root / "backups" / ur.BACKUP_FOLDER})()


def begin(w, **kw):
    return api.begin_update(RELEASE, "0.10.4", plugin_dir=w.plugin, db_path=w.db, home=w.root, now=NOW, **kw)


def rows(path):
    conn = sqlite3.connect(path)
    try:
        return [r[0] for r in conn.execute("SELECT text FROM messages ORDER BY id")]
    finally:
        conn.close()


# -- the install command -----------------------------------------------------------------------------------------


class FakeProc:
    def __init__(self, code=0, out=b"Installed winglet\nDone\n"):
        self.returncode, self._out, self.killed = code, out, False

    async def communicate(self):
        return self._out, None

    def kill(self):
        self.killed = True


@pytest.fixture
def spawned(monkeypatch):
    pytest.importorskip("hermes_cli._launchers", reason="needs the Hermes source on the path")
    pytest.importorskip("hermes_cli.web_server", reason="needs the Hermes source on the path")
    calls = []

    def fake_runtime_command(root, args=(), **kw):
        return ["hermes-python", "-m", "hermes_cli.main", *args]

    async def fake_exec(*argv, **kw):
        calls.append({"argv": list(argv), **kw})
        return FakeProc()

    monkeypatch.setattr("hermes_cli._launchers.runtime_command", fake_runtime_command)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


async def test_the_install_is_exactly_the_command_used_by_hand_at_the_release_commit(spawned):
    code, lines = await api.install_release(SHA)
    assert code == 0 and lines[-1] == "Done"
    assert spawned[0]["argv"][3:] == ["plugins", "install", "XerxeS2K1/winglet/plugin", "--ref", SHA, "--force", "--no-enable", "--yes-deps"]
    assert spawned[0]["stdin"] == asyncio.subprocess.DEVNULL     # it can never wait for an answer


@pytest.mark.parametrize("bad", ["main", "v0.10.5", "", "a" * 39, "A" * 40, "a" * 40 + " --extra", "a" * 40 + "\n", None, 5,
                                 "--force", "../../x", "a" * 41])
async def test_only_a_plain_commit_id_can_ever_reach_the_install_command(spawned, bad):
    with pytest.raises(ValueError):
        await api.install_release(bad)
    assert spawned == []


async def test_an_install_that_hangs_is_stopped_and_reported(monkeypatch, spawned):
    proc = FakeProc()

    async def never():
        await asyncio.sleep(3600)

    proc.communicate = never

    async def fake_exec(*argv, **kw):
        return proc
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    code, lines = await api.install_release(SHA, timeout=0.05)
    assert code == -1 and proc.killed and "too long" in lines[0]


async def test_a_failed_install_reports_its_output(monkeypatch, spawned):
    async def fake_exec(*argv, **kw):
        return FakeProc(1, b"fatal: could not read from remote\n")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    code, lines = await api.install_release(SHA)
    assert code == 1 and lines == ["fatal: could not read from remote"]


def test_the_installed_version_is_read_from_the_plugin_itself(world):
    assert api.installed_version_is("0.10.4", plugin_dir=world.plugin) is True
    assert api.installed_version_is("0.10.5", plugin_dir=world.plugin) is False
    (world.plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.5\n")
    assert api.installed_version_is("0.10.5", plugin_dir=world.plugin) is True
    (world.plugin / "plugin.yaml").write_text("garbage")
    assert api.installed_version_is("0.10.5", plugin_dir=world.plugin) is False
    (world.plugin / "plugin.yaml").unlink()
    assert api.installed_version_is("0.10.5", plugin_dir=world.plugin) is False


# -- the safety net before anything is installed -------------------------------------------------------------------


def test_everything_is_in_place_before_the_install_may_start(world):
    prepared = begin(world)
    backup = Path(prepared["backup"])
    assert backup.parent == world.folder and (backup / "plugin" / "plugin.yaml").is_file() and rows(backup / "data.db") == ["before"]
    script = world.root / "scripts" / ur.SCRIPT_NAME
    assert script.read_bytes() == Path(ur.__file__).read_bytes()      # the running, known-good copy
    assert len(world.cron.created) == 1
    job = world.cron.created[0]
    assert job["prompt"] is None and job["no_agent"] is True and job["script"] == str(script)
    assert job["schedule"] == "every 1m" and job["deliver"] == "telegram" and 1 <= job["repeat"] <= 60
    marker = json.loads((world.folder / ur.MARKER).read_text())
    assert marker == {"from": "0.10.4", "to": "0.10.5", "backup": backup.name, "state": "pending", "cron_job": "job1",
                      "created": NOW, "deadline": NOW + api.UPDATE_INSTALL_WINDOW_SECONDS}
    assert prepared["to"] == "0.10.5" and prepared["job"] == "job1"
    assert (world.plugin / "plugin.yaml").read_text().endswith("0.10.4\n")   # nothing installed yet


def test_the_restart_window_starts_when_the_install_is_done(world):
    prepared = begin(world)
    api.arm_deadline(prepared, now=NOW + 500)
    assert json.loads((world.folder / ur.MARKER).read_text())["deadline"] == NOW + 500 + ur.DEADLINE_SECONDS


def test_no_cron_means_no_update_and_nothing_is_left_pending(world):
    world.cron.fail_create = True
    with pytest.raises(Exception):
        begin(world)
    assert not (world.folder / ur.MARKER).exists() and world.cron.created == []


def test_a_failure_after_the_job_exists_removes_the_job(world, monkeypatch):
    monkeypatch.setattr(ur, "write_marker", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        begin(world)
    assert world.cron.removed == ["job1"] and not (world.folder / ur.MARKER).exists()


@pytest.mark.parametrize("release", [
    {**RELEASE, "sha": "main"}, {**RELEASE, "sha": "a" * 39}, {**RELEASE, "version": "0.10.5-beta.1"}, {**RELEASE, "version": "../x"},
    {**RELEASE, "tag": "main"}, {k: v for k, v in RELEASE.items() if k != "sha"}, None, "0.10.5", {},
])
def test_a_release_that_does_not_look_right_is_refused_before_anything_is_made(world, release):
    with pytest.raises(ValueError):
        api.begin_update(release, "0.10.4", plugin_dir=world.plugin, db_path=world.db, home=world.root, now=NOW)
    assert not world.folder.exists() and world.cron.created == []


def test_an_install_layout_the_watch_script_cannot_find_is_refused(world, tmp_path):
    elsewhere = tmp_path / "other-home" / "profiles" / "x"           # cron would look for scripts and backups elsewhere
    elsewhere.mkdir(parents=True)
    with pytest.raises(ValueError, match="layout"):
        api.begin_update(RELEASE, "0.10.4", plugin_dir=world.plugin, db_path=world.db, home=elsewhere, now=NOW)
    assert not world.folder.exists() and world.cron.created == []


def test_an_update_already_waiting_to_be_confirmed_blocks_another_but_a_stale_one_does_not(world):
    begin(world)
    with pytest.raises(ValueError, match="already"):
        api.begin_update(RELEASE, "0.10.4", plugin_dir=world.plugin, db_path=world.db, home=world.root, now=NOW + 60)
    assert len(world.cron.created) == 1
    api.begin_update(RELEASE, "0.10.4", plugin_dir=world.plugin, db_path=world.db, home=world.root, now=NOW + 7200)   # hours later
    assert len(world.cron.created) == 2


# -- a failed install is undone in-process, without the database, without a restart -------------------------------


def test_cancelling_after_a_failed_install_puts_the_files_back_but_not_the_database(world):
    prepared = begin(world)
    (world.plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.5\n")
    (world.plugin / "half.py").write_text("partial install")
    conn = sqlite3.connect(world.db)
    conn.execute("INSERT INTO messages (text) VALUES ('sent while updating')")
    conn.commit()
    conn.close()
    api.cancel_update(prepared, now=NOW + 30)
    assert (world.plugin / "plugin.yaml").read_text().endswith("0.10.4\n") and not (world.plugin / "half.py").exists()
    assert rows(world.db) == ["before", "sent while updating"]       # the new code never ran: user data is left alone
    assert json.loads((world.root / "plugins" / ".install-metadata.json").read_text())["winglet"]["ref"] == "old"
    assert not (world.folder / ur.MARKER).exists() and world.cron.removed == ["job1"]


def test_if_cancelling_cannot_restore_it_says_so_and_still_stops_the_watch(world):
    prepared = begin(world)
    (Path(prepared["backup"]) / "plugin" / "hub.py").unlink()          # a damaged backup
    (world.plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.5\n")
    with pytest.raises(ur.RollbackError):
        api.cancel_update(prepared, now=NOW + 30)
    assert (world.plugin / "plugin.yaml").read_text().endswith("0.10.5\n")      # untouched, as the failing check promised
    assert json.loads((world.folder / ur.MARKER).read_text())["state"] == "rollback_failed"
    assert world.cron.removed == ["job1"]                                        # the cron script will not retry with the database


def test_restoring_files_only_leaves_the_database_alone(world):
    backup = ur.create_backup(plugin_dir=world.plugin, db_path=world.db, from_version="0.10.4", to_version="0.10.5", now=NOW)
    conn = sqlite3.connect(world.db)
    conn.execute("INSERT INTO messages (text) VALUES ('later')")
    conn.commit()
    conn.close()
    report = ur.restore(world.root, backup, NOW + 5, with_database=False)
    assert "the database" not in report["done"] and rows(world.db) == ["before", "later"]
    assert not (report["kept"] / "data.db").exists()
    ur.restore(world.root, backup, NOW + 9, with_database=True)
    assert rows(world.db) == ["before"]


# -- what the new Winglet does when it starts -----------------------------------------------------------------------


def test_the_new_version_confirms_itself_and_the_watch_is_stood_down(world):
    begin(world)
    assert api.settle_pending_update("0.10.5", home=world.root) == {"outcome": "succeeded", "from": "0.10.4", "to": "0.10.5"}
    assert not (world.folder / ur.MARKER).exists() and world.cron.removed == ["job1"]
    assert api.settle_pending_update("0.10.5", home=world.root) is None            # nothing left to settle


def test_a_server_still_on_the_old_version_leaves_the_pending_update_to_the_watch(world):
    begin(world)
    assert api.settle_pending_update("0.10.4", home=world.root) is None
    assert (world.folder / ur.MARKER).exists() and world.cron.removed == []


def test_after_a_rollback_the_old_version_learns_what_happened_and_clears_the_record(world):
    begin(world)
    marker = ur.read_marker(world.folder)
    marker.update(state="rolled_back", kept=str(world.folder / "failed-x"))
    ur.write_marker(world.folder, marker)
    result = api.settle_pending_update("0.10.4", home=world.root)
    assert result["outcome"] == "rolled_back" and result["from"] == "0.10.4" and result["to"] == "0.10.5"
    assert not (world.folder / ur.MARKER).exists() and world.cron.removed == ["job1"]


def test_a_failed_rollback_is_also_reported_and_cleared(world):
    begin(world)
    marker = ur.read_marker(world.folder)
    marker.update(state="rollback_failed", error="the saved database is damaged or incomplete")
    ur.write_marker(world.folder, marker)
    result = api.settle_pending_update("0.10.4", home=world.root)
    assert result["outcome"] == "rollback_failed" and "damaged" in result["error"]


def test_settling_survives_cron_being_unavailable_and_an_unreadable_record(world):
    begin(world)
    world.cron.fail_remove = True
    assert api.settle_pending_update("0.10.5", home=world.root)["outcome"] == "succeeded"      # the record still clears
    assert not (world.folder / ur.MARKER).exists()
    (world.folder / ur.MARKER).write_text("{broken")
    assert api.settle_pending_update("0.10.5", home=world.root) is None                        # reported by the watch, not here


# -- an installed update that waits for a quiet moment to restart --------------------------------------------------------


def test_holding_the_lease_keeps_the_rollback_off_without_arming_the_restart_clock(world):
    prepared = begin(world)
    assert api.hold_lease(prepared, "Installed; restarting when chats finish.", now=NOW + 500) is True
    marker = json.loads((world.folder / ur.MARKER).read_text())
    assert marker["deadline"] == NOW + 500 + ur.DEADLINE_SECONDS and marker["note"] == "Installed; restarting when chats finish."
    assert marker["state"] == "pending" and marker["backup"] == Path(prepared["backup"]).name
    assert api.hold_lease(prepared, now=NOW + 560) is True                # renewing keeps the note, and does not repeat it
    marker = json.loads((world.folder / ur.MARKER).read_text())
    assert marker["deadline"] == NOW + 560 + ur.DEADLINE_SECONDS and marker["note"].startswith("Installed")


def test_the_lease_says_no_when_the_watch_has_already_acted(world):
    prepared = begin(world)
    marker = ur.read_marker(world.folder)
    ur.write_marker(world.folder, {**marker, "state": "rolled_back"})
    assert api.hold_lease(prepared, now=NOW + 500) is False
    assert ur.read_marker(world.folder)["state"] == "rolled_back"        # a rolled-back update is not turned back into a pending one


def test_the_lease_says_no_for_a_different_or_missing_update(world):
    prepared = begin(world)
    ur.clear_marker(world.folder)
    assert api.hold_lease(prepared, now=NOW + 500) is False
    ur.write_marker(world.folder, {"from": "0.10.4", "to": "0.10.6", "backup": "plugin-0.10.4-pre-0.10.6-20270101-000000", "state": "pending", "deadline": NOW})
    assert api.hold_lease(prepared, now=NOW + 500) is False


def test_the_note_is_cleaned_and_capped_before_it_is_stored(world):
    prepared = begin(world)
    api.hold_lease(prepared, "x" * 5000 + "\x07", now=NOW)
    note = json.loads((world.folder / ur.MARKER).read_text())["note"]
    assert len(note) <= 800 and "\x07" not in note


def test_the_database_copy_in_the_backup_can_be_refreshed_from_the_hub(world):
    prepared = begin(world)
    db = sqlite3.connect(world.db)
    db.execute("INSERT INTO messages (text) VALUES ('later')")
    db.commit()
    db.close()
    api.snapshot_database(prepared)
    assert rows(Path(prepared["backup"]) / "data.db") == ["before", "later"]


def test_the_watch_outlives_the_longest_wait_with_room_to_spare():
    """The cron job removes itself after its last run. It must still be there when a slow, waiting update restarts."""
    from plugin import hub
    longest = api.UPDATE_INSTALL_WINDOW_SECONDS + hub.RESTART_WAIT_SECONDS + hub.RESTART_GRACE_SECONDS + ur.DEADLINE_SECONDS
    assert api.UPDATE_WATCH_RUNS * 60 >= longest + 300
    assert hub.RESTART_WAIT_SECONDS < api.UPDATE_STALE_SECONDS
