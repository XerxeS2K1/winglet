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
