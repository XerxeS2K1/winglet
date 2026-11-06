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
