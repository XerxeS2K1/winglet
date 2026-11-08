"""The control center: health, pause, restart and update jobs, logs and the schedule."""

import asyncio
import json
import time

import pytest

from plugin import hermes_api as api
from plugin import hub as hub_module
from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone, post_signed


class Refused(ValueError):
    pass


class Unavailable(RuntimeError):
    pass


class FakeHermes:
    """The control-center functions plugin/hermes_api.py offers, with Hermes's behaviour faked."""
    HermesRefused = Refused
    HermesUnavailable = Unavailable

    def __init__(self):
        self.pause = None
        self.restarts = 0
        self.update_started = {"ok": True, "action_id": "a1"}
        self.update_status = {"running": True, "exit_code": None, "lines": ["pulling"]}
        self.routines = {}
        self.release_calls = []
        self.calls = []
        self.begin_error = self.cancel_error = self.restart_error = self.snapshot_error = None
        self.lease_ok = True
        self.refuses_restart = False   # Hermes refuses a restart while sessions are live: the process carries on
        self.hub = self.loop = None
        self.install_result = (0, ["Installed winglet"])
        self.installed_ok = True
        self.settled = None
        self.release = {"version": "0.10.9", "tag": "v0.10.9", "sha": "a" * 40, "notes": "What is new",
                        "url": "https://github.com/XerxeS2K1/winglet/releases/tag/v0.10.9", "requires_hermes": ">=0.22.7"}

    def system_stats(self):
        return {"system": "Linux", "cpu_count": 4, "cpu_percent": 12.5,
                "memory": {"total": 8, "used": 4, "percent": 50.0}, "disk": {"total": 100, "used": 30, "percent": 30.0}}

    def paused(self):
        return self.pause

    def set_paused(self, on, reason=""):
        self.pause = {"reason": reason, "engaged_at": "2026-10-06T10:00:00+00:00"} if on else None
        return self.pause

    def spawn_restart(self):
        self.calls.append(("restart",))
        if self.restart_error:
            raise self.restart_error
        self.restarts += 1
        if self.loop is not None and not self.refuses_restart:
            self.loop.call_soon_threadsafe(self.loop.call_later, 0.05, self._gateway_goes_down)
        return 4242

    async def start_hermes_update(self):
        return dict(self.update_started)

    async def hermes_update_status(self):
        return dict(self.update_status)

    async def check_hermes_update(self, force=False):
        return {"install_method": "git", "current_version": "0.9", "behind": 3, "update_available": True, "can_apply": True}

    def check_winglet_update(self):
        # Hermes's own check says "provenance drift" for every sub-directory install; the app must not rely on it.
        raise AssertionError("the Winglet update answer must not come from Hermes's run_checks")

    async def update_winglet(self):
        raise AssertionError("Hermes's cmd_update is gone: a release is installed by commit id after a backup")

    # The release lookup is the only part that needs the network; the version rules are the real ones.
    parse_version = staticmethod(api.parse_version)
    is_newer = staticmethod(api.is_newer)
    hermes_supports = staticmethod(api.hermes_supports)
    busy_bots = staticmethod(api.busy_bots)
    ReleaseCheckFailed = api.ReleaseCheckFailed

    # The steps of an in-app install, recorded in order so tests can say what ran, and in what order.
    def begin_update(self, release, from_version):
        self.calls.append(("begin", release["version"], from_version))
        if self.begin_error:
            raise self.begin_error
        return {"backup": "/home/x/.hermes/backups/winglet-plugin/plugin-b", "job": "cron1", "from": from_version,
                "to": release["version"], "folder": "/f", "root": "/r"}

    async def install_release(self, sha):
        self.calls.append(("install", sha))
        if isinstance(self.install_result, Exception):
            raise self.install_result
        return self.install_result

    def installed_version_is(self, version):
        self.calls.append(("verify", version))
        return self.installed_ok

    def arm_deadline(self, prepared):
        self.calls.append(("arm",))
        return True

    def restart_update(self, prepared):
        return self.spawn_restart()

    def hold_lease(self, prepared, note=None):
        """While an installed update waits for a quiet moment: keep the rollback from firing. False if it already has."""
        self.calls.append(("hold", note))
        return self.lease_ok

    def snapshot_database(self, prepared):
        self.calls.append(("snapshot",))
        if self.snapshot_error:
            raise self.snapshot_error

    def attach(self, hub, loop):
        """Restarting the gateway ends the process that is running the update; the fake does the same to the hub's
        tasks a moment after the restart is asked for (unless a test says the gateway refused)."""
        self.hub, self.loop = hub, loop

    def _gateway_goes_down(self):
        for task in list(self.hub._tasks):
            task.cancel()

    def cancel_update(self, prepared):
        self.calls.append(("cancel",))
        if self.cancel_error:
            raise self.cancel_error
        return {"done": ["the Winglet plugin files"]}

    def settle_pending_update(self, current_version):
        self.calls.append(("settle", current_version))
        return self.settled

    def latest_release(self, force=False):
        self.release_calls.append(force)
        if isinstance(self.release, Exception):
            raise self.release
        return self.release

    def read_log(self, name, lines=300, level="", query=""):
        if name not in ("agent", "gateway", "errors"):
            raise Refused("unknown log")
        rows = ["2026 INFO started", "2026 ERROR boom", "2026 INFO done"]
        if level == "ERROR":
            rows = [r for r in rows if "ERROR" in r]
        return {"lines": [r for r in rows if query.lower() in r.lower()], "size": 100}

    def list_schedule(self):
        return list(self.routines.values())

    def parse_schedule(self, text):
        if text == "whenever":
            raise Refused("I couldn't read that schedule.")
        return {"display": text, "kind": "cron", "next_run_at": "2026-10-07T09:00:00+00:00"}

    def create_routine(self, name, prompt, schedule):
        routine = {"id": f"r{len(self.routines) + 1}", "name": name, "prompt": prompt, "schedule_display": schedule,
                   "state": "scheduled", "enabled": True}
        self.routines[routine["id"]] = routine
        return routine

    def change_routine(self, routine_id, action, updates=None):
        routine = self.routines.get(routine_id)
        if routine is None:
            return {"deleted": False} if action == "delete" else None
        if action == "delete":
            del self.routines[routine_id]
            return {"deleted": True}
        if action == "update":
            routine.update({("schedule_display" if k == "schedule" else k): v for k, v in updates.items()})
        else:
            routine["state"] = {"pause": "paused", "resume": "scheduled", "run": "scheduled"}[action]
        return dict(routine)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path, monkeypatch):
    monkeypatch.setattr(hub_module, "RESTART_DELAY_SECONDS", 0)
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = FakeHermes()
    h.hermes_version = lambda: "0.9"
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    hub.hermes.attach(hub, asyncio.get_running_loop())
    return await aiohttp_client(hub.build_app())


async def settle(hub):
    for _ in range(20):
        await asyncio.sleep(0)
    if hub._tasks:
        await asyncio.wait(list(hub._tasks), timeout=2)


# -- health and pause ------------------------------------------------------------------------


async def test_system_shows_versions_health_and_pause_to_owners_only(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    data = await (await client.get("/api/system", headers=owner.auth)).json()
    assert data["hermes_version"] == "0.9" and data["host"]["cpu_count"] == 4
    assert data["paused"] is None and data["can_pause"] is True and data["devices"] == 2
    assert (await client.get("/api/system", headers=member.auth)).status == 403
    for path in ("/api/logs", "/api/schedule", "/api/jobs", "/api/system/updates"):
        assert (await client.get(path, headers=member.auth)).status == 403, path


async def test_pause_needs_a_signature_and_is_audited(client, hub):
    owner = await pair_phone(client, hub)
    assert (await client.post("/api/system/pause", json={"paused": True}, headers=owner.auth)).status == 403
    resp = await post_signed(client, owner, "/api/system/pause", {"paused": True, "reason": "travelling"})
    assert resp.status == 200
    assert (await resp.json())["paused"]["reason"] == "travelling"
    assert hub.hermes.pause is not None
    resp = await post_signed(client, owner, "/api/system/pause", {"paused": False})
    assert (await resp.json())["paused"] is None
    actions = [(a["action"], a["summary"]) for a in hub.store.list_audit()]
    assert ("system.pause", "resumed new work") in actions
    assert ("system.pause", "paused new work: travelling") in actions


# -- restart and update jobs -------------------------------------------------------------------


async def test_restart_is_a_job_a_retry_does_not_repeat(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/system/restart", {"idempotency_key": "k1"})
    assert resp.status == 202
    job = (await resp.json())["job"]
    assert job["kind"] == "restart" and job["state"] == "running"
    # The same tap retried (a flaky network) returns the same job and doesn't restart twice.
    again = await post_signed(client, owner, "/api/system/restart", {"idempotency_key": "k1"})
    assert (await again.json())["job"]["id"] == job["id"]
    await settle(hub)
    assert hub.hermes.restarts == 1
    assert hub.store.get_job(job["id"])["detail"]["pid"] == 4242
    # Something already running blocks a different request.
    hub.hermes_version = lambda: "0.23.0"
    busy = await post_signed(client, owner, "/api/system/update", {"target": "winglet", "version": "0.10.9", "idempotency_key": "k2"})
    assert busy.status == 409 and "already in progress" in (await busy.json())["error"]
    assert not any(call[0] in ("begin", "install") for call in hub.hermes.calls)


async def test_a_restart_finishes_when_the_next_process_starts(store, tmp_path):
    first = Hub(store, web_root=tmp_path / "web")
    first.hermes = FakeHermes()
    job, _ = store.create_job("restart", detail={"boot": first.boot_id})
    second = Hub(store, web_root=tmp_path / "web")
    second.hermes = FakeHermes()
    await second.reconcile_jobs()
    done = store.get_job(job["id"])
    assert done["state"] == "succeeded" and done["detail"]["message"] == "Back online."


async def test_hermes_update_reports_its_own_outcome(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.update_status = {"running": False, "exit_code": 0, "lines": ["Updated to 1.0"]}
    resp = await post_signed(client, owner, "/api/system/update", {"target": "hermes", "idempotency_key": "u1"})
    job = (await resp.json())["job"]
    assert job["kind"] == "hermes_update" and job["detail"]["from"] == "0.9"
    await asyncio.sleep(3.2)
    await settle(hub)
    done = hub.store.get_job(job["id"])
    assert done["state"] == "succeeded" and done["detail"]["action_id"] == "a1"
    assert any(a["action"] == "system.update" for a in hub.store.list_audit())


async def test_hermes_update_refused_by_the_install_says_how_to_update(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.update_started = {"ok": False, "message": "Docker installs update by pulling the image.",
                                 "update_command": "docker pull hermes"}
    resp = await post_signed(client, owner, "/api/system/update", {"target": "hermes", "idempotency_key": "u2"})
    job = (await resp.json())["job"]
    await settle(hub)
    done = hub.store.get_job(job["id"])
    assert done["state"] == "failed" and "Docker" in done["detail"]["message"]
    assert done["detail"]["command"] == "docker pull hermes"


async def test_hermes_update_finished_after_the_restart_it_caused(store, tmp_path):
    old = Hub(store, web_root=tmp_path / "web")
    job, _ = store.create_job("hermes_update", detail={"boot": old.boot_id, "from": "0.9", "action_id": "a1"})
    new = Hub(store, web_root=tmp_path / "web")
    new.hermes = FakeHermes()
    new.hermes_version = lambda: "1.0"
    new.hermes.update_status = {"running": False, "exit_code": 0, "action_id": "a1", "lines": ["done"]}
    await new.reconcile_jobs()
    done = store.get_job(job["id"])
    assert done["state"] == "succeeded" and done["detail"]["to"] == "1.0"


async def test_hermes_update_with_no_evidence_is_unknown_not_success(store, tmp_path):
    old = Hub(store, web_root=tmp_path / "web")
    job, _ = store.create_job("hermes_update", detail={"boot": old.boot_id, "from": "0.9", "action_id": "a1"})
    new = Hub(store, web_root=tmp_path / "web")
    new.hermes = FakeHermes()
    new.hermes_version = lambda: "0.9"
    new.hermes.update_status = {"running": False, "exit_code": None, "lines": []}
    await new.reconcile_jobs()
    assert store.get_job(job["id"])["state"] == "unknown"


async def test_job_events_reach_owners_only(hub):
    owner_event = hub._event_visible({"role": "owner", "id": "o"}, {"type": "system.job", "job": {}})
    member_event = hub._event_visible({"role": "member", "id": "m"}, {"type": "system.job", "job": {}})
    assert owner_event and not member_event


def test_stale_running_jobs_expire(store, tmp_path):
    h = Hub(store, web_root=tmp_path / "web")
    job, _ = store.create_job("restart", detail={"boot": h.boot_id})
    h.expire_jobs(now=time.time() + hub_module.UPDATE_TIMEOUT_SECONDS + 120)
    assert store.get_job(job["id"])["state"] == "unknown"


def test_jobs_table_keeps_the_newest(store):
    for i in range(60):
        store.create_job("restart", idem_key=f"k{i}")
    assert len(store.list_jobs(limit=100)) == 50


async def test_update_check_is_cached(client, hub):
    owner = await pair_phone(client, hub)
    calls = []
    original = hub.hermes.check_hermes_update

    async def counting(force=False):
        calls.append(force)
        return await original(force)

    hub.hermes.check_hermes_update = counting
    first = await (await client.get("/api/system/updates", headers=owner.auth)).json()
    await client.get("/api/system/updates", headers=owner.auth)
    assert first["hermes"]["behind"] == 3 and first["winglet"]["version"] == hub_module.VERSION
    assert calls == [False]
    await client.get("/api/system/updates?force=1", headers=owner.auth)
    assert calls == [False, True]


# -- logs ------------------------------------------------------------------------------------


async def test_logs_filter_by_level_and_text(client, hub):
    owner = await pair_phone(client, hub)
    data = await (await client.get("/api/logs?file=agent&level=error", headers=owner.auth)).json()
    assert data["lines"] == ["2026 ERROR boom"]
    data = await (await client.get("/api/logs?file=agent&q=done", headers=owner.auth)).json()
    assert data["lines"] == ["2026 INFO done"]
    assert (await client.get("/api/logs?file=../../etc/passwd", headers=owner.auth)).status == 400


# -- schedule --------------------------------------------------------------------------------


async def test_routines_create_edit_pause_run_delete(client, hub):
    owner = await pair_phone(client, hub)
    preview = await client.post("/api/schedule/parse", json={"schedule": "every day at 9am"}, headers=owner.auth)
    assert (await preview.json())["next_run_at"].startswith("2026-10-07")
    bad = await client.post("/api/schedule/parse", json={"schedule": "whenever"}, headers=owner.auth)
    assert bad.status == 400 and "couldn't read" in (await bad.json())["error"]

    assert (await client.post("/api/schedule", json={"prompt": "x", "schedule": "1h"}, headers=owner.auth)).status == 403
    resp = await post_signed(client, owner, "/api/schedule", {"name": "Morning brief", "prompt": "Summarise my inbox",
                                                              "schedule": "every day at 9am"})
    routine = (await resp.json())["routine"]
    assert routine["name"] == "Morning brief"
    missing = await post_signed(client, owner, "/api/schedule", {"name": "x", "prompt": "", "schedule": "1h"})
    assert missing.status == 400

    path = f"/api/schedule/{routine['id']}"
    body = json.dumps({"schedule": "every weekday at 8am"}).encode()
    resp = await client.patch(path, data=body, headers=owner.signed("PATCH", path, body))
    assert (await resp.json())["routine"]["schedule_display"] == "every weekday at 8am"

    resp = await post_signed(client, owner, f"{path}/pause", {})
    assert (await resp.json())["routine"]["state"] == "paused"
    resp = await post_signed(client, owner, f"{path}/run", {})
    assert resp.status == 200
    assert (await post_signed(client, owner, f"{path}/explode", {})).status == 404

    listed = await (await client.get("/api/schedule", headers=owner.auth)).json()
    assert [r["id"] for r in listed["routines"]] == [routine["id"]]
    assert (await client.delete(path, headers=owner.signed("DELETE", path))).status == 200
    assert (await client.delete(path, headers=owner.signed("DELETE", path))).status == 404
    actions = {a["action"] for a in hub.store.list_audit()}
    assert {"routine.create", "routine.edit", "routine.pause", "routine.run", "routine.delete"} <= actions


async def test_member_cannot_touch_the_schedule(client, hub):
    await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    resp = await post_signed(client, member, "/api/schedule", {"name": "x", "prompt": "y", "schedule": "1h"})
    assert resp.status == 403
    assert not hub.hermes.routines


async def test_everyone_hears_about_a_pause_but_only_owners_see_why(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    hub.hermes.set_paused(True, "maintenance window")
    hello = {}
    for phone in (owner, member):
        ws = await client.ws_connect("/api/ws")
        await ws.send_json({"type": "auth", "token": phone.token})
        hello[phone.name] = await ws.receive_json()
        await ws.close()
    assert hello["Pixel"]["paused"]["reason"] == "maintenance window"
    assert hello["Alex"]["paused"] == {"reason": None, "engaged_at": "2026-10-06T10:00:00+00:00"}
    assert hub._event_visible({"role": "member", "id": "m"}, {"type": "system.paused", "paused": None})
