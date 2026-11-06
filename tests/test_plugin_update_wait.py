"""After a successful install the gateway restarts by itself only when no chat is running.

Kraig's decision: failures never restart. A success restarts at once when the busy list is empty; otherwise the new
files stay installed, the job says the restart is pending, the owner is told through the update's own Telegram note, and
the hub restarts when the chats finish, within a bounded wait. The rollback must not fire on an update that is merely
waiting, and must not be armed from the install: its clock follows the restart.
"""

import asyncio
import time

import pytest

from plugin import hub as hub_module
from test_control import FakeHermes, client, hub, settle, store  # noqa: F401  (fixtures)
from test_plugin_update_flow import NEXT, SHA, RELEASE, owner, ran, steps, update  # noqa: F401  (fixtures and helpers)

BUSY = {"hermes": {"state": "working", "queued": 0}}
QUEUED = {"hermes": {"state": "idle", "queued": 2}}
IDLE = {"hermes": {"state": "idle", "queued": 0}}
UNKNOWN = {"hermes": {"state": "unknown", "queued": None}}


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(hub_module, "RESTART_POLL_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "RESTART_WAIT_SECONDS", 0.6)
    monkeypatch.setattr(hub_module, "RESTART_GRACE_SECONDS", 0.2)
    monkeypatch.setattr(hub_module, "SNAPSHOT_EVERY_SECONDS", 0.05)


class Activity:
    """What the bots are doing, as a test controls it."""
    def __init__(self, hub, now):
        self.now = now
        hub.activity_provider = lambda: self.now


async def wait_for(condition, seconds=3.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.01)
    return False


async def start(client, owner):
    resp = await update(client, owner, version=NEXT)
    assert resp.status == 202
    return (await resp.json())["job"]["id"]


def job(hub, job_id):
    return hub.store.get_job(job_id)


# -- nothing is running: as before ----------------------------------------------------------------------------------


@pytest.mark.parametrize("quiet", [IDLE, {}, {"hermes": {"state": "idle", "queued": 0}, "chef": {"state": "idle", "queued": 0}}])
async def test_with_nothing_running_the_gateway_restarts_at_once(client, hub, owner, quiet):
    Activity(hub, quiet)
    job_id = await start(client, owner)
    await settle(hub)
    assert steps(hub)[:5] == [("begin", NEXT, __import__("plugin").hub.VERSION), ("install", SHA), ("verify", NEXT), ("arm",), ("restart",)]
    assert hub.hermes.restarts == 1 and job(hub, job_id)["detail"].get("phase") != "restart_pending"
    assert ("snapshot",) not in steps(hub) and not any(c[0] == "hold" and c[1] for c in steps(hub))   # no waiting note, no extra snapshot


# -- something is running: install, but wait ------------------------------------------------------------------------


@pytest.mark.parametrize("busy", [BUSY, QUEUED, UNKNOWN, {"hermes": {"state": "idle", "queued": 0}, "chef": {"state": "working", "queued": 0}}])
async def test_while_something_runs_the_update_is_installed_and_the_restart_waits(client, hub, owner, busy):
    Activity(hub, busy)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    assert hub.hermes.restarts == 0 and ("restart",) not in steps(hub)
    assert ran(hub)[:3] == ["begin", "install", "verify"] and "cancel" not in ran(hub) and "arm" not in ran(hub)
    now = job(hub, job_id)
    assert now["state"] == "running"                                     # still the one update in progress: nothing else starts
    message = now["detail"]["message"].lower()
    assert "installed" in message and "restart" in message and "chats" in message and "yourself" in message
    note = next(c[1] for c in steps(hub) if c[0] == "hold" and c[1])
    assert NEXT in note and "installed" in note and "restart" in note.lower() and "yourself" in note.lower()
    await hub.aclose()


async def test_unknown_activity_is_never_taken_for_quiet(client, hub, owner):
    Activity(hub, UNKNOWN)
    await start(client, owner)
    await asyncio.sleep(0.3)
    assert hub.hermes.restarts == 0
    await hub.aclose()


async def test_the_pending_state_is_visible_to_the_phone_through_the_job(client, hub, owner):
    Activity(hub, BUSY)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    detail = job(hub, job_id)["detail"]
    assert isinstance(detail["wait_until"], (int, float)) and 0 < detail["wait_until"] - time.time() <= 1
    await hub.aclose()


# -- it becomes quiet --------------------------------------------------------------------------------------------------


async def test_when_the_chats_finish_the_gateway_restarts_exactly_once(client, hub, owner):
    activity = Activity(hub, BUSY)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    assert hub.hermes.restarts == 0
    activity.now = IDLE
    assert await wait_for(lambda: hub.hermes.restarts == 1)
    await settle(hub)
    await asyncio.sleep(0.3)
    assert hub.hermes.restarts == 1
    order = ran(hub)
    assert order.index("snapshot") < order.index("arm") < order.index("restart")     # fresh database copy, then the clock, then the restart
    assert job(hub, job_id)["detail"]["pid"] == 4242


async def test_while_it_waits_the_database_copy_is_refreshed_from_time_to_time(client, hub, owner):
    """If someone restarts the gateway by hand during a long wait, a rollback must not undo the chats written since."""
    Activity(hub, BUSY)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    assert await wait_for(lambda: ran(hub).count("snapshot") >= 2)          # more than one, and still no restart
    assert hub.hermes.restarts == 0
    await hub.aclose()


async def test_a_periodic_copy_that_fails_does_not_end_the_wait(client, hub, owner):
    Activity(hub, BUSY)
    hub.hermes.snapshot_error = OSError("disk full")
    job_id = await start(client, owner)
    assert await wait_for(lambda: ran(hub).count("snapshot") >= 2)
    assert job(hub, job_id)["state"] == "running" and "cancel" not in ran(hub)
    await hub.aclose()


async def test_it_restarts_on_the_first_quiet_check_not_after_the_whole_wait(client, hub, owner):
    activity = Activity(hub, BUSY)
    started = time.monotonic()
    await start(client, owner)
    await asyncio.sleep(0.15)
    activity.now = IDLE
    assert await wait_for(lambda: hub.hermes.restarts == 1)
    assert time.monotonic() - started < 0.55


async def test_a_chat_that_starts_just_before_the_restart_holds_it_back(client, hub, owner):
    """The busy list is read again right before the restart is asked for, not only on the poll before it."""
    states = iter([BUSY, IDLE, BUSY, BUSY, BUSY])
    last = {"v": BUSY}

    def provider():
        last["v"] = next(states, BUSY)
        return last["v"]
    hub.activity_provider = provider
    await start(client, owner)
    await asyncio.sleep(0.25)
    assert hub.hermes.restarts == 0
    await hub.aclose()


# -- the rollback clock ---------------------------------------------------------------------------------------------------


async def test_the_rollback_clock_is_not_armed_by_the_install_only_by_the_restart(client, hub, owner):
    activity = Activity(hub, BUSY)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    await asyncio.sleep(0.1)
    assert "arm" not in ran(hub)                       # waiting only ever holds the rollback off
    assert ran(hub).count("hold") >= 3                 # and keeps doing so for as long as it waits
    activity.now = IDLE
    assert await wait_for(lambda: hub.hermes.restarts == 1)
    assert ran(hub).count("arm") == 1 and ran(hub).index("arm") < ran(hub).index("restart")


async def test_if_the_rollback_already_happened_nothing_is_restarted(client, hub, owner):
    """The watch put the old version back (the hub stalled for longer than the lease). Restarting now would load nothing
    new and report a success that did not happen."""
    activity = Activity(hub, BUSY)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    hub.hermes.lease_ok = False
    activity.now = IDLE
    assert await wait_for(lambda: job(hub, job_id)["state"] == "failed")
    assert hub.hermes.restarts == 0 and "cancel" not in ran(hub)      # nothing left to undo: the watch did it
    assert "put back" in job(hub, job_id)["detail"]["message"] or "rolled back" in job(hub, job_id)["detail"]["message"]


# -- the wait is bounded ---------------------------------------------------------------------------------------------------


async def test_after_the_longest_wait_the_install_is_undone_and_nothing_restarts(client, hub, owner):
    Activity(hub, BUSY)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["state"] == "failed")
    detail = job(hub, job_id)["detail"]
    assert "cancel" in ran(hub) and hub.hermes.restarts == 0 and ("restart",) not in steps(hub)
    assert "put back" in detail["message"] and "not restarted" in detail["message"] and "quiet" in detail["message"].lower()


def test_the_longest_wait_is_shorter_than_the_age_at_which_a_waiting_update_stops_blocking_a_new_one():
    from plugin import hermes_api as api
    assert 0 < hub_module.RESTART_WAIT_SECONDS < api.UPDATE_STALE_SECONDS


# -- Hermes refuses the restart ---------------------------------------------------------------------------------------------


async def test_if_hermes_refuses_the_restart_the_update_waits_again_instead_of_being_rolled_back(client, hub, owner):
    hub.hermes.refuses_restart = True                  # "Refusing to restart the gateway: 1 live session(s) would be interrupted"
    Activity(hub, IDLE)
    job_id = await start(client, owner)
    assert await wait_for(lambda: hub.hermes.restarts >= 1)
    await asyncio.sleep(0.35)                          # past the grace period: the process is still here, so nothing restarted
    assert job(hub, job_id)["state"] == "running" and "cancel" not in ran(hub)     # not given up yet, nothing undone
    holds = [i for i, c in enumerate(steps(hub)) if c[0] == "hold"]
    restarts = [i for i, c in enumerate(steps(hub)) if c[0] == "restart"]
    assert holds and holds[-1] > restarts[0]           # the rollback was kept off after the refused restart
    await hub.aclose()


async def test_a_refused_restart_is_tried_a_bounded_number_of_times(client, hub, owner):
    hub.hermes.refuses_restart = True
    Activity(hub, IDLE)
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["state"] == "failed", 6)
    assert 1 <= hub.hermes.restarts <= hub_module.MAX_RESTART_TRIES
    assert "cancel" in ran(hub) and "not restarted" in job(hub, job_id)["detail"]["message"] or hub.hermes.restarts == hub_module.MAX_RESTART_TRIES


async def test_the_rollback_is_held_off_for_the_whole_time_the_restart_may_still_be_draining(client, hub, owner):
    hub.hermes.refuses_restart = True
    Activity(hub, IDLE)
    await start(client, owner)
    assert await wait_for(lambda: hub.hermes.restarts >= 1)
    before = ran(hub).count("hold")
    await asyncio.sleep(0.1)
    assert ran(hub).count("hold") > before            # still renewing after the restart was asked for
    await hub.aclose()


# -- failures still never restart --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("fault", ["begin", "install_code", "wrong_version", "restart_error"])
async def test_failures_still_never_restart_even_when_nothing_is_running(client, hub, owner, fault):
    Activity(hub, IDLE)
    if fault == "begin":
        hub.hermes.begin_error = ValueError("no")
    elif fault == "install_code":
        hub.hermes.install_result = (2, ["x"])
    elif fault == "wrong_version":
        hub.hermes.installed_ok = False
    else:
        hub.hermes.restart_error = RuntimeError("no restart")
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["state"] == "failed")
    assert hub.hermes.restarts == 0 and (fault != "restart_error" or ran(hub).count("restart") == 1)
    assert "cancel" in ran(hub) or fault == "begin"


async def test_a_database_copy_that_cannot_be_made_stops_the_restart_and_undoes_the_install(client, hub, owner):
    activity = Activity(hub, BUSY)
    hub.hermes.snapshot_error = OSError("disk full")
    job_id = await start(client, owner)
    assert await wait_for(lambda: job(hub, job_id)["detail"].get("phase") == "restart_pending")
    activity.now = IDLE
    assert await wait_for(lambda: job(hub, job_id)["state"] == "failed")
    assert hub.hermes.restarts == 0 and "cancel" in ran(hub)


async def test_a_waiting_update_survives_a_failing_activity_scan(client, hub, owner):
    def broken():
        raise RuntimeError("scan failed")
    hub.activity_provider = broken
    await start(client, owner)
    await asyncio.sleep(0.2)
    assert hub.hermes.restarts == 0                    # could not look: not quiet
    await hub.aclose()


async def test_nothing_is_undone_once_the_restart_has_been_asked_for(client, hub, owner, monkeypatch):
    """If bookkeeping fails after the gateway was told to restart, the new code may be loading right now: leave it."""
    Activity(hub, IDLE)
    monkeypatch.setattr(hub_module, "RESTART_GRACE_SECONDS", 0.3)

    def broken(prepared, note=None):
        hub.hermes.calls.append(("hold", note))
        raise OSError("record unreadable")
    hub.hermes.hold_lease = broken
    job_id = await start(client, owner)
    assert await wait_for(lambda: hub.hermes.restarts == 1)
    await asyncio.sleep(0.3)
    assert "cancel" not in ran(hub) and job(hub, job_id)["state"] == "running"
    await hub.aclose()
