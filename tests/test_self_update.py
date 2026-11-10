"""The server updates itself: gates, marker, watchdog and rollback.

The app is deliberately absent here.  These tests exercise the plugin-side
contract in docs/design/self-updating-server.md.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest
import sys

# The self-updater installs systemd units, reads /proc for a pid's start time and locks with
# fcntl: none of that exists on Windows, so the feature is off there and these tests skip.
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the self-updater is POSIX-only")

from plugin import hermes_api as api
from plugin import rollback as rollback_module
from plugin import self_update
from plugin import update_rollback
from plugin.hub import VERSION as RUNNING


def _next_patch(version: str) -> str:
    major, minor, patch = (int(part) for part in version.split("."))
    return f"{major}.{minor}.{patch + 1}"


# The hub-level tests need a release newer than whatever is shipped right now, or the
# 'newer' gate refuses and the test proves nothing. Hardcoding it broke on every bump.
NEWER = _next_patch(RUNNING)


def _next_minor(version: str) -> str:
    major, minor, _patch = (int(part) for part in version.split("."))
    return f"{major}.{minor + 1}.0"


NEXT_MINOR = _next_minor(RUNNING)
from plugin import hub as hub_module
from test_control import client, hub, store, settle  # noqa: F401
from test_trust import pair_phone


async def put_signed(client, phone, path, data):
    body = json.dumps(data).encode()
    return await client.put(path, data=body, headers=phone.signed("PUT", path, body))


@pytest.fixture(autouse=True)
def isolated_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    return tmp_path / "hermes"


# -- the gates, in the design's order ------------------------------------------------------------------------------

BASE_GATE = dict(enabled=True, release={"version": NEWER}, current_version=RUNNING,
                  running_hermes="0.23.0", idle=True, asset_ok=True, manifest_ok=True,
                  attempted_release=False, failed_at=None, now=1000.0)


@pytest.mark.parametrize("change,expected", [
    ({"enabled": False}, "autoUpdate"),
    ({"release": {"version": "0.10.11"}}, "newer"),
    ({"release": {"version": "0.10.9"}}, "newer"),
    ({"release": {"version": NEXT_MINOR}}, "major"),
    ({"release": {"version": "1.0.0"}}, "major"),
    ({"idle": False}, "busy"),
    ({"asset_ok": False}, "asset"),
    ({"manifest_ok": False}, "manifest"),
    ({"attempted_release": True}, "attempt"),
    ({"failed_at": 1000.0 - 10}, "retry"),
])
def test_each_gate_refuses(change, expected):
    args = {**BASE_GATE, **change}
    assert self_update.gate_reason(**args) == expected


def test_all_gates_allow_an_update():
    assert self_update.gate_reason(**BASE_GATE) is None


def test_the_retry_gate_expires_after_thirty_minutes():
    args = {**BASE_GATE, "failed_at": 1000.0 - self_update.RETRY_AFTER_FAILURE_SECONDS}
    assert self_update.gate_reason(**args) is None


# -- gate 5 and 6: the published asset and its manifest -------------------------------------------------------------

ZIP_URL = "https://github.com/XerxeS2K1/winglet/releases/download/v0.11.0/winglet-plugin.zip"
RELEASE = {"version": "0.11.0", "tag": "v0.11.0", "sha": "a" * 40}


def plugin_zip(version="0.11.0", requires=">=0.22.7") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("plugin.yaml", f"name: winglet\nversion: {version}\nrequires_hermes: \"{requires}\"\n")
        archive.writestr("plugin/__init__.py", "")
    return buffer.getvalue()


def asset_fetch(data: bytes, *, digest=None, name="winglet-plugin.zip", assets=None):
    digest = digest if digest is not None else "sha256:" + hashlib.sha256(data).hexdigest()
    calls = []

    def fetch(url):
        calls.append(url)
        if url.endswith("/releases/tags/v0.11.0"):
            return {"assets": assets if assets is not None else [{
                "name": name, "browser_download_url": ZIP_URL, "digest": digest}]}
        assert url == ZIP_URL
        return data

    fetch.calls = calls
    return fetch


def test_a_published_digest_and_matching_zip_manifest_pass_the_asset_gate():
    data = plugin_zip()
    found = api.release_plugin_asset(RELEASE, fetch=asset_fetch(data))
    assert found["manifest"]["version"] == "0.11.0"
    assert found["digest"].startswith("sha256:")


def test_a_missing_plugin_asset_is_refused():
    with pytest.raises(api.ReleaseCheckFailed, match="no plugin asset"):
        api.release_plugin_asset(RELEASE, fetch=asset_fetch(b"", assets=[]))


def test_a_download_that_does_not_match_githubs_digest_is_refused():
    data = plugin_zip()
    fake = asset_fetch(data, digest="sha256:" + "0" * 64)
    with pytest.raises(api.ReleaseCheckFailed, match="does not match"):
        api.release_plugin_asset(RELEASE, fetch=fake)


def test_an_asset_without_a_published_sha256_is_refused():
    fake = asset_fetch(plugin_zip(), digest="")
    with pytest.raises(api.ReleaseCheckFailed, match="no published sha256"):
        api.release_plugin_asset(RELEASE, fetch=fake)


def test_a_zip_whose_plugin_yaml_names_another_version_is_refused():
    data = plugin_zip("0.10.9")
    with pytest.raises(api.ReleaseCheckFailed, match="contains Winglet 0.10.9"):
        api.release_plugin_asset(RELEASE, fetch=asset_fetch(data))


def test_an_asset_hosted_outside_the_winglet_repository_is_refused():
    fake = asset_fetch(plugin_zip(), name="winglet-plugin.zip")
    original = fake

    def fetch(url):
        if url.endswith("/releases/tags/v0.11.0"):
            return {"assets": [{"name": "winglet-plugin.zip",
                                "browser_download_url": "https://evil.example/winglet-plugin.zip",
                                "digest": "sha256:" + "0" * 64}]}
        return original(url)

    with pytest.raises(api.ReleaseCheckFailed, match="not hosted"):
        api.release_plugin_asset(RELEASE, fetch=fetch)


def test_a_too_new_hermes_requirement_is_a_gate_not_a_crash():
    assert api.hermes_supports(">=0.24.0", "0.23.0") is False
    assert api.hermes_supports(">=0.22.7", "0.23.0") is True


def test_the_installed_tree_must_match_the_verified_zip(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("winglet/plugin.yaml", "name: winglet\nversion: 0.11.0\nrequires_hermes: \">=0.22.7\"\n")
        archive.writestr("winglet/a.py", "value = 1\n")
    data = buffer.getvalue()
    plugin = tmp_path / "winglet"
    plugin.mkdir()
    (plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.11.0\nrequires_hermes: \">=0.22.7\"\n")
    (plugin / "a.py").write_text("value = 1\n")
    ok, why = self_update.verify_installed_plugin(plugin, data, {"version": "0.11.0", "requires_hermes": ">=0.22.7"})
    assert ok, why
    (plugin / "a.py").write_text("value = 2\n")
    ok, why = self_update.verify_installed_plugin(plugin, data, {"version": "0.11.0"})
    assert not ok and "do not match" in why


def test_the_installed_manifest_is_read_from_the_installed_code(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("plugin.yaml", "name: winglet\nversion: 0.10.9\nrequires_hermes: \">=0.22.7\"\n")
        archive.writestr("a.py", "value = 1\n")
    data = buffer.getvalue()
    plugin = tmp_path / "winglet"
    plugin.mkdir()
    (plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.9\nrequires_hermes: \">=0.22.7\"\n")
    (plugin / "a.py").write_text("value = 1\n")
    ok, why = self_update.verify_installed_plugin(plugin, data, {"version": "0.11.0"})
    assert not ok and "0.10.9" in why


# -- marker lifecycle ----------------------------------------------------------------------------------------------

def test_the_marker_is_written_before_the_swap_and_cleared_only_by_the_new_version(tmp_path):
    marker = self_update.write_marker(from_version="0.10.11", to_version="0.11.0",
                                      backup=tmp_path / "backup", started=123.0, home=tmp_path)
    assert marker == tmp_path / "winglet-update.json"
    assert json.loads(marker.read_text()) == {"from": "0.10.11", "to": "0.11.0",
                                              "backup": str(tmp_path / "backup"), "started": 123.0}
    assert self_update.record_health("0.10.11", home=tmp_path) is False
    assert marker.exists()
    assert self_update.record_health("0.11.0", home=tmp_path) is True
    assert not marker.exists()


def test_a_wrong_version_never_clears_the_marker(tmp_path):
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0",
                             backup=tmp_path / "backup", home=tmp_path)
    assert self_update.record_health("0.12.0", home=tmp_path) is False
    assert self_update.read_marker(tmp_path)["to"] == "0.11.0"


def test_the_marker_is_fsynced_before_and_after_the_rename(tmp_path, monkeypatch):
    calls = []
    real = self_update.os.fsync
    monkeypatch.setattr(self_update.os, "fsync", lambda fd: (calls.append(fd), real(fd))[1])
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0", backup=tmp_path / "b", home=tmp_path)
    assert len(calls) >= 2, "the temp file and its directory must both be durable"


def test_a_malformed_marker_is_reported_not_treated_as_no_marker(tmp_path):
    (tmp_path / "winglet-update.json").write_text("not json")
    with pytest.raises(ValueError, match="not valid JSON"):
        self_update.read_marker(tmp_path)


def test_health_is_stamped_even_when_the_marker_is_unreadable(tmp_path):
    (tmp_path / "winglet-update.json").write_text("not json")
    assert self_update.record_health("0.11.0", home=tmp_path, now=1234.0) is False
    assert self_update.read_health(tmp_path) == {"version": "0.11.0", "ts": 1234.0}


def test_health_is_independent_of_the_marker_being_readable(tmp_path):
    marker = {"from": "0.10.11", "to": "0.11.0", "backup": "/b", "started": 1000.0}
    health = {"version": "0.11.0", "ts": 1001.0}
    assert self_update.watchdog_decision(marker, now=1000.0 + 3600, health=health) == "ok"
    assert self_update.watchdog_decision(marker, now=1000.0 + 3600, health=None) == "rollback"


def test_a_healthy_update_with_an_unreadable_marker_is_not_rolled_back(tmp_path):
    from plugin import update_watchdog
    (tmp_path / "winglet-update.json").write_text("not json")
    self_update.write_health("0.11.0", home=tmp_path, now=time.time())
    assert update_watchdog.main(["--home", str(tmp_path)]) == 0
    assert (tmp_path / "winglet-update.json").exists(), "the unreadable marker is evidence, not a failure"


def test_a_stale_health_stamp_does_not_excuse_an_unreadable_marker(tmp_path):
    from plugin import update_watchdog
    marker = tmp_path / "winglet-update.json"
    marker.write_text("not json")
    old = marker.stat().st_mtime - 60
    self_update.write_health("0.10.11", home=tmp_path, now=old)
    assert update_watchdog.main(["--home", str(tmp_path)]) == 1


def test_the_last_successful_update_time_is_recorded(tmp_path):
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0", backup="/b", started=1000.0, home=tmp_path)
    assert self_update.record_health("0.11.0", home=tmp_path, now=1234.0) is True
    assert self_update.last_success(tmp_path) == {"version": "0.11.0", "updatedAt": 1234.0}


def test_attempts_are_persisted_by_version_and_cleared_only_by_a_newer_release(tmp_path):
    self_update.note_attempt(NEWER, home=tmp_path, now=10.0)
    self_update.note_failure(NEWER, home=tmp_path, now=20.0)
    assert self_update.attempted(NEWER, tmp_path) is True
    assert self_update.failed_at(NEWER, tmp_path) == 20.0
    self_update.prune_attempts(NEWER, tmp_path)
    assert self_update.attempted(NEWER, tmp_path) is True
    self_update.prune_attempts(_next_patch(NEWER), tmp_path)
    assert self_update.attempted(NEWER, tmp_path) is False
    self_update.note_attempt("0.10.13", home=tmp_path)
    self_update.clear_attempts(tmp_path)
    assert self_update.attempted("0.10.13", tmp_path) is False


def test_a_transient_failure_retries_after_the_window_and_pins_after_three(tmp_path):
    now = 1000.0
    self_update.note_attempt(NEWER, home=tmp_path, now=now)
    self_update.note_failure(NEWER, home=tmp_path, now=now)
    assert self_update.permanent_failure(NEWER, tmp_path) is False
    assert self_update.attempt_count(NEWER, tmp_path) == 1
    retry = self_update.gate_reason(**{**BASE_GATE, "failed_at": now,
                                       "now": now + self_update.RETRY_AFTER_FAILURE_SECONDS - 1,
                                       "attempt_count": 1})
    assert retry == "retry"
    allowed = self_update.gate_reason(**{**BASE_GATE, "failed_at": now,
                                         "now": now + self_update.RETRY_AFTER_FAILURE_SECONDS + 1,
                                         "attempt_count": 1})
    assert allowed is None
    pinned = self_update.gate_reason(**{**BASE_GATE, "failed_at": now,
                                        "now": now + self_update.RETRY_AFTER_FAILURE_SECONDS + 1,
                                        "attempt_count": 3})
    assert pinned == "attempt"


def test_two_processes_both_record_their_attempt(tmp_path):
    root = Path(__file__).resolve().parents[1]
    script = ("import time; from plugin import self_update; import sys; "
              "time.sleep(0.3); self_update.note_attempt(sys.argv[1], sys.argv[2])")
    env = {**os.environ, "PYTHONPATH": str(root)}
    first = subprocess.Popen([sys.executable, "-c", script, NEWER, str(tmp_path)],
                             cwd=root, env=env)
    second = subprocess.Popen([sys.executable, "-c", script, "0.10.13", str(tmp_path)],
                              cwd=root, env=env)
    assert first.wait(timeout=30) == 0
    assert second.wait(timeout=30) == 0
    data = self_update.read_attempts(tmp_path)
    assert NEWER in data["attempts"]
    assert "0.10.13" in data["attempts"]
    assert data["attempts"][NEWER]["count"] == 1
    assert data["attempts"]["0.10.13"]["count"] == 1


def test_a_corrupt_attempt_record_is_a_refusal_not_an_empty_record(tmp_path):
    (tmp_path / "winglet-update-attempts.json").write_text("not json")
    with pytest.raises(ValueError, match="cannot be read"):
        self_update.read_attempts(tmp_path)


# -- watchdog decision ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize("marker,now,expected", [
    (None, 1000, "idle"),
    ({"from": "0.10.11", "to": "0.11.0", "backup": "/b", "started": 1000}, 1000 + 60, "wait"),
    ({"from": "0.10.11", "to": "0.11.0", "backup": "/b", "started": 1000},
     1000 + self_update.WATCHDOG_GRACE_SECONDS, "rollback"),
    ({"from": "0.10.11", "to": "0.11.0", "backup": "/b", "started": "yesterday"}, 1000, "broken"),
    ({"from": "0.10.11", "to": "0.11.0", "backup": "", "started": 1000}, 1000, "broken"),
    ({"from": "0.10.11", "to": "0.11.0", "backup": "/b", "started": 1000}, 1000, "ok"),
])
def test_watchdog_decision(marker, now, expected):
    version = "0.11.0" if expected == "ok" else None
    assert self_update.watchdog_decision(marker, now=now, current_version=version) == expected


# -- settings endpoint ----------------------------------------------------------------------------------------------

async def test_auto_update_defaults_on_and_only_the_owner_can_change_it(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await (await client.get("/api/settings", headers=owner.auth)).json()) == {"autoUpdate": True}
    assert (await put_signed(client, member, "/api/settings", {"autoUpdate": False})).status == 403
    resp = await put_signed(client, owner, "/api/settings", {"autoUpdate": False})
    assert resp.status == 200 and (await resp.json()) == {"autoUpdate": False}
    assert (await (await client.get("/api/settings", headers=owner.auth)).json()) == {"autoUpdate": False}
    assert (await (await client.get("/api/system", headers=owner.auth)).json())["autoUpdate"] is False
    system = await (await client.get("/api/system", headers=owner.auth)).json()
    assert "updatedAt" in system and "updateWatchdog" in system
    assert any(a["action"] == "settings.auto_update" and a["summary"] == "off"
               for a in hub.store.list_audit())


async def test_owner_turning_auto_update_off_and_on_clears_attempts(client, hub):
    owner = await pair_phone(client, hub)
    self_update.note_attempt(NEWER, hub.update_home, now=time.time())
    assert (await put_signed(client, owner, "/api/settings", {"autoUpdate": False})).status == 200
    assert self_update.attempted(NEWER, hub.update_home) is True
    assert (await put_signed(client, owner, "/api/settings", {"autoUpdate": True})).status == 200
    assert self_update.attempted(NEWER, hub.update_home) is False


async def test_system_reports_the_last_successful_update_time(client, hub):
    owner = await pair_phone(client, hub)
    self_update.write_marker(from_version="0.10.10", to_version="0.10.11", backup="/b",
                             started=1000.0, home=hub.update_home)
    self_update.record_health("0.10.11", home=hub.update_home, now=1234.0)
    system = await (await client.get("/api/system", headers=owner.auth)).json()
    assert system["updatedAt"] == 1234.0


async def test_auto_update_rejects_a_non_boolean(client, hub):
    owner = await pair_phone(client, hub)
    resp = await put_signed(client, owner, "/api/settings", {"autoUpdate": "yes"})
    assert resp.status == 400


# -- the self-check -------------------------------------------------------------------------------------------------

async def test_self_check_refuses_while_a_chat_is_busy(client, hub):
    owner = await pair_phone(client, hub)  # noqa: F841
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}

    async def busy(_h):
        return False

    hub._is_quiet = busy
    await hub._self_update_once()
    jobs = hub.store.list_jobs()
    assert not [j for j in jobs if j["kind"] == "winglet_update"]
    assert any(a["action"] == "self_update.refused" and "busy" in a["summary"]
               for a in hub.store.list_audit())


async def test_self_check_refuses_while_a_job_is_running(client, hub):
    owner = await pair_phone(client, hub)  # noqa: F841
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}
    hub.store.create_job("restart", detail={"boot": hub.boot_id})
    await hub._self_update_once()
    assert not [j for j in hub.store.list_jobs() if j["kind"] == "winglet_update"]
    assert any("busy" in a["summary"] for a in hub.store.list_audit() if a["action"] == "self_update.refused")


async def test_self_check_starts_the_same_job_the_phone_uses(client, hub, monkeypatch):
    owner = await pair_phone(client, hub)  # noqa: F841
    hub.hermes_version = lambda: "0.23.0"
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}

    async def quiet(_h):
        return True

    started = []

    async def fake_run(job_id, h, release):
        started.append((job_id, release))

    hub._is_quiet = quiet
    monkeypatch.setattr(hub, "_run_winglet_update", fake_run)
    await hub._self_update_once()
    await settle(hub)
    assert len(started) == 1, [(a["action"], a["summary"]) for a in hub.store.list_audit()]
    job = hub.store.get_job(started[0][0])
    assert job["kind"] == "winglet_update" and job["detail"]["actor"] == "self-update"
    assert job["detail"]["to"] == NEWER
    actions = {a["action"] for a in hub.store.list_audit()}
    assert {"self_update.release_found", "self_update.started"} <= actions


async def test_a_recent_attempt_does_not_retry_immediately(client, hub, monkeypatch):
    await pair_phone(client, hub)
    hub.hermes_version = lambda: "0.23.0"
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}

    async def quiet(_h):
        return True

    started = []
    monkeypatch.setattr(hub, "_run_winglet_update", lambda job_id, h, release: started.append(job_id) or _done())
    hub._is_quiet = quiet
    await hub._self_update_once()
    hub.store.update_job(started[0], state="succeeded")
    await hub._self_update_once()
    assert len(started) == 1
    assert any("retry" in a["summary"] for a in hub.store.list_audit()
               if a["action"] == "self_update.refused"), [(a["action"], a["summary"]) for a in hub.store.list_audit()]


async def _done():
    return None


async def test_a_marker_already_present_blocks_a_second_attempt(client, hub, tmp_path):
    await pair_phone(client, hub)
    hub.update_home = tmp_path / "hermes"
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0",
                             backup=tmp_path / "backup", home=hub.update_home)
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}
    await hub._self_update_once()
    assert [j for j in hub.store.list_jobs() if j["kind"] == "winglet_update"] == []
    assert any("marker is already present" in a["summary"] for a in hub.store.list_audit())


def test_pre_swap_failure_is_transient_and_rollback_failure_is_permanent(client, hub, tmp_path):
    hub.update_home = tmp_path / "hermes"
    self_update.write_marker(from_version="0.10.11", to_version=NEWER, backup="/b",
                             home=hub.update_home)
    hub._record_failed_release(kind="transient")
    assert self_update.permanent_failure(NEWER, hub.update_home) is False
    hub._record_failed_release(kind="rollback")
    assert self_update.permanent_failure(NEWER, hub.update_home) is True


async def test_a_transient_failure_retries_once_the_window_passes(client, hub):
    await pair_phone(client, hub)
    hub.hermes_version = lambda: "0.23.0"
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}
    self_update.note_failure(NEWER, hub.update_home,
                             now=time.time() - self_update.RETRY_AFTER_FAILURE_SECONDS - 1,
                             count_as_attempt=True)

    async def quiet(_h):
        return True

    started = []
    hub._is_quiet = quiet
    hub._run_winglet_update = lambda *args: started.append(args) or _done()
    await hub._self_update_once()
    assert len(started) == 1


async def test_three_transient_failures_pin_the_release(client, hub):
    await pair_phone(client, hub)
    hub.hermes_version = lambda: "0.23.0"
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}
    old = time.time() - self_update.RETRY_AFTER_FAILURE_SECONDS - 1
    for _ in range(self_update.RETRY_ATTEMPTS):
        self_update.note_failure(NEWER, hub.update_home, now=old, count_as_attempt=True)

    async def quiet(_h):
        return True

    started = []
    hub._is_quiet = quiet
    hub._run_winglet_update = lambda *args: started.append(args)
    await hub._self_update_once()
    assert started == []
    assert any(a["action"] == "self_update.refused" and "attempt" in a["summary"]
               for a in hub.store.list_audit())


async def test_a_persisted_attempt_blocks_a_fresh_hub_after_a_rollback(client, hub):
    await pair_phone(client, hub)
    hub.hermes_version = lambda: "0.23.0"
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}
    self_update.note_failure(NEWER, hub.update_home, now=time.time() - 10 * 24 * 3600,
                             kind="rollback")

    async def quiet(_h):
        return True

    started = []
    hub._is_quiet = quiet
    hub._run_winglet_update = lambda *args: started.append(args)
    await hub._self_update_once()
    assert started == []
    assert any(a["action"] == "self_update.refused" and "attempt" in a["summary"]
               for a in hub.store.list_audit())


async def test_auto_update_off_refuses_but_still_audits_the_release(client, hub):
    await pair_phone(client, hub)
    self_update.set_auto_update(hub.store, False)
    hub.hermes.release = {**hub.hermes.release, "version": NEWER, "tag": f"v{NEWER}"}
    await hub._self_update_once()
    assert not [j for j in hub.store.list_jobs() if j["kind"] == "winglet_update"]
    assert any(a["action"] == "self_update.release_found" for a in hub.store.list_audit())
    assert any(a["action"] == "self_update.refused" and "autoUpdate" in a["summary"]
               for a in hub.store.list_audit())


# -- systemd watchdog installation ----------------------------------------------------------------------------------

class FakeSystemctl:
    def __init__(self, fail=False, linger=""):
        self.calls = []
        self.fail = fail
        self.linger = linger

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        if self.fail:
            raise OSError("systemd is not running")
        return type("Result", (), {"returncode": 0, "stdout": self.linger, "stderr": ""})()


def test_the_watchdog_unit_and_timer_are_installed_and_removed(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    fake = FakeSystemctl()
    result = self_update.install_watchdog(tmp_path / "hermes", python="/usr/bin/python3", runner=fake)
    assert result["installed"] is True
    unit_dir = tmp_path / "config" / "systemd" / "user"
    assert (unit_dir / self_update.WATCHDOG_SERVICE).is_file()
    timer = (unit_dir / self_update.WATCHDOG_TIMER).read_text()
    assert "OnBootSec=2min" in timer and "OnUnitActiveSec=10min" in timer
    service = (unit_dir / self_update.WATCHDOG_SERVICE).read_text()
    assert "winglet-update-watchdog.py" in service and "/usr/bin/python3" in service
    assert (tmp_path / "hermes" / "scripts" / "update_rollback.py").is_file()
    assert (tmp_path / "hermes" / "scripts" / "self_update.py").is_file()
    assert ["systemctl", "--user", "daemon-reload"] in fake.calls
    assert ["systemctl", "--user", "enable", "--now", self_update.WATCHDOG_TIMER] in fake.calls

    removed = self_update.uninstall_watchdog(tmp_path / "hermes", runner=fake)
    assert removed["uninstalled"] is True
    assert not (unit_dir / self_update.WATCHDOG_SERVICE).exists()


def test_a_changed_watchdog_script_is_refreshed(tmp_path):
    home = tmp_path / "hermes"
    first = self_update.refresh_watchdog_scripts(home)
    assert self_update.WATCHDOG_SCRIPT in first["changed"]
    assert self_update.refresh_watchdog_scripts(home)["changed"] == []
    (home / "scripts" / self_update.WATCHDOG_SCRIPT).write_text("old watchdog")
    assert self_update.WATCHDOG_SCRIPT in self_update.refresh_watchdog_scripts(home)["changed"]


def test_watchdog_reports_linger_off_without_enabling_it(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    fake = FakeSystemctl(linger="Linger=no\n")
    result = self_update.install_watchdog(tmp_path / "hermes", runner=fake)
    assert result["installed"] is True
    assert result["linger"] is False and result["canFire"] is False
    assert not any("enable-linger" in " ".join(call) for call in fake.calls)
    status = self_update.watchdog_status(tmp_path / "hermes", runner=fake)
    assert status["linger"] is False and status["canFire"] is False


def test_systemd_unavailable_is_reported_not_raised(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    result = self_update.install_watchdog(tmp_path / "hermes", runner=FakeSystemctl(fail=True))
    assert result["installed"] is False
    assert "systemd is unavailable" in result["reason"]


# -- rollback against a real fake backup ----------------------------------------------------------------------------

def make_home(tmp_path) -> tuple[Path, Path, Path]:
    home = tmp_path / "hermes"
    plugin = home / "plugins" / "winglet"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.10.11\n")
    (plugin / "old.py").write_text("old = True\n")
    db = home / "plugin-data" / "winglet" / "data.db"
    db.parent.mkdir(parents=True)
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE notes (text TEXT)")
        conn.execute("INSERT INTO notes VALUES ('before')")
        conn.execute("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, "
                     "device_id TEXT NOT NULL DEFAULT '', device_name TEXT NOT NULL DEFAULT '', "
                     "role TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', "
                     "outcome TEXT NOT NULL DEFAULT 'ok')")
    backup = update_rollback.create_backup(plugin_dir=plugin, db_path=db, from_version="0.10.11",
                                            to_version="0.11.0", now=1000.0)
    # The update replaced the plugin and wrote to the database.
    (plugin / "plugin.yaml").write_text("name: winglet\nversion: 0.11.0\n")
    (plugin / "new.py").write_text("new = True\n")
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO notes VALUES ('after')")
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0", backup=backup,
                             started=1000.0, home=home)
    return home, plugin, db


def test_hermes_winglet_rollback_restores_the_backup_and_clears_the_marker(tmp_path):
    home, plugin, db = make_home(tmp_path)
    lines = []
    code = rollback_module.rollback(home, running=lambda: False, start=lambda: True, out=lines.append)
    assert code == 0
    assert "version: 0.10.11" in (plugin / "plugin.yaml").read_text()
    assert (plugin / "old.py").is_file() and not (plugin / "new.py").exists()
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT text FROM notes ORDER BY rowid").fetchall() == [("before",)]
        assert conn.execute("SELECT action, outcome FROM audit WHERE action='self_update.rollback'").fetchall()
    assert not (home / "winglet-update.json").exists()
    assert any("Restored Winglet 0.10.11" in line for line in lines)


def test_the_cli_rollback_command_uses_the_marker_and_fake_backup(tmp_path):
    from plugin import cli
    home, plugin, _db = make_home(tmp_path)
    assert cli.cmd_rollback(argparse.Namespace(home=str(home), no_restart=True)) == 0
    assert "version: 0.10.11" in (plugin / "plugin.yaml").read_text()
    assert not (home / "winglet-update.json").exists()


def test_rollback_never_restores_the_database_under_a_running_gateway(tmp_path):
    home, plugin, _db = make_home(tmp_path)
    lines = []
    code = rollback_module.rollback(home, running=lambda: True, stop=lambda: False,
                                    start=lambda: True, out=lines.append)
    assert code == 2
    assert "version: 0.11.0" in (plugin / "plugin.yaml").read_text()
    assert (home / "winglet-update.json").exists()
    assert any("did not stop" in line for line in lines)


def test_an_unreadable_proc_start_time_is_treated_as_running(tmp_path, monkeypatch):
    home, plugin, _db = make_home(tmp_path)
    (home / "gateway.pid").write_text(json.dumps({
        "kind": "hermes-gateway", "pid": os.getpid(), "start_time": 123,
    }))
    monkeypatch.setattr(rollback_module, "_proc_start_time", lambda _pid: None)
    now = [1000.0]
    monkeypatch.setattr(rollback_module.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(rollback_module.time, "sleep", lambda seconds: now.__setitem__(0, now[0] + seconds))
    lines = []
    code = rollback_module.rollback(home, stop=lambda: False, start=lambda: True, out=lines.append)
    assert code == 2
    assert "version: 0.11.0" in (plugin / "plugin.yaml").read_text()
    assert any("could not be read" in line for line in lines)
    assert any("did not stop" in line for line in lines)


def test_gateway_pid_reads_hermes_json_and_its_start_time(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    pid = os.getpid()
    started = rollback_module._proc_start_time(pid)
    assert started is not None
    (home / "gateway.pid").write_text(json.dumps({"pid": pid, "start_time": started, "kind": "hermes-gateway"}))
    assert rollback_module._gateway_pid(home) == pid


def test_a_recycled_gateway_pid_is_rejected(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    pid = os.getpid()
    started = rollback_module._proc_start_time(pid)
    assert started is not None
    (home / "gateway.pid").write_text(json.dumps({"pid": pid, "start_time": started + 1}))
    assert rollback_module._gateway_pid(home) is None


def test_a_pid_record_for_another_kind_is_rejected(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    pid = os.getpid()
    (home / "gateway.pid").write_text(json.dumps({"pid": pid, "kind": "some-other-daemon"}))
    assert rollback_module._gateway_pid(home) is None


def test_a_plain_integer_pid_file_is_still_accepted(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "gateway.pid").write_text(str(os.getpid()))
    assert rollback_module._gateway_pid(home) == os.getpid()


def test_the_hermes_command_works_without_a_path(monkeypatch):
    import sys
    monkeypatch.delenv("HERMES_BIN", raising=False)
    monkeypatch.setattr(rollback_module.shutil, "which", lambda _name: None)
    assert rollback_module._hermes_command(["gateway", "start"]) == [
        sys.executable, "-m", "hermes_cli.main", "gateway", "start"]


def test_run_hermes_reports_the_real_exit_status(monkeypatch):
    class Result:
        returncode = 7
        stdout = b"gateway refused\n"

    monkeypatch.setattr(rollback_module.subprocess, "run", lambda *a, **k: Result())
    lines = []
    assert rollback_module._run_hermes(["gateway", "stop"], out=lines.append) is False
    assert lines and "exited 7" in lines[0]


def test_a_rollback_records_the_failed_version_outside_the_database(tmp_path):
    home, _plugin, _db = make_home(tmp_path)
    self_update.note_attempt("0.11.0", home, now=1000.0)
    assert rollback_module.rollback(home, running=lambda: False, start=lambda: True, out=lambda _line: None) == 0
    assert self_update.attempted("0.11.0", home) is True
    assert self_update.permanent_failure("0.11.0", home) is True
    assert self_update.failed_at("0.11.0", home) is not None


def test_rollback_with_no_marker_is_a_no_op(tmp_path):
    lines = []
    assert rollback_module.rollback(tmp_path, running=lambda: False, start=lambda: True, out=lines.append) == 0
    assert any("nothing to roll back" in line for line in lines)


def test_rollback_refuses_a_backup_outside_the_winglet_backups_folder(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "manifest.json").write_text("{}")
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0", backup=tmp_path / "elsewhere",
                             home=home)
    lines = []
    assert rollback_module.rollback(home, running=lambda: False, start=lambda: True, out=lines.append) == 1
    assert any("not a Winglet backup" in line for line in lines)


# -- the janitor fallback when systemd is unavailable ---------------------------------------------------------------

def test_the_update_path_refreshes_the_watchdog_scripts():
    import inspect
    source = inspect.getsource(hub_module.Hub._run_winglet_update)
    assert "refresh_watchdog_scripts" in source
    assert "verify_installed_plugin" in source


def test_the_janitor_spawns_the_watchdog_when_systemd_is_unavailable(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir(parents=True)
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0", backup=tmp_path / "backup",
                             started=time.time() - self_update.WATCHDOG_GRACE_SECONDS - 1, home=home)
    hub = hub_module.Hub.__new__(hub_module.Hub)
    hub.update_home = home
    hub._watchdog_spawned = False
    spawned = []
    monkeypatch.setattr(hub_module.self_update, "watchdog_status", lambda _home: {"installed": False})
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda argv, **kw: spawned.append((argv, kw)))
    hub._maybe_spawn_watchdog()
    assert len(spawned) == 1
    assert spawned[0][0][1].endswith("update_watchdog.py")
    assert hub._watchdog_spawned is True
    hub._maybe_spawn_watchdog()
    assert len(spawned) == 1


def test_the_janitor_does_not_race_an_enabled_systemd_timer(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir(parents=True)
    self_update.write_marker(from_version="0.10.11", to_version="0.11.0", backup=tmp_path / "backup",
                             started=time.time() - self_update.WATCHDOG_GRACE_SECONDS - 1, home=home)
    hub = hub_module.Hub.__new__(hub_module.Hub)
    hub.update_home = home
    hub._watchdog_spawned = False
    monkeypatch.setattr(hub_module.self_update, "watchdog_status", lambda _home: {"installed": True, "enabled": True})
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda *a, **k: pytest.fail("should not spawn"))
    hub._maybe_spawn_watchdog()
    assert hub._watchdog_spawned is False
