"""The new version records that it started, right before it first opens the database.

The rollback watch restores the database only if the new code ran. The only place Winglet opens data.db is
adapter.open_store, so the mark is made there, before the Store (and its schema changes) can touch the file.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from plugin import adapter, hermes_api as api, update_rollback as ur
from plugin.hub import VERSION

NOW = 1_800_000_000.0


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    (root / "plugins" / "winglet").mkdir(parents=True)
    folder = root / "backups" / ur.BACKUP_FOLDER
    folder.mkdir(parents=True)
    (root / "plugin-data" / "winglet").mkdir(parents=True)
    monkeypatch.setattr(api, "_home", lambda: root)
    return type("World", (), {"root": root, "folder": folder, "data": root / "plugin-data" / "winglet"})()


def pending(w, to=None, **extra):
    ur.write_marker(w.folder, {"from": "0.0.1", "to": to or VERSION, "backup": "plugin-0.0.1-pre-0.10.5-20270101-000000",
                               "state": "pending", "deadline": NOW, "created": NOW - 60, **extra})


def test_the_new_version_marks_itself_started(world):
    pending(world)
    assert api.mark_started(VERSION, now=NOW + 5) is True
    marker = ur.read_marker(world.folder)
    assert marker["started"] == NOW + 5 and marker["state"] == "pending" and marker["to"] == VERSION


def test_the_first_start_time_is_kept(world):
    pending(world)
    api.mark_started(VERSION, now=NOW + 5)
    api.mark_started(VERSION, now=NOW + 99)
    assert ur.read_marker(world.folder)["started"] == NOW + 5


@pytest.mark.parametrize("state", ["rolled_back", "rollback_failed", "rolling_back"])
def test_a_finished_or_cut_short_rollback_is_never_marked_started(world, state):
    pending(world, state=state)
    assert api.mark_started(VERSION, now=NOW) is False
    assert "started" not in ur.read_marker(world.folder)


def test_a_different_version_is_not_marked(world):
    pending(world, to="0.99.0")
    assert api.mark_started(VERSION, now=NOW) is False
    assert "started" not in ur.read_marker(world.folder)


def test_no_pending_update_means_nothing_to_mark(world):
    assert api.mark_started(VERSION, now=NOW) is False
    assert not (world.folder / ur.MARKER).exists()


def test_a_broken_record_never_stops_winglet_starting(world):
    (world.folder / ur.MARKER).write_text("{broken")
    assert api.mark_started(VERSION, now=NOW) is False


def test_a_record_that_cannot_be_written_never_stops_winglet_starting(world, monkeypatch):
    pending(world)
    monkeypatch.setattr(ur, "write_marker", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")))
    assert api.mark_started(VERSION, now=NOW) is False


def test_the_mark_is_made_before_the_database_is_opened(world, monkeypatch):
    """If the database were opened first, a crash during its schema changes would leave a changed file and no mark."""
    pending(world)
    order = []
    monkeypatch.setattr(adapter, "data_dir", lambda: world.data)
    real_mark = api.mark_started
    monkeypatch.setattr(api, "mark_started", lambda version, **kw: order.append("mark") or real_mark(version, **kw))
    real_store = adapter.Store

    class Spy(real_store):
        def __init__(self, path):
            order.append("store")
            assert "started" in (ur.read_marker(world.folder) or {})             # already recorded when the file is first opened
            super().__init__(path)
    monkeypatch.setattr(adapter, "Store", Spy)
    store = adapter.open_store()
    store.close()
    assert order == ["mark", "store"]


def test_a_failing_mark_does_not_stop_the_database_opening(world, monkeypatch):
    monkeypatch.setattr(adapter, "data_dir", lambda: world.data)
    monkeypatch.setattr(api, "mark_started", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    store = adapter.open_store()
    store.close()
    assert (world.data / "data.db").is_file()
