"""Small hardening of the in-app update, from the cold review.

4. a retry key only finds a job of the same kind
5. a failed set-up leaves no backup folder behind
6. the old Hermes-driven update functions are gone
7. a failed update's kept folder is never reused
8. the install child gets a minimal environment, and what it prints is cleaned before the phone sees it
"""

import asyncio
import os
import sqlite3
import sys

import pytest

from plugin import hermes_api as api
from plugin import update_rollback as ur
from test_control import client, hub, settle, store  # noqa: F401  (fixtures)
from test_plugin_update_flow import NEXT, owner, update  # noqa: F401  (fixtures and helpers)
from test_plugin_update_install import FakeProc, SHA, begin, rows, spawned, world  # noqa: F401  (fixtures and helpers)
from test_plugin_update_rollback import NOW, back_up, pretend_the_update_ran, read_db, world as rollback_world  # noqa: F401
from test_trust import post_signed


# -- 4. a retry key belongs to one kind of job ----------------------------------------------------------------------------


async def test_a_winglet_update_does_not_answer_with_a_job_of_another_kind(client, hub, owner):
    first = await post_signed(client, owner, "/api/system/restart", {"idempotency_key": "same-key"})
    restart_job = (await first.json())["job"]
    await settle(hub)
    resp = await update(client, owner, version=NEXT, key="same-key")
    assert resp.status == 409
    body = await resp.json()
    assert "job" not in body or body["job"]["id"] != restart_job["id"]
    assert not any(call[0] == "begin" for call in hub.hermes.calls)               # nothing was started on the strength of it


async def test_a_restart_does_not_answer_with_an_update_job(client, hub, owner):
    hub.activity_provider = lambda: {"default": {"state": "idle", "queued": 0}}
    first = await update(client, owner, version=NEXT, key="same-key")
    update_job = (await first.json())["job"]
    await settle(hub)
    for job in hub.store.list_jobs(running=True):
        hub.store.update_job(job["id"], state="succeeded")                          # so only the key can be what stops it
    resp = await post_signed(client, owner, "/api/system/restart", {"idempotency_key": "same-key"})
    assert resp.status == 409
    body = await resp.json()
    assert "job" not in body or body["job"]["id"] != update_job["id"]


async def test_a_retry_of_the_same_kind_still_gets_its_own_job(client, hub, owner):
    hub.activity_provider = lambda: {"default": {"state": "idle", "queued": 0}}
    first = (await (await update(client, owner, version=NEXT, key="k-same")).json())["job"]
    await settle(hub)
    again = (await (await update(client, owner, version=NEXT, key="k-same")).json())["job"]
    assert again["id"] == first["id"]
    restart = (await (await post_signed(client, owner, "/api/system/restart", {"idempotency_key": "r-same"})).json())["job"]
    assert (await (await post_signed(client, owner, "/api/system/restart", {"idempotency_key": "r-same"})).json())["job"]["id"] == restart["id"]


# -- 5. no backup folder left by a failed set-up -----------------------------------------------------------------------------


def backups(w):
    return sorted(p.name for p in w.folder.iterdir() if p.is_dir()) if w.folder.exists() else []


def test_when_the_watch_job_cannot_be_made_the_new_backup_folder_is_removed_again(world):
    world.cron.fail_create = True
    with pytest.raises(Exception):
        begin(world)
    assert backups(world) == []


def test_when_the_record_cannot_be_written_the_new_backup_folder_is_removed_again(world, monkeypatch):
    monkeypatch.setattr(ur, "write_marker", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        begin(world)
    assert backups(world) == [] and world.cron.removed == ["job1"]


def test_an_earlier_backup_is_never_removed_by_a_failed_set_up(world):
    first = api.begin_update({**__import__("test_plugin_update_install").RELEASE, "version": "0.10.5"}, "0.10.4", plugin_dir=world.plugin,
                             db_path=world.db, home=world.root, now=NOW - 5000)
    ur.clear_marker(world.folder)
    older = backups(world)
    assert len(older) == 1
    world.cron.fail_create = True
    with pytest.raises(Exception):
        begin(world)
    assert backups(world) == older


# -- 6. the unused Hermes-driven update functions are gone ---------------------------------------------------------------------


@pytest.mark.parametrize("name", ["check_winglet_update", "update_winglet"])
def test_functions_nothing_calls_are_removed(name):
    assert not hasattr(api, name)


# -- 7. a kept folder is never reused -------------------------------------------------------------------------------------------


def test_two_rollbacks_in_the_same_second_keep_separate_folders(rollback_world):
    w = rollback_world
    backup = back_up(w)
    pretend_the_update_ran(w, extra_message="first failure")
    first = ur.restore(w.root, backup, NOW + 10, with_database=False)
    first_files = {p.name for p in first["kept"].rglob("*") if p.is_file()}
    pretend_the_update_ran(w, extra_message="second failure")
    second = ur.restore(w.root, backup, NOW + 10, with_database=False)
    assert first["kept"] != second["kept"] and first["kept"].is_dir() and second["kept"].is_dir()
    assert {p.name for p in first["kept"].rglob("*") if p.is_file()} == first_files          # the first one is untouched
    assert (first["kept"] / "plugin" / "hub.py").read_text().startswith("raise ImportError")
    assert (second["kept"] / "plugin" / "hub.py").read_text().startswith("raise ImportError")


def test_a_kept_folder_that_already_exists_is_not_written_into(rollback_world):
    w = rollback_world
    backup = back_up(w)
    pretend_the_update_ran(w)
    taken = backup.parent / ("failed-" + __import__("time").strftime("%Y%m%d-%H%M%S", __import__("time").gmtime(NOW + 10)))
    taken.mkdir()
    (taken / "precious.txt").write_text("keep me")
    report = ur.restore(w.root, backup, NOW + 10, with_database=False)
    assert report["kept"] != taken and (taken / "precious.txt").read_text() == "keep me" and sorted(p.name for p in taken.iterdir()) == ["precious.txt"]


def test_the_first_kept_folder_keeps_its_plain_name(rollback_world):
    w = rollback_world
    backup = back_up(w)
    pretend_the_update_ran(w)
    report = ur.restore(w.root, backup, NOW + 10, with_database=False)
    assert report["kept"].name == "failed-" + __import__("time").strftime("%Y%m%d-%H%M%S", __import__("time").gmtime(NOW + 10))


# -- 8. the install child ------------------------------------------------------------------------------------------------------------


async def test_the_install_child_gets_only_the_environment_it_needs(monkeypatch, spawned):
    for name, value in {"OPENAI_API_KEY": "sk-secret", "TELEGRAM_BOT_TOKEN": "t0ken", "WINGLET_SECRET": "s", "AWS_SECRET_ACCESS_KEY": "a",
                        "ANTHROPIC_API_KEY": "k", "GITHUB_TOKEN": "g"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("LANG", "en_GB.UTF-8")
    monkeypatch.setenv("LC_ALL", "en_GB.UTF-8")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    await api.install_release(SHA)
    env = spawned[0]["env"]
    assert env["HERMES_HOME"] and env["PATH"] and env["HOME"] and env["LANG"] == "en_GB.UTF-8" and env["LC_ALL"] == "en_GB.UTF-8"
    assert env["HTTPS_PROXY"] == "http://proxy.example:3128"                      # git must still be able to reach GitHub
    leaked = [name for name in env if any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD"))]
    assert leaked == [], leaked
    assert not {"OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "WINGLET_SECRET", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"} & set(env)


async def test_the_install_still_runs_with_a_bare_environment(monkeypatch, spawned):
    for name in list(os.environ):
        monkeypatch.delenv(name, raising=False)
    code, lines = await api.install_release(SHA)
    assert code == 0 and spawned[0]["env"]["HERMES_HOME"]


async def test_what_the_install_prints_is_cleaned_before_it_reaches_the_phone(monkeypatch, spawned):
    noisy = (b"\x1b[31mfatal:\x1b[0m could not read from remote\n"
             b"bell\x07 and nul\x00 and tab\there\n"
             b"\xe2\x80\xae reversed \xe2\x80\x8b zero-width\n"
             + b"x" * 5000 + b"\n"
             + b"\n".join(b"line %d" % i for i in range(100)))

    async def fake_exec(*argv, **kw):
        return FakeProc(1, noisy)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    code, lines = await api.install_release(SHA)
    assert code == 1 and len(lines) <= 30
    text = "\n".join(lines)
    assert "\x1b" not in text and "\x07" not in text and "\x00" not in text and "\u202e" not in text and "\u200b" not in text
    assert all(len(line) <= 300 for line in lines)

    async def fake_exec_two(*argv, **kw):
        return FakeProc(1, noisy.split(b"line 0")[0])
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec_two)
    code, lines = await api.install_release(SHA)
    assert lines[0] == "fatal: could not read from remote"
    assert lines[1] == "bell and nul and tab here"
    assert any(len(line) <= 300 and line.startswith("xxxx") and line.endswith("…") for line in lines)


async def test_clean_output_keeps_ordinary_lines_unchanged(monkeypatch, spawned):
    async def fake_exec(*argv, **kw):
        return FakeProc(0, b"Cloning into 'winglet'...\nInstalled winglet 0.10.5 \xe2\x9c\x93\n")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    assert (await api.install_release(SHA)) == (0, ["Cloning into 'winglet'...", "Installed winglet 0.10.5 ✓"])
