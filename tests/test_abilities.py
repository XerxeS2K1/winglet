"""Abilities: skills, toolsets, members' tools and MCP servers."""

import asyncio
import json

import pytest

from plugin import hermes_api
from plugin import hub as hub_module
from plugin.hub import Hub
from plugin.store import Store
from test_control import Refused, Unavailable, settle
from test_trust import pair_phone, post_signed, seal

CATALOG = [{"name": "deepwiki", "description": "Ask about a repo", "transport": "http", "auth_type": "none",
            "required_env": [], "command": None, "args": [], "url": "https://mcp.deepwiki.com/mcp",
            "install_url": None, "needs_install": False, "post_install": "", "installed": False, "enabled": False},
           {"name": "notes", "description": "Notes", "transport": "stdio", "auth_type": "api_key",
            "required_env": [{"name": "NOTES_TOKEN", "prompt": "Token", "required": True}], "command": "npx",
            "args": ["notes-mcp"], "url": None, "install_url": None, "needs_install": False, "post_install": "",
            "installed": False, "enabled": False},
           {"name": "builder", "description": "Built from git", "transport": "stdio", "auth_type": "none",
            "required_env": [], "command": "node", "args": ["dist/index.js"], "url": None,
            "install_url": "https://example.com/builder.git", "needs_install": True, "post_install": "",
            "installed": False, "enabled": False}]


class FakeHermes:
    """The abilities functions plugin/hermes_api.py offers, with Hermes's behaviour faked."""
    HermesRefused = Refused
    HermesUnavailable = Unavailable
    NO_TOOLS = hermes_api.NO_TOOLS

    def __init__(self):
        self.skills = [{"name": "arxiv", "description": "Papers", "category": "research", "enabled": True,
                        "provenance": "bundled", "usage": 3},
                       {"name": "weather", "description": "Forecasts", "category": "general", "enabled": True,
                        "provenance": "hub", "usage": 0}]
        self.catalog = [{"name": "stocks", "description": "Quotes", "identifier": "official/finance/stocks",
                         "category": "finance", "tags": [], "installed": False}]
        self.toolset_rows = [{"name": n, "label": n.title(), "description": "", "enabled": True, "configured": True}
                             for n in ("web", "terminal", "file", "todo")]
        self.mode = "manual"
        self.actions = {}
        self.finished = 0
        self.servers = []
        self.installed = []
        self.member_calls = []
        self.sign_ins = []
        self.callbacks = []

    async def list_skills(self):
        return [dict(s) for s in self.skills]

    async def skill_catalog(self):
        return [dict(s) for s in self.catalog]

    async def skill_content(self, name):
        if name not in {s["name"] for s in self.skills}:
            raise Refused(f"Skill '{name}' not found.")
        return {"name": name, "content": f"# {name}", "truncated": False}

    async def set_skill_enabled(self, name, enabled):
        skill = next((s for s in self.skills if s["name"] == name), None)
        if skill is None:
            raise Refused(f"There's no skill called {name}.")
        skill["enabled"] = enabled

    async def start_skill_install(self, identifier):
        self.actions["skills-install-stocks"] = {"running": False, "exit_code": 0, "lines": ["Installed stocks"]}
        return "skills-install-stocks"

    async def start_skill_uninstall(self, name):
        self.actions["skills-uninstall"] = {"running": False, "exit_code": 1, "lines": ["permission denied"]}
        return "skills-uninstall"

    async def action_status(self, action):
        return dict(self.actions[action])

    def finish_skill_action(self):
        self.finished += 1

    def toolsets(self):
        return [dict(t) for t in self.toolset_rows]

    def set_toolset(self, name, enabled):
        row = next((t for t in self.toolset_rows if t["name"] == name), None)
        if row is None:
            raise Refused(f"There's no toolset called {name}.")
        row["enabled"] = enabled

    def approval_mode(self):
        return self.mode

    def set_approval_mode(self, mode):
        if mode not in hermes_api.APPROVAL_MODES:
            raise Refused("mode must be manual, smart or off")
        self.mode = mode

    def member_toolsets(self, allowed, mcp):
        self.member_calls.append((list(allowed), mcp))
        return sorted(allowed) + ([] if mcp else ["no_mcp"])

    async def mcp_servers(self):
        return list(self.servers)

    async def mcp_catalog(self):
        return {"entries": [dict(e) for e in CATALOG], "diagnostics": []}

    async def install_mcp(self, name, env):
        self.installed.append((name, dict(env)))
        if name == "builder":
            self.actions["mcp-install-builder"] = {"running": False, "exit_code": 0, "lines": ["built"]}
            return "mcp-install-builder"
        return None

    async def set_mcp_enabled(self, name, enabled):
        if name != "deepwiki":
            raise Refused(f"Server '{name}' not found")

    async def remove_mcp(self, name):
        if name != "deepwiki":
            raise Refused(f"Server '{name}' not found")

    async def test_mcp(self, name):
        return {"ok": True, "error": None, "tools": [{"name": "ask_question", "description": "Ask"}]}

    async def start_mcp_sign_in(self, name, callback_url):
        self.sign_ins.append((name, callback_url))
        return {"id": "f1", "server": name, "status": "authorization_required",
                "authorization_url": "https://auth.example/authorize?state=s1", "error": None, "tools": []}

    def mcp_sign_in(self, flow_id):
        return {"id": flow_id, "server": "linear", "status": "approved", "authorization_url": None, "error": None,
                "tools": ["list_issues"]} if flow_id == "f1" else None

    def cancel_mcp_sign_in(self, flow_id):
        pass

    def finish_mcp_sign_in(self, server, *, code, state, error, iss):
        self.callbacks.append((server, code, state, error))
        return "ok" if state == "s1" else "expired"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path, monkeypatch):
    monkeypatch.setattr(hub_module, "ACTION_POLL_SECONDS", 0)
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = FakeHermes()
    h.limits_members = True
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def send_signed(client, phone, method, path, data=None):
    body = json.dumps(data).encode() if data is not None else b""
    return await client.request(method, path, data=body or None, headers=phone.signed(method, path, body))


def audit(hub):
    return [(a["action"], a["summary"]) for a in hub.store.list_audit()]


# -- skills ---------------------------------------------------------------------------------------


async def test_owners_see_and_switch_skills_members_cannot(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    skills = (await (await client.get("/api/skills", headers=owner.auth)).json())["skills"]
    assert [s["name"] for s in skills] == ["arxiv", "weather"]
    assert (await client.get("/api/skills", headers=member.auth)).status == 403
    content = await (await client.get("/api/skills/arxiv/content", headers=owner.auth)).json()
    assert content["content"] == "# arxiv"

    # Switching a skill is a signed owner action; a plain token isn't enough.
    assert (await client.put("/api/skills/arxiv", json={"enabled": False}, headers=owner.auth)).status == 403
    assert (await send_signed(client, owner, "PUT", "/api/skills/arxiv", {"enabled": False})).status == 200
    assert hub.hermes.skills[0]["enabled"] is False
    assert ("skill.toggle", "arxiv turned off") in audit(hub)
    missing = await send_signed(client, owner, "PUT", "/api/skills/nope", {"enabled": True})
    assert missing.status == 400 and "nope" in (await missing.json())["error"]
    assert (await send_signed(client, owner, "PUT", "/api/skills/..%2Fetc", {"enabled": True})).status == 404


async def test_installing_an_official_skill_is_a_job(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/skills/install",
                             {"identifier": "official/finance/stocks", "idempotency_key": "s1"})
    assert resp.status == 202
    job = (await resp.json())["job"]
    assert job["kind"] == "skill_install" and job["detail"]["skill"] == "stocks"
    await settle(hub)
    done = hub.store.get_job(job["id"])
    assert done["state"] == "succeeded" and done["detail"]["action"] == "skills-install-stocks"
    assert done["detail"]["lines"] == []
    assert hub.hermes.finished == 1
    assert ("skill.install", "installed official/finance/stocks") in audit(hub)

    other = await post_signed(client, owner, "/api/skills/install", {"identifier": "github/someone/skill"})
    assert other.status == 400


async def test_only_hub_skills_can_be_removed_and_failures_show_output(client, hub):
    owner = await pair_phone(client, hub)
    path = "/api/skills/arxiv"
    bundled = await client.delete(path, headers=owner.signed("DELETE", path))
    assert bundled.status == 400 and "Turn it off" in (await bundled.json())["error"]
    path = "/api/skills/weather"
    resp = await client.delete(path, headers=owner.signed("DELETE", path))
    assert resp.status == 202
    await settle(hub)
    done = hub.store.get_job((await resp.json())["job"]["id"])
    assert done["state"] == "failed" and done["detail"]["lines"] == ["permission denied"]
    assert hub.hermes.finished == 0


# -- toolsets, approvals and members' tools -------------------------------------------------------


async def test_toolsets_and_approvals(client, hub):
    owner = await pair_phone(client, hub)
    data = await (await client.get("/api/toolsets", headers=owner.auth)).json()
    assert [t["name"] for t in data["toolsets"]] == ["web", "terminal", "file", "todo"]
    assert data["approvals"] == "manual"
    assert data["members"] == {"limited": False, "mcp": False, "toolsets": list(hub_module.MEMBER_TOOLSETS),
                               "can_limit": True}

    assert (await send_signed(client, owner, "PUT", "/api/toolsets/terminal", {"enabled": False})).status == 200
    assert hub.hermes.toolset_rows[1]["enabled"] is False
    assert (await send_signed(client, owner, "PUT", "/api/toolsets/nope", {"enabled": True})).status == 400

    assert (await send_signed(client, owner, "PUT", "/api/approvals", {"mode": "off"})).status == 200
    assert hub.hermes.mode == "off" and ("approvals.mode", "approvals set to off") in audit(hub)
    assert (await send_signed(client, owner, "PUT", "/api/approvals", {"mode": "yolo"})).status == 400


async def test_members_get_the_same_tools_until_an_owner_limits_them(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert hub.member_toolsets(owner.id) is None
    assert hub.member_toolsets(member.id) is None

    resp = await send_signed(client, owner, "PUT", "/api/members/tools",
                             {"limited": True, "toolsets": ["web", "todo", "not-a-toolset"], "mcp": False})
    assert (await resp.json())["members"] == {"limited": True, "mcp": False, "toolsets": ["todo", "web"]}
    assert hub.member_toolsets(member.id) == ["todo", "web", "no_mcp"]
    assert hub.member_toolsets(owner.id) is None
    # A device that has since been unpaired gets nothing.
    assert hub.member_toolsets("gone") == ["no_mcp"]
    assert ("members.tools", "limited members to todo, web") in audit(hub)

    bad = await send_signed(client, owner, "PUT", "/api/members/tools", {"limited": True, "toolsets": "web"})
    assert bad.status == 400
    assert (await send_signed(client, member, "PUT", "/api/members/tools",
                              {"limited": False, "toolsets": []})).status == 403


async def test_limits_need_a_hermes_that_can_enforce_them(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    hub.limits_members = False
    assert (await (await client.get("/api/toolsets", headers=owner.auth)).json())["members"]["can_limit"] is False
    resp = await send_signed(client, owner, "PUT", "/api/members/tools", {"limited": True, "toolsets": ["web"]})
    assert resp.status == 400 and "Update Hermes" in (await resp.json())["error"]
    assert (await send_signed(client, owner, "PUT", "/api/members/tools", {"limited": False, "toolsets": []})).status == 200

    # Limits set while Hermes could enforce them, then lost (an update): members' messages are held.
    hub.store.set_kv("member_tools", '{"limited": true, "toolsets": ["web"]}')
    sent = []

    async def on_message(*args, **kwargs):
        sent.append(args)
    hub.on_user_message = on_message
    chat = hub.store.ensure_chat("m-" + member.id, "Alex", owner_device=member.id)
    hub.store.ensure_chat("general", "General")
    held = await client.post(f"/api/chats/{chat['id']}/messages", json={"text": "hi"}, headers=member.auth)
    assert held.status == 400 and "wasn't sent" in (await held.json())["error"]
    assert (await client.post("/api/chats/general/messages", json={"text": "hi"}, headers=owner.auth)).status == 200
    await settle(hub)
    assert len(sent) == 1


class Adapter:
    """A profile's Winglet adapter: its own devices and limits."""
    def __init__(self, limits):
        self.limits = limits

    def toolset_limit(self, source):
        if source.user == "broken":
            raise RuntimeError("config unreadable")
        return self.limits[source.user]


class Runner:
    """Hermes's resolver widening an override (default-on plugin toolsets, x_search), and its routing of
    each source to its own profile's adapter."""
    def __init__(self):
        self.adapters = {"default": Adapter({"owner": None, "member": {"web"}, "nobody": set(), "broken": None}),
                         "work": Adapter({"owner": None, "member": {"todo"}})}

    def _delivery_adapter_for(self, source):
        return self.adapters.get(source.profile)

    def _resolve_enabled_toolsets_for_source(self, user_config, source, platform_key):
        return sorted({*user_config["override"], "shell_plugin", "x_search"} - {"no_mcp"})


def turn(user, profile="default", platform="winglet"):
    from types import SimpleNamespace
    return SimpleNamespace(user=user, profile=profile, platform=SimpleNamespace(value=platform))


def test_turns_are_capped_by_their_own_profiles_adapter():
    runner = Runner()
    assert hermes_api.limit_turn_toolsets(runner, "winglet")
    resolve = runner._resolve_enabled_toolsets_for_source
    everything = ["shell_plugin", "todo", "web", "x_search"]
    assert resolve({"override": ["web", "no_mcp"]}, turn("member"), "winglet") == ["web"]
    assert resolve({"override": ["no_mcp"]}, turn("nobody"), "winglet") == []
    assert resolve({"override": ["web"]}, turn("broken"), "winglet") == []
    assert resolve({"override": ["web", "todo"]}, turn("owner"), "winglet") == everything
    # A second profile is answered by its own adapter, owners included.
    assert resolve({"override": ["web", "todo"]}, turn("owner", "work"), "winglet") == everything
    assert resolve({"override": ["web", "todo"]}, turn("member", "work"), "winglet") == ["todo"]
    # A profile with no adapter right now gets nothing; other platforms aren't touched.
    assert resolve({"override": ["web"]}, turn("owner", "gone"), "winglet") == []
    assert resolve({"override": ["web"]}, turn("anyone", "gone", "telegram"), "telegram") == ["shell_plugin", "web", "x_search"]
    # A reconnect replaces the adapter; the next turn asks the new one.
    runner.adapters["work"] = Adapter({"owner": None, "member": set()})
    assert resolve({"override": ["todo"]}, turn("member", "work"), "winglet") == []
    assert hermes_api.limit_turn_toolsets(runner, "winglet") and runner._resolve_enabled_toolsets_for_source is resolve
    assert hermes_api.limit_turn_toolsets(object(), "winglet") is False


# -- MCP servers ----------------------------------------------------------------------------------


async def test_custom_mcp_route_requires_owner_and_sealed_secrets(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    calls = []

    async def save(name, config, secrets, edit):
        calls.append((name, config, secrets, edit))
    hub.hermes.save_custom_mcp = save
    body = {"name": "mine", "transport": "stdio", "command": "node", "args": ["server.js", "--flag"]}
    assert (await post_signed(client, member, "/api/mcp/custom", body)).status == 403
    assert (await client.post("/api/mcp/custom", json=body, headers=owner.auth)).status == 403
    info = await (await client.get("/api/server-key")).json()
    body["sealed"] = seal(info, "mcp-env", {"env": {"TOKEN": "secret-value"}}, owner.id)
    response = await post_signed(client, owner, "/api/mcp/custom", body)
    assert response.status == 200
    assert calls == [("mine", {"transport": "stdio", "command": "node", "args": ["server.js", "--flag"]}, {"env": {"TOKEN": "secret-value"}}, False)]
    assert "secret-value" not in json.dumps(await response.json())
    assert all("secret-value" not in entry["summary"] for entry in hub.store.list_audit())
    assert hub.mcp_changed
    assert (await send_signed(client, member, "PUT", "/api/mcp/custom/mine", body)).status == 403


async def test_custom_mcp_rejects_plaintext_secrets_and_wrong_seal(client, hub):
    owner = await pair_phone(client, hub)
    info = await (await client.get("/api/server-key")).json()
    base = {"name": "mine", "transport": "http", "url": "https://example.com/mcp", "auth": "header"}
    async def save(*args):
        pass
    hub.hermes.save_custom_mcp = save
    assert (await post_signed(client, owner, "/api/mcp/custom", {**base, "headers": {"Authorization": "private"}})).status == 400
    wrong = seal(info, "provider-key", {"headers": {"Authorization": "private"}}, owner.id)
    assert (await post_signed(client, owner, "/api/mcp/custom", {**base, "sealed": wrong})).status == 400
    sealed = seal(info, "mcp-env", {"headers": {"Authorization": "private"}}, owner.id)
    assert (await post_signed(client, owner, "/api/mcp/custom", {**base, "sealed": sealed})).status == 200
    hub.store._exec("UPDATE devices SET platform = 'web' WHERE id = ?", (owner.id,))
    hub.connection = {"mode": "quick", "url": "https://x.trycloudflare.com"}
    assert (await post_signed(client, owner, "/api/mcp/custom", {**base, "sealed": sealed})).status == 403


@pytest.mark.parametrize("url,allowed", [
    ("https://example.com/mcp", True), ("http://127.0.0.1:8000/mcp", True),
    ("http://192.168.1.2/mcp", True), ("http://10.0.0.2/mcp", True),
    ("http://example.com/mcp", False), ("http://8.8.8.8/mcp", False),
    ("file:///tmp/a", False), ("https://user:password@example.com/", False),
    ("https://example.com/?token=secret", False),
])
async def test_custom_mcp_remote_url_policy(client, hub, url, allowed):
    owner = await pair_phone(client, hub)
    async def save(*args):
        pass
    hub.hermes.save_custom_mcp = save
    response = await post_signed(client, owner, "/api/mcp/custom", {"name": "mine", "transport": "http", "url": url, "auth": "none"})
    assert response.status == (200 if allowed else 400)


async def test_custom_mcp_persists_lists_preserves_secrets_and_refuses_collisions(monkeypatch):
    import contextlib
    import sys
    import types

    configured = {"existing": {"command": "old"}}
    plugin = {"plugin-server": "plugin"}
    mcp = types.ModuleType("hermes_cli.mcp_config")
    mcp._get_mcp_servers = lambda: configured
    mcp._oauth_tokens_present = lambda name: False
    def save(name, config):
        configured[name] = config
        return True
    mcp._save_mcp_server = save
    common = types.ModuleType("hermes_cli.web_routers._common")
    common.config_write_scope = lambda profile: contextlib.nullcontext()
    helpers = types.ModuleType("tui_gateway.mcp_rpc_helpers")
    helpers.server_configs_with_sources = lambda servers: ({**servers, **{n: {} for n in plugin}}, plugin)
    for name, module in [("hermes_cli", types.ModuleType("hermes_cli")), ("hermes_cli.mcp_config", mcp),
                         ("hermes_cli.web_routers", types.ModuleType("hermes_cli.web_routers")),
                         ("hermes_cli.web_routers._common", common), ("tui_gateway", types.ModuleType("tui_gateway")),
                         ("tui_gateway.mcp_rpc_helpers", helpers)]:
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(hermes_api, "_profile_scope", contextlib.nullcontext)
    async def catalog():
        return {"entries": [{"name": "catalog"}]}
    monkeypatch.setattr(hermes_api, "mcp_catalog", catalog)
    config = {"transport": "stdio", "command": "node", "args": ["server.js", "--option=a b"]}
    await hermes_api.save_custom_mcp("mine", config, {"env": {"SECRET": "private"}}, False)
    assert configured["mine"]["command"] == "node"
    assert configured["mine"]["args"] == ["server.js", "--option=a b"]
    assert configured["mine"]["env"] == {"SECRET": "private"}
    await hermes_api.save_custom_mcp("mine", config, {}, True)
    assert configured["mine"]["env"] == {"SECRET": "private"}
    remote = {"transport": "http", "url": "https://example.com/mcp", "auth": "header"}
    await hermes_api.save_custom_mcp("remote", remote, {"headers": {"X-Key": "private"}}, False)
    assert configured["remote"]["strict_redirect_headers"] is True
    await hermes_api.save_custom_mcp("remote", remote, {}, True)
    assert configured["remote"]["strict_redirect_headers"] is True
    with pytest.raises(hermes_api.HermesRefused):
        await hermes_api.save_custom_mcp("remote", {**remote, "url": "https://other.example/mcp"}, {}, True)
    assert configured["remote"]["url"] == "https://example.com/mcp"
    for name in ("catalog", "EXISTING", "plugin-server"):
        with pytest.raises(hermes_api.HermesRefused):
            await hermes_api.save_custom_mcp(name, config, {}, False)
    with pytest.raises(hermes_api.HermesRefused):
        await hermes_api.save_custom_mcp("existing", config, {}, True)
    # A removed server's OAuth tokens stay stored under its name; a new OAuth server must not inherit them.
    signed_in = {"old-oauth"}
    mcp._oauth_tokens_present = lambda name: name in signed_in
    oauth = {"transport": "http", "url": "https://new.example/mcp", "auth": "oauth"}
    with pytest.raises(hermes_api.HermesRefused):
        await hermes_api.save_custom_mcp("old-oauth", oauth, {}, False)
    assert "old-oauth" not in configured
    with pytest.raises(hermes_api.HermesRefused, match="through Hermes"):
        await hermes_api.save_custom_mcp("fresh-oauth", oauth, {}, False)
    assert "fresh-oauth" not in configured
    for auth in ("none", "header"):
        with pytest.raises(hermes_api.HermesRefused, match="earlier server"):
            await hermes_api.save_custom_mcp("old-oauth", {**oauth, "auth": auth}, {}, False)
    configured["legacy-oauth"] = {"winglet_custom": True, "url": remote["url"], "auth": "oauth"}
    with pytest.raises(hermes_api.HermesRefused, match="through Hermes"):
        await hermes_api.save_custom_mcp("legacy-oauth", remote, {}, True)
    monkeypatch.setattr(hermes_api, "_sign_ins", {"pending": types.SimpleNamespace(server_name="pending-name", worker_done=False)})
    with pytest.raises(hermes_api.HermesRefused, match="still running"):
        await hermes_api.save_custom_mcp("pending-name", {**remote, "auth": "none"}, {}, False)
    assert "pending-name" not in configured

    class Router:
        async def list_mcp_servers(self):
            return {"servers": [{"name": "mine", "transport": "stdio", "command": "node", "args": ["private"],
                                 "env": {"SECRET": "private"}, "source": "config"}]}
    monkeypatch.setattr(hermes_api, "_router", lambda name: Router())
    result = await hermes_api.mcp_servers()
    assert result[0]["custom"] is True
    assert "private" not in json.dumps(result)


async def test_custom_oauth_is_refused_before_persistence(client, hub):
    owner = await pair_phone(client, hub)
    async def unexpected(*args):
        pytest.fail("Custom OAuth must not reach Hermes persistence")
    hub.hermes.save_custom_mcp = unexpected
    body = {"name": "custom-oauth", "transport": "http", "url": "https://example.com/mcp", "auth": "oauth"}
    assert (await post_signed(client, owner, "/api/mcp/custom", body)).status == 400
    raw = json.dumps(body).encode()
    path = "/api/mcp/custom/custom-oauth"
    assert (await client.put(path, data=raw, headers=owner.signed("PUT", path, raw))).status == 400


@pytest.mark.parametrize("custom", [True, False])
async def test_custom_sign_in_is_refused_but_existing_oauth_still_starts(monkeypatch, tmp_path, custom):
    import contextlib
    import sys
    import time
    import types

    class Flow:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            self.worker_done = False
            self.created_at = time.time()
            self.tools = []
        async def wait_for_authorization_url(self, timeout):
            pass
        def snapshot(self):
            return {"flow_id": self.flow_id, "server_name": self.server_name, "status": "authorization_required",
                    "authorization_url": "https://auth.example/authorize", "error": None}

    modules = {
        "hermes_cli.mcp_config": {"_get_mcp_servers": lambda: {"example": {
            "url": "https://example.com/mcp", "auth": "oauth", "winglet_custom": custom}}},
        "hermes_cli.web_server_mcp": {"_run_dashboard_mcp_oauth": lambda *args: None},
        "hermes_constants": {"get_hermes_home": lambda: tmp_path},
        "tools.mcp_dashboard_oauth": {"DashboardOAuthFlow": Flow, "exception_message": str},
        "tui_gateway.mcp_rpc_helpers": {"server_configs_with_sources": lambda servers: (servers, {})},
    }
    for name, attributes in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attributes)
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(hermes_api, "_profile_scope", contextlib.nullcontext)
    monkeypatch.setattr(hermes_api, "_sign_ins", {})
    if custom:
        with pytest.raises(hermes_api.HermesRefused, match="through Hermes"):
            await hermes_api.start_mcp_sign_in("example", "https://winglet.example/callback")
        assert hermes_api._sign_ins == {}
    else:
        flow = await hermes_api.start_mcp_sign_in("example", "https://winglet.example/callback")
        assert flow["status"] == "authorization_required"
        assert len(hermes_api._sign_ins) == 1


async def test_adding_a_catalog_server_with_its_keys_sealed(client, hub):
    owner = await pair_phone(client, hub)
    info = await (await client.get("/api/server-key")).json()
    data = await (await client.get("/api/mcp", headers=owner.auth)).json()
    assert data == {"servers": [], "needs_reload": False, "can_reload": False}

    needs_key = await post_signed(client, owner, "/api/mcp", {"name": "notes"})
    assert needs_key.status == 400 and "NOTES_TOKEN" in (await needs_key.json())["error"]
    sealed = seal(info, "mcp-env", {"env": {"NOTES_TOKEN": " tok-123 "}}, owner.id)
    assert (await post_signed(client, owner, "/api/mcp", {"name": "notes", "sealed": sealed})).status == 200
    assert hub.hermes.installed == [("notes", {"NOTES_TOKEN": "tok-123"})]
    assert ("mcp.add", "added notes with NOTES_TOKEN") in audit(hub)
    assert all("tok-123" not in a["summary"] for a in hub.store.list_audit())
    assert (await (await client.get("/api/mcp", headers=owner.auth)).json())["needs_reload"] is True

    # Sealed for another purpose, it won't open.
    wrong = seal(info, "provider-key", {"env": {"NOTES_TOKEN": "x"}}, owner.id)
    assert (await post_signed(client, owner, "/api/mcp", {"name": "notes", "sealed": wrong})).status == 400
    assert (await post_signed(client, owner, "/api/mcp", {"name": "not-in-catalog"})).status == 404


async def test_the_web_app_over_the_quick_tunnel_cant_send_keys(client, hub):
    owner = await pair_phone(client, hub)
    hub.store._exec("UPDATE devices SET platform = 'web' WHERE id = ?", (owner.id,))
    hub.connection = {"mode": "quick", "url": "https://x.trycloudflare.com"}
    info = await (await client.get("/api/server-key")).json()
    sealed = seal(info, "mcp-env", {"env": {"NOTES_TOKEN": "tok"}}, owner.id)
    assert (await post_signed(client, owner, "/api/mcp", {"name": "notes", "sealed": sealed})).status == 403
    # A server that needs no keys is fine.
    assert (await post_signed(client, owner, "/api/mcp", {"name": "deepwiki"})).status == 200


async def test_servers_that_build_first_install_as_a_job(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/mcp", {"name": "builder", "idempotency_key": "b1"})
    assert resp.status == 202
    await settle(hub)
    done = hub.store.get_job((await resp.json())["job"]["id"])
    assert done["kind"] == "mcp_install" and done["state"] == "succeeded"
    assert hub.mcp_changed is True


async def test_switching_removing_testing_and_reloading_servers(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await send_signed(client, owner, "PUT", "/api/mcp/deepwiki", {"enabled": False})).status == 200
    assert hub.mcp_changed is True
    assert (await send_signed(client, owner, "PUT", "/api/mcp/other", {"enabled": False})).status == 400
    tested = await (await post_signed(client, owner, "/api/mcp/deepwiki/test", {})).json()
    assert tested["ok"] and tested["tools"][0]["name"] == "ask_question"
    assert (await post_signed(client, member, "/api/mcp/deepwiki/test", {})).status == 403

    assert (await post_signed(client, owner, "/api/mcp/reload", {})).status == 404  # no gateway to reload

    async def reload():
        return "MCP servers reloaded"
    hub.reload_mcp = reload
    resp = await post_signed(client, owner, "/api/mcp/reload", {})
    assert (await resp.json())["message"] == "MCP servers reloaded" and hub.mcp_changed is False

    path = "/api/mcp/deepwiki"
    assert (await client.delete(path, headers=owner.signed("DELETE", path))).status == 200
    assert ("mcp.remove", "removed deepwiki") in audit(hub)


async def test_signing_in_comes_back_to_winglet(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/mcp/linear/sign-in", {"callback_base": "https://x.example/"})
    flow = (await resp.json())["sign_in"]
    assert flow["authorization_url"].startswith("https://auth.example/")
    assert hub.hermes.sign_ins == [("linear", "https://x.example/api/mcp/oauth/linear")]
    bad = await post_signed(client, owner, "/api/mcp/linear/sign-in", {"callback_base": "javascript:alert(1)"})
    assert bad.status == 400

    # The browser comes back without any token: only the state it was given matters.
    page = await client.get("/api/mcp/oauth/linear?code=c1&state=s1")
    assert page.status == 200 and "Signed in" in await page.text()
    assert "default-src 'none'" in page.headers["Content-Security-Policy"]
    stale = await client.get("/api/mcp/oauth/linear?code=c1&state=other")
    assert stale.status == 404
    status = await (await client.get("/api/mcp/sign-in/f1", headers=owner.auth)).json()
    assert status["sign_in"]["status"] == "approved"
    assert (await client.get("/api/mcp/sign-in/zz", headers=owner.auth)).status == 404


def test_abilities_are_a_feature_only_with_hermes(store):
    hub = Hub(store)
    assert hub.features()["abilities"] is False
    hub.hermes = FakeHermes()
    assert hub.features()["abilities"] is True


# -- hermes_api ----------------------------------------------------------------------------------


class HTTPError(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


async def test_dashboard_errors_become_refusals():
    async def not_found():
        raise HTTPError(404, "Skill 'x' not found.")

    async def broken():
        raise KeyError("boom")

    with pytest.raises(hermes_api.HermesRefused, match="Skill 'x' not found."):
        await hermes_api._route(not_found)
    with pytest.raises(KeyError):
        await hermes_api._route(broken)


class FakeFlow:
    def __init__(self, server, state, status="authorization_required"):
        self.server_name, self.expected_state, self.status = server, state, status
        self.delivered = None

    def deliver_callback(self, *, code, state, error, iss):
        if self.delivered is not None:
            raise ValueError("OAuth callback already received")
        self.delivered = (code, state, error, iss)


def test_a_sign_in_only_accepts_its_own_state(monkeypatch):
    flow = FakeFlow("linear", "s1")
    monkeypatch.setattr(hermes_api, "_sign_ins", {"f1": flow, "f2": FakeFlow("notion", "s2")})
    assert hermes_api.finish_mcp_sign_in("linear", code="c", state="s2", error=None, iss=None) == "expired"
    assert hermes_api.finish_mcp_sign_in("linear", code="c", state=None, error=None, iss=None) == "expired"
    assert hermes_api.finish_mcp_sign_in("linear", code="c", state="s1", error=None, iss="i") == "ok"
    assert flow.delivered == ("c", "s1", None, "i")
    assert hermes_api.finish_mcp_sign_in("linear", code="c", state="s1", error=None, iss=None) == "rejected"
    denied = FakeFlow("notion", "s3")
    hermes_api._sign_ins["f3"] = denied
    assert hermes_api.finish_mcp_sign_in("notion", code=None, state="s3", error="access_denied", iss=None) == "denied"


def test_the_default_model_switch_uses_hermes_config_mutation_lock(monkeypatch):
    import contextlib
    import sys
    import types

    events = []

    class Lock:
        def __enter__(self):
            events.append("lock")

        def __exit__(self, *_exc):
            events.append("unlock")

    config = types.ModuleType("hermes_cli.config")
    config.load_config = lambda: events.append("load") or {}
    web_config = types.ModuleType("hermes_cli.web_server_config")
    web_config._prepare_main_assignment = lambda *_args: events.append("prepare") or ("", object())

    def apply(*_args, **_kwargs):
        assert events[-1] == "lock", "the config write must be inside Hermes's mutation lock"
        events.append("apply")
        return {"provider": "openai", "model": "gpt-test"}

    web_config._apply_model_assignment_sync = apply
    common = types.ModuleType("hermes_cli.web_routers._common")
    common._CONFIG_MUTATION_LOCK = Lock()
    for name, module in [("hermes_cli", types.ModuleType("hermes_cli")), ("hermes_cli.config", config),
                         ("hermes_cli.web_server_config", web_config),
                         ("hermes_cli.web_routers", types.ModuleType("hermes_cli.web_routers")),
                         ("hermes_cli.web_routers._common", common)]:
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(hermes_api, "_profile_scope", contextlib.nullcontext)

    result = hermes_api.set_default_model("openai", "gpt-test", confirm=True)
    assert result == {"ok": True, "provider": "openai", "model": "gpt-test"}
    assert events == ["load", "prepare", "lock", "apply", "unlock"]
