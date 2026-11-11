"""A bot with a tracked background process (pytest, a build, a long script) is Working, even when its chat is quiet.

Hermes admissions say a bot is busy only while it handles a message. A bot that answers 'noted' in seconds and then runs a
mutation script for half an hour reads as idle with nothing queued, and the owner thinks it is done. Hermes keeps the
background processes it started in a checkpoint file per profile (<home>/processes.json); bot_activity reads it, counts
the entries that belong to this bot and are still the same live process, and says 'working' with a count. It shows no
command lines (they can hold secrets), invents no queue, and a file it cannot read changes nothing.
"""
import json
import os
import subprocess
import sys
import time

import pytest

from plugin import hermes_api
from test_bot_activity import activity  # noqa: F401  (fixture)


def start_ticks(pid):
    return int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[19])


@pytest.fixture
def child():
    """A real process that stays alive, and is stopped afterwards."""
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    yield proc
    proc.kill()
    proc.wait()


def entry(pid, *, key="agent:chef:winglet:chat", session="proc_a", started=None, scope="host", **extra):
    started = start_ticks(pid) if started is None else started
    return {"session_id": session, "pid": pid, "pid_scope": scope, "host_start_time": started, "session_key": key,
            "command": "SECRET_TOKEN=hunter2 pytest -q", "started_at": time.time(), **extra}


def write(home, entries, name="processes.json"):
    path = home / name
    path.write_text(json.dumps(entries))
    return path


# -- a live process makes the bot Working ------------------------------------------------------------------------------------


def test_a_live_background_process_means_working_with_a_count(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid)])
    result = hermes_api.bot_activity(home, "chef")
    assert result["state"] == "working" and result["background"] == 1 and result["queued"] == 0
    assert result["reason"] == "Running a background task"


def test_several_processes_are_counted_and_the_reason_says_how_many(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, session="proc_a"), entry(child.pid, session="proc_b"), entry(child.pid, session="proc_c")])
    result = hermes_api.bot_activity(home, "chef")
    assert result["background"] == 3 and result["reason"] == "Running 3 background tasks"


def test_no_file_means_the_old_answer_exactly(activity):
    home, _, _ = activity
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_an_empty_registry_means_the_old_answer_exactly(activity):
    home, _, _ = activity
    write(home, [])
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


# -- stale entries never count ---------------------------------------------------------------------------------------------------


def test_a_process_that_has_ended_does_not_count(activity):
    home, _, _ = activity
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    ticks = None
    try:
        ticks = start_ticks(proc.pid)
    except OSError:
        pass
    proc.wait()
    write(home, [entry(proc.pid, started=ticks or 1)])
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_a_process_that_has_ended_but_was_not_collected_does_not_count(activity):
    home, _, _ = activity
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    try:
        for _ in range(100):                                       # wait until it is a zombie: finished, not yet collected
            if open(f"/proc/{proc.pid}/stat").read().rsplit(")", 1)[1].split()[0] == "Z":
                break
            time.sleep(0.02)
        write(home, [entry(proc.pid)])
        assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}
    finally:
        proc.wait()


def test_a_recycled_process_number_does_not_count(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, started=start_ticks(child.pid) + 1)])      # the number is alive, but it is another process now
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_an_entry_without_a_start_time_does_not_count_a_process_that_began_after_it_was_recorded(activity, child):
    """A reused pid: the number is alive, but the process behind it is newer than the entry that names it."""
    home, _, _ = activity
    for recorded in (time.time() - 3600, None, "yesterday", 0):
        item = entry(child.pid, started_at=recorded)
        del item["host_start_time"]
        write(home, [item])
        assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}, recorded


def test_an_entry_without_a_start_time_is_trusted_while_its_process_started_before_the_entry(activity, child):
    home, _, _ = activity
    item = entry(child.pid)
    del item["host_start_time"]
    write(home, [item])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1
    item["host_start_time"] = None
    write(home, [item])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1


def test_a_process_inside_a_sandbox_cannot_be_checked_so_it_does_not_count(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, scope="sandbox")])
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


# -- whose process it is -----------------------------------------------------------------------------------------------------------


def test_only_this_bots_processes_count(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, key="agent:chef:winglet:chat"), entry(child.pid, key="agent:other:winglet:chat", session="proc_b"),
                 entry(child.pid, key="agent:main:telegram:dm:1", session="proc_c")])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1
    assert hermes_api.bot_activity(home, "other")["background"] == 1
    assert hermes_api.bot_activity(home, "default")["background"] == 1                      # the main bot is agent:main
    assert "background" not in hermes_api.bot_activity(home, "stranger")


def test_a_name_that_only_starts_the_same_does_not_match(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, key="agent:chefs:winglet:chat"), entry(child.pid, key="agent:chef", session="proc_b")])
    assert "background" not in hermes_api.bot_activity(home, "chef")


def test_a_profile_called_main_is_not_the_default_bot(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, key="agent:main~:winglet:chat")])
    assert hermes_api.bot_activity(home, "main")["background"] == 1
    assert "background" not in hermes_api.bot_activity(home, "default")


def test_one_file_lists_every_profiles_processes_so_the_other_files_entries_are_found_too(activity, child):
    """Hermes writes a profile's checkpoint from whichever profile happened to be active, so a bot's process can be in the
    main home's file. Both are read, and a process listed in both counts once."""
    home, _, _ = activity
    host = home / "host"
    host.mkdir()
    write(home, [entry(child.pid, session="proc_a")])
    write(host, [entry(child.pid, session="proc_a"), entry(child.pid, session="proc_b")])
    assert hermes_api.bot_activity(home, "chef")["background"] == 2


# -- a file that cannot be read changes nothing -------------------------------------------------------------------------------------


@pytest.mark.parametrize("content", ["{broken", "", "[]garbage", '{"a": 1}', "null", "123", '"text"', "\x00\x01\x02", "[1, 2, null, \"x\", [3]]"])
def test_unreadable_or_odd_content_leaves_the_old_answer(activity, content):
    home, _, _ = activity
    (home / "processes.json").write_text(content)
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_binary_garbage_leaves_the_old_answer(activity):
    home, _, _ = activity
    (home / "processes.json").write_bytes(b"\xff\xfe\x00garbage" * 50)
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_a_folder_where_the_file_should_be_leaves_the_old_answer(activity):
    home, _, _ = activity
    (home / "processes.json").mkdir()
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_a_huge_file_is_not_read(activity, child, monkeypatch):
    home, _, _ = activity
    write(home, [entry(child.pid)])
    monkeypatch.setattr(hermes_api, "BACKGROUND_FILE_MAX_BYTES", 10)
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


@pytest.mark.parametrize("bad", [
    {"pid": None}, {"pid": 0}, {"pid": -5}, {"pid": True}, {"pid": "123"}, {"pid": 1.5}, {"pid": 2 ** 70},
    {"session_key": None}, {"session_key": 5}, {"session_key": ""}, {"session_key": ["agent:chef:x"]},
    {"pid_scope": None}, {"host_start_time": "soon"}, {"host_start_time": True},
])
def test_an_odd_entry_is_skipped_and_never_raises(activity, child, bad):
    home, _, _ = activity
    write(home, [{**entry(child.pid), **bad}, "text", None, 5, ["x"]])
    result = hermes_api.bot_activity(home, "chef")
    assert result["state"] in ("idle", "working") and result.get("background", 0) in (0, 1)
    assert result.get("background") != 1 or bad in ({"pid_scope": None}, {"host_start_time": "soon"}, {"host_start_time": True})


def test_the_number_looked_at_is_bounded(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, session=f"proc_{i}") for i in range(900)])
    assert hermes_api.bot_activity(home, "chef")["background"] == hermes_api.BACKGROUND_MAX_ENTRIES


# -- how it combines with what was already known -------------------------------------------------------------------------------------


def test_admission_based_work_still_counts_and_background_work_is_added_to_it(activity, child):
    home, response, _ = activity
    import sqlite3
    with sqlite3.connect(home / "state.db") as db:
        db.executemany("INSERT INTO session_admissions VALUES (?, ?, ?)", [(1, "bot:a", "started"), (2, "bot:b", "queued")])
    assert hermes_api.bot_activity(home, "chef") == {"state": "working", "queued": 1}              # unchanged without a background process
    write(home, [entry(child.pid)])
    result = hermes_api.bot_activity(home, "chef")
    assert result["state"] == "working" and result["queued"] == 1 and result["background"] == 1


def test_live_agent_work_still_counts_without_a_background_process(activity):
    home, response, _ = activity
    response["active_agents"] = 2
    assert hermes_api.bot_activity(home, "chef") == {"state": "working", "queued": 0}


def test_background_work_does_not_invent_a_queue(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid)])
    assert hermes_api.bot_activity(home, "chef", include_queue=True)["queue"] is None  # old fixture schema: details remain unavailable
    assert hermes_api.bot_activity(home, "chef")["queued"] == 0


def test_when_the_gateway_cannot_say_but_a_process_is_running_the_bot_is_working(activity, child, monkeypatch):
    home, _, _ = activity
    from gateway import control_socket
    monkeypatch.setattr(control_socket, "query_gateway_control", lambda *a, **k: None)
    assert hermes_api.bot_activity(home, "chef")["state"] == "unknown"
    write(home, [entry(child.pid)])
    result = hermes_api.bot_activity(home, "chef")
    assert result["state"] == "working" and result["background"] == 1


def test_an_unreadable_file_never_turns_a_known_answer_into_unknown(activity):
    home, response, _ = activity
    (home / "processes.json").write_text("{broken")
    assert hermes_api.bot_activity(home, "chef")["state"] == "idle"
    response["active_agents"] = 1
    assert hermes_api.bot_activity(home, "chef")["state"] == "working"


# -- what the owner is shown ---------------------------------------------------------------------------------------------------------


def test_no_command_line_ever_leaves_the_server(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, command="SECRET_TOKEN=hunter2 curl https://x.example/?key=abc", cwd="/root/private")])
    for include_queue in (False, True):
        shown = json.dumps(hermes_api.bot_activity(home, "chef", include_queue=include_queue))
        for needle in ("hunter2", "curl", "SECRET", "abc", "/root/private", "x.example"):
            assert needle not in shown


def test_the_answer_only_gains_two_small_fields(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid)])
    assert set(hermes_api.bot_activity(home, "chef")) == {"state", "queued", "background", "reason"}
    assert set(hermes_api.bot_activity(home, "chef", include_queue=True)) == {"state", "queued", "queue", "queue_truncated", "background", "reason"}
    result = hermes_api.bot_activity(home, "chef")
    assert type(result["background"]) is int and isinstance(result["reason"], str) and len(result["reason"]) < 40


def test_the_file_is_only_read_never_written(activity, child):
    home, _, _ = activity
    path = write(home, [entry(child.pid)])
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    hermes_api.bot_activity(home, "chef")
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before


# -- Hermes's own file ------------------------------------------------------------------------------------------------------------------


def test_the_file_hermes_itself_writes_is_understood(activity, child, monkeypatch):
    """The reader is checked against Hermes's own writer, so a change in its format shows up here."""
    registry = pytest.importorskip("tools.process_registry")
    home, _, _ = activity
    monkeypatch.setattr(registry, "CHECKPOINT_PATH", home / "processes.json")
    table = registry.ProcessRegistry()
    table._running["proc_x"] = registry.ProcessSession(id="proc_x", command="pytest -q", pid=child.pid, session_key="agent:chef:winglet:chat",
                                                       task_id="host-local-profile:chef:session:x", started_at=time.time())
    table._write_checkpoint()
    assert json.loads((home / "processes.json").read_text())[0]["session_id"] == "proc_x"
    assert hermes_api.bot_activity(home, "chef")["background"] == 1
    assert "background" not in hermes_api.bot_activity(home, "default")


def test_the_fields_relied_on_are_still_part_of_hermes_checkpoint():
    registry = pytest.importorskip("tools.process_registry")
    for name in ("pid", "pid_scope", "host_start_time", "session_key"):
        assert name in registry._CHECKPOINT_FIELDS, name


def test_the_session_key_prefix_is_the_one_hermes_uses():
    session = pytest.importorskip("gateway.session")
    for profile in ("default", "chef", "main", None):
        assert hermes_api._background_prefix(profile) == session._session_key_namespace(profile) + ":"


def test_the_checkpoint_name_is_the_one_hermes_uses():
    registry = pytest.importorskip("tools.process_registry")
    assert registry.CHECKPOINT_PATH.name == hermes_api.BACKGROUND_FILE


# -- review fixes -----------------------------------------------------------------------------------------------------------------


def test_entries_of_other_bots_never_use_up_the_budget_of_this_one(activity, child):
    """500 other-profile entries came first and the one live entry of this bot, last, was never looked at."""
    home, _, _ = activity
    others = [entry(child.pid, key="agent:other:winglet:chat", session=f"proc_other_{i}") for i in range(hermes_api.BACKGROUND_MAX_ENTRIES)]
    write(home, others + [entry(child.pid, session="proc_mine")])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1
    write(home, [entry(child.pid, session="proc_mine")])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1                     # the same entry alone, as the review compared


def test_a_crowded_gateway_file_does_not_hide_this_bots_own_file(activity, child):
    home, _, _ = activity
    host = home / "host"
    host.mkdir()
    write(host, [entry(child.pid, key="agent:other:winglet:chat", session=f"proc_other_{i}") for i in range(hermes_api.BACKGROUND_MAX_ENTRIES + 50)])
    write(home, [entry(child.pid, session="proc_mine")])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1


def test_the_bound_applies_to_this_bots_own_entries(activity, child):
    home, _, _ = activity
    write(home, [entry(child.pid, key="agent:other:winglet:chat", session="proc_o")] +
          [entry(child.pid, session=f"proc_{i}") for i in range(hermes_api.BACKGROUND_MAX_ENTRIES + 100)])
    assert hermes_api.bot_activity(home, "chef")["background"] == hermes_api.BACKGROUND_MAX_ENTRIES


def test_a_recorded_start_time_that_cannot_be_checked_without_proc_is_not_trusted(activity, child, monkeypatch, tmp_path):
    """On a platform without /proc the recorded start cannot be compared, so the process is not proven to be the same one."""
    home, _, _ = activity
    monkeypatch.setattr(hermes_api, "_PROC_ROOT", tmp_path / "no-proc-here")
    write(home, [entry(child.pid)])
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}


def test_without_proc_an_entry_with_no_recorded_start_time_still_counts_while_alive(activity, child, monkeypatch, tmp_path):
    home, _, _ = activity
    monkeypatch.setattr(hermes_api, "_PROC_ROOT", tmp_path / "no-proc-here")
    item = entry(child.pid)
    del item["host_start_time"]
    write(home, [item])
    assert hermes_api.bot_activity(home, "chef")["background"] == 1


def test_a_file_over_the_size_limit_is_not_read_even_when_it_is_still_valid_json(activity, child, monkeypatch):
    """Valid JSON padded with whitespace past the limit: decoding would succeed, so only the size guard can refuse it."""
    home, _, _ = activity
    monkeypatch.setattr(hermes_api, "BACKGROUND_FILE_MAX_BYTES", 600)
    body = json.dumps([entry(child.pid)])
    assert len(body) < 600
    (home / "processes.json").write_text(body)
    assert hermes_api.bot_activity(home, "chef")["background"] == 1                      # under the limit: read
    (home / "processes.json").write_text(body + " " * 700)
    assert json.loads((home / "processes.json").read_text())[0]["pid"] == child.pid      # still perfectly valid JSON
    assert hermes_api.bot_activity(home, "chef") == {"state": "idle", "queued": 0}
