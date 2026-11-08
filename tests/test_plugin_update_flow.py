"""POST /api/system/update for Winglet: the phone names a version, the server decides everything else.

The phone sends only a version. The server refuses unless it is exactly the newest published release and newer than
the one running, takes the repository and the commit from its own GitHub lookup (never from the request), makes the
safety net, installs, and restarts only after a successful install. A failed update never restarts the gateway.
"""

import ast
from pathlib import Path

import pytest

from plugin import hub as hub_module
from plugin.hub import VERSION
from test_control import FakeHermes, client, hub, settle, store  # noqa: F401  (fixtures)
from test_trust import pair_phone, post_signed

SHA = "a" * 40
NEXT = "0.99.0"          # newer than whatever VERSION is today
RELEASE = {"version": NEXT, "tag": f"v{NEXT}", "sha": SHA, "notes": "n", "url": "u", "requires_hermes": ">=0.22.7"}


@pytest.fixture
async def owner(client, hub):
    hub.hermes_version = lambda: "0.23.0"
    hub.hermes.release = dict(RELEASE)
    hub.activity_provider = lambda: {"default": {"state": "idle", "queued": 0}}
    return await pair_phone(client, hub)


async def update(client, owner, **body):
    payload = {"target": "winglet", "idempotency_key": body.pop("key", "k1"), **body}
    return await post_signed(client, owner, "/api/system/update", payload)


def steps(hub):
    """The update steps the hub took (start-up bookkeeping such as 'settle' is not one of them)."""
    return [call for call in hub.hermes.calls if call[0] != "settle"]


def ran(hub):
    return [call[0] for call in steps(hub)]


# -- what is accepted ---------------------------------------------------------------------------------------------


async def test_a_newer_release_is_installed_in_order_and_the_gateway_restarts_only_afterwards(client, hub, owner):
    resp = await update(client, owner, version=NEXT)
    assert resp.status == 202
    job = (await resp.json())["job"]
    assert job["kind"] == "winglet_update" and job["detail"]["from"] == VERSION and job["detail"]["to"] == NEXT
    await settle(hub)
    assert steps(hub) == [("begin", NEXT, VERSION), ("install", SHA), ("verify", NEXT), ("arm",), ("restart",)]
    done = hub.store.get_job(job["id"])
    assert done["state"] == "running" and done["detail"]["pid"] == 4242        # finished by the next process
    assert done["detail"]["backup"] == "plugin-b"                              # the folder name, not a path on the server
    assert (f"started a Winglet update to {NEXT}") in [a["summary"] for a in hub.store.list_audit()]


async def test_the_release_is_looked_up_afresh_at_the_moment_of_the_update(client, hub, owner):
    await client.get("/api/system/updates", headers=owner.auth)                # fills the ten-minute cache
    await update(client, owner, version=NEXT)
    await settle(hub)
    assert hub.hermes.release_calls[-1] is True


async def test_the_phone_cannot_choose_the_repository_the_commit_or_the_branch(client, hub, owner):
    resp = await update(client, owner, version=NEXT, repo="evil/winglet", ref="main", sha="b" * 40, branch="main",
                        url="https://evil.example/x.zip", tag="v0.0.1", source="https://evil.example", force=True)
    assert resp.status == 202
    await settle(hub)
    assert ("install", SHA) in steps(hub) and not any("evil" in str(c) or "b" * 40 in str(c) for c in steps(hub))


async def test_a_retried_request_returns_the_same_job_and_installs_once(client, hub, owner):
    first = (await (await update(client, owner, version=NEXT, key="same")).json())["job"]
    await settle(hub)
    again = (await (await update(client, owner, version=NEXT, key="same")).json())["job"]
    assert again["id"] == first["id"]
    assert ran(hub).count("begin") == 1 and ran(hub).count("install") == 1


async def test_a_retry_after_the_restart_still_finds_its_job_even_though_the_version_has_changed(client, hub, owner, monkeypatch):
    first = (await (await update(client, owner, version=NEXT, key="same")).json())["job"]
    await settle(hub)
    monkeypatch.setattr(hub_module, "VERSION", NEXT)               # the server came back as the new version
    again = await update(client, owner, version=NEXT, key="same")   # the phone asks again; "same version" must not hide the job
    assert again.status == 202 and (await again.json())["job"]["id"] == first["id"]


async def test_only_one_update_runs_at_a_time(client, hub, owner):
    hub.store.create_job("restart", detail={"boot": hub.boot_id})
    resp = await update(client, owner, version=NEXT, key="other")
    assert resp.status == 409 and ran(hub) == []


# -- what is refused, and that refusing changes nothing ----------------------------------------------------------


@pytest.mark.parametrize("version,status", [
    (None, 400), (5, 400), ("", 400), ("garbage", 400), ("v" + NEXT, 400), (NEXT + "-beta.1", 400), (" " + NEXT, 400),
    (NEXT + "\n", 400), ("0.99", 400), ("latest", 400), ("main", 400), (["0.99.0"], 400), ({"v": NEXT}, 400),
    (VERSION, 409),            # the same version
    ("0.0.1", 409),            # older
    ("0.99.1", 409),           # newer than anything published: unknown
    ("1.0.0", 409),
])
async def test_only_the_newest_published_version_is_accepted_and_a_refusal_changes_nothing(client, hub, owner, version, status):
    resp = await update(client, owner, **({} if version is None else {"version": version}))
    assert resp.status == status, await resp.text()
    assert "error" in await resp.json()
    assert hub.store.list_jobs() == [] and steps(hub) == [] and hub.hermes.restarts == 0


async def test_a_request_without_a_version_gets_a_clear_message(client, hub, owner):
    resp = await update(client, owner)
    assert resp.status == 400 and "version" in (await resp.json())["error"].lower()


async def test_the_newest_release_is_refused_when_it_is_not_newer_than_what_runs(client, hub, owner):
    hub.hermes.release = {**RELEASE, "version": VERSION, "tag": f"v{VERSION}"}
    resp = await update(client, owner, version=VERSION)
    assert resp.status == 409 and "already" in (await resp.json())["error"]
    hub.hermes.release = {**RELEASE, "version": "0.0.1", "tag": "v0.0.1"}      # a downgrade, even though it is "the latest"
    assert (await update(client, owner, version="0.0.1", key="k2")).status == 409
    assert steps(hub) == []


async def test_without_a_reachable_github_nothing_is_attempted(client, hub, owner):
    hub.hermes.release = hub.hermes.ReleaseCheckFailed("offline")
    resp = await update(client, owner, version=NEXT)
    assert resp.status == 503 and "Nothing was changed" in (await resp.json())["error"]
    assert hub.store.list_jobs() == [] and steps(hub) == []


async def test_with_no_published_release_there_is_nothing_to_install(client, hub, owner):
    hub.hermes.release = None
    assert (await update(client, owner, version=NEXT)).status == 409 and steps(hub) == []


async def test_a_release_that_needs_a_newer_hermes_is_refused_before_anything_is_touched(client, hub, owner):
    hub.hermes_version = lambda: "0.22.0"
    resp = await update(client, owner, version=NEXT)
    assert resp.status == 409 and "Hermes" in (await resp.json())["error"]
    assert steps(hub) == [] and hub.store.list_jobs() == []


async def test_an_unknown_hermes_version_does_not_block_the_update(client, hub, owner):
    hub.hermes_version = lambda: ""           # cannot tell; the safety net covers a release Hermes then refuses to load
    assert (await update(client, owner, version=NEXT)).status == 202


async def test_only_a_signed_owner_may_update(client, hub, owner):
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await update(client, member, version=NEXT)).status == 403
    unsigned = await client.post("/api/system/update", json={"target": "winglet", "version": NEXT}, headers=owner.auth)
    assert unsigned.status in (401, 403)
    assert (await client.post("/api/system/update", json={"target": "winglet", "version": NEXT})).status in (401, 403)
    assert steps(hub) == [] and hub.store.list_jobs() == []


# -- when something goes wrong: undo what was done, say what happened, never restart --------------------------------


async def failed_job(client, hub, owner):
    resp = await update(client, owner, version=NEXT)
    job = (await resp.json())["job"]
    await settle(hub)
    return hub.store.get_job(job["id"])


async def test_if_the_safety_net_cannot_be_made_nothing_is_installed(client, hub, owner):
    hub.hermes.begin_error = ValueError("cron is unavailable")
    done = await failed_job(client, hub, owner)
    assert done["state"] == "failed" and "nothing was changed" in done["detail"]["message"].lower()
    assert steps(hub) == [("begin", NEXT, VERSION)]
    assert hub.hermes.restarts == 0


async def test_a_failed_install_is_undone_and_the_gateway_is_not_restarted(client, hub, owner):
    hub.hermes.install_result = (1, ["fatal: could not read from remote"])
    done = await failed_job(client, hub, owner)
    assert done["state"] == "failed" and done["detail"]["lines"][-1] == "fatal: could not read from remote"
    assert "put back" in done["detail"]["message"] and "not restarted" in done["detail"]["message"]
    assert steps(hub) == [("begin", NEXT, VERSION), ("install", SHA), ("cancel",)]


async def test_an_install_that_leaves_the_wrong_version_on_disk_is_undone(client, hub, owner):
    hub.hermes.installed_ok = False
    done = await failed_job(client, hub, owner)
    assert done["state"] == "failed" and f"not at {NEXT}" in " ".join(done["detail"]["lines"])
    assert ran(hub) == ["begin", "install", "verify", "cancel"]


async def test_an_install_that_crashes_is_undone(client, hub, owner):
    hub.hermes.install_result = RuntimeError("boom")
    done = await failed_job(client, hub, owner)
    assert done["state"] == "failed" and ran(hub) == ["begin", "install", "cancel"]


async def test_if_the_old_version_cannot_be_put_back_the_job_says_where_the_backup_is(client, hub, owner):
    hub.hermes.install_result = (1, ["boom"])
    hub.hermes.cancel_error = RuntimeError("the saved database is damaged")
    done = await failed_job(client, hub, owner)
    message = done["detail"]["message"]
    assert done["state"] == "failed" and "could not put the old version back" in message and "plugin-b" in message
    assert "not restarted" in message


async def test_a_restart_that_cannot_start_undoes_the_install_and_does_not_try_again(client, hub, owner):
    hub.hermes.restart_error = RuntimeError("no restart")
    done = await failed_job(client, hub, owner)
    assert done["state"] == "failed" and "restart" in done["detail"]["message"].lower()
    assert ran(hub) == ["begin", "install", "verify", "arm", "restart", "cancel"]       # one attempt, then undone


@pytest.mark.parametrize("fault", ["begin", "install_code", "install_raises", "wrong_version", "cancel_fails"])
async def test_no_failed_update_ever_restarts_the_gateway(client, hub, owner, fault):
    """Kraig's decision: nothing on a failure path may call a restart. He restarts the gateway himself."""
    if fault == "begin":
        hub.hermes.begin_error = ValueError("no")
    elif fault == "install_code":
        hub.hermes.install_result = (2, ["x"])
    elif fault == "install_raises":
        hub.hermes.install_result = OSError("x")
    elif fault == "wrong_version":
        hub.hermes.installed_ok = False
    else:
        hub.hermes.install_result = (1, ["x"])
        hub.hermes.cancel_error = RuntimeError("no")
    done = await failed_job(client, hub, owner)
    assert done["state"] == "failed"
    assert ("restart",) not in steps(hub) and hub.hermes.restarts == 0


def _references_in(function: ast.AST):
    """Every name or attribute the function mentions (a function handed to asyncio.to_thread is mentioned, not called)."""
    for node in ast.walk(function):
        if isinstance(node, ast.Attribute):
            yield node.attr, node.lineno
        elif isinstance(node, ast.Name):
            yield node.id, node.lineno


RESTARTS = ("spawn_restart", "restart_update", "_restart_soon", "h_restart")


def test_the_failure_code_in_the_hub_cannot_restart_anything():
    names = ("_run_winglet_update", "_restart_when_quiet", "_abandon_update", "_is_quiet", "_hold_through_restart", "_finish_gone")
    tree = ast.parse(Path(hub_module.__file__).read_text())
    methods = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name in names}
    assert set(methods) == set(names)
    for name in names:
        if name != "_restart_when_quiet":
            assert not [r for r in _references_in(methods[name]) if r[0] in RESTARTS], name
    run = list(_references_in(methods["_restart_when_quiet"]))
    restarts = [line for name, line in run if name in RESTARTS]
    arm = [line for name, line in run if name == "arm_deadline"]
    assert len(restarts) == 1 and arm and restarts[0] > arm[0]            # one place restarts, and only after the deadline is armed
    # ...and it sits on the success path: the only code that reaches it is the branch where the busy list was empty
    source = Path(hub_module.__file__).read_text().splitlines()
    spawn_line = restarts[0]
    guard = max(i for i in range(spawn_line) if source[i].strip() == "if quiet:")
    assert guard < spawn_line - 1 and all(source[i].startswith("                    ") for i in range(guard + 1, spawn_line))
    # the guard must see a violation, or it proves nothing
    bad = ast.parse("async def f(h):\n    await asyncio.to_thread(h.spawn_restart)")
    assert [r for r in _references_in(bad) if r[0] in RESTARTS]


# -- starting up as the new (or old) version ------------------------------------------------------------------------


async def reconcile(hub, from_version, settled, target=NEXT):
    job, _ = hub.store.create_job("winglet_update", detail={"boot": "old", "from": from_version, "to": target})
    hub.hermes.settled = settled
    await hub.reconcile_jobs()
    return hub.store.get_job(job["id"])


async def test_the_new_version_settling_makes_the_job_succeed(hub):
    done = await reconcile(hub, "0.0.1", {"outcome": "succeeded", "from": "0.0.1", "to": VERSION}, target=VERSION)
    assert done["state"] == "succeeded" and ("settle", VERSION) in hub.hermes.calls


async def test_after_a_rollback_the_job_says_the_old_version_was_put_back_and_points_to_telegram(hub):
    done = await reconcile(hub, VERSION, {"outcome": "rolled_back", "from": VERSION, "to": NEXT, "kept": "/x/failed-1"})
    message = done["detail"]["message"]
    assert done["state"] == "failed" and "put back" in message and "Telegram" in message and "did not restart" in message.lower()


async def test_after_a_failed_rollback_the_job_says_so(hub):
    done = await reconcile(hub, VERSION, {"outcome": "rollback_failed", "from": VERSION, "to": NEXT, "error": "damaged"})
    assert done["state"] == "failed" and "could not" in done["detail"]["message"].lower() and "backups" in done["detail"]["message"]


async def test_a_server_still_on_the_old_version_with_nothing_settled_is_a_failed_update(hub):
    done = await reconcile(hub, VERSION, None)
    assert done["state"] == "failed" and VERSION in done["detail"]["message"]


async def test_settling_happens_at_start_up_even_when_no_job_remembers_the_update(hub):
    hub.hermes.settled = {"outcome": "succeeded", "from": "0.0.1", "to": VERSION}
    await hub.reconcile_jobs()
    assert hub.hermes.calls == [("settle", VERSION)]


async def test_a_hermes_that_cannot_settle_does_not_stop_the_other_jobs_from_finishing(hub):
    job, _ = hub.store.create_job("restart", detail={"boot": "old"})
    hub.hermes.settle_pending_update = lambda v: (_ for _ in ()).throw(RuntimeError("no"))
    await hub.reconcile_jobs()
    assert hub.store.get_job(job["id"])["state"] == "succeeded"
