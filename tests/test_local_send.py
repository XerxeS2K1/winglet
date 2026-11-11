"""A script on this machine posts one bot message into an existing chat (plugin/local_send.py)."""
import asyncio
import json
import os
import stat
import sys
import types

import pytest

from plugin import local_send
from plugin.hub import ROUTE_POLICY, Hub
from plugin.store import Store

TOKEN = "t" * 43


@pytest.fixture
async def env(tmp_path, aiohttp_client):
    store = Store(tmp_path / "data.db")
    store.ensure_chat("general", "General")
    store.ensure_chat("gone", "Gone")
    store.delete_chat("gone")
    hub = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    hub.local_send_token = TOKEN
    hub.pushes = []
    hub.schedule_push = lambda chat, message, final: hub.pushes.append((chat, message, final))
    client = await aiohttp_client(hub.build_app())
    yield types.SimpleNamespace(store=store, hub=hub, client=client)
    store.close()


async def send(env, body, token=TOKEN, headers=None):
    h = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return await env.client.post(local_send.PATH, json=body, headers={**h, **(headers or {})})


def texts(env, chat="general"):
    return [m["text"] for m in env.store.list_messages(chat)]


def test_the_route_has_an_explicit_policy():
    assert ROUTE_POLICY["h_local_send"] == "public"      # it does its own loopback + token check


async def test_a_post_lands_in_the_chat_as_a_live_bot_message_and_notifies(env):
    before = env.hub.events.head(None)
    r = await send(env, {"chat_id": "general", "text": "coder settled: Menu fix"})
    assert r.status == 200
    body = await r.json()
    message = env.store.get_message(body["message_id"])
    assert (message["role"], message["status"], message["text"]) == ("bot", "final", "coder settled: Menu fix")
    assert env.hub.events.head(None) > before            # journaled and sent to open phones like any bot message
    assert env.hub.pushes == [("general", body["message_id"], True)]


async def test_the_row_says_a_script_posted_it(env):
    await send(env, {"chat_id": "general", "text": "from a script"})
    row = env.store.list_messages("general")[-1]
    assert row["role"] == "bot" and row["meta"]["origin"] == "local-send"


async def test_notify_false_posts_quietly(env):
    r = await send(env, {"chat_id": "general", "text": "quiet", "notify": False})
    assert r.status == 200
    assert env.hub.pushes == []
    assert env.store.list_messages("general")[-1]["meta"]["notify"] is False


async def test_the_route_is_a_404_while_switched_off(env):
    env.hub.local_send_token = None
    r = await send(env, {"chat_id": "general", "text": "x"})
    assert r.status == 404 and texts(env) == []


@pytest.mark.parametrize("token", [None, "", "wrong", TOKEN + "x"])
async def test_no_token_or_a_wrong_one_is_refused(env, token):
    r = await send(env, {"chat_id": "general", "text": "x"}, token=token)
    assert r.status == 403 and texts(env) == []


@pytest.mark.parametrize("header", ["X-Forwarded-For", "CF-Connecting-IP", "Forwarded", "X-Real-IP", "Via", "X-Forwarded-Proto",
                                    "True-Client-IP", "X-Client-IP", "X-Cluster-Client-IP", "CF-Visitor", "x-forwarded-port"])
async def test_traffic_that_came_through_a_tunnel_is_refused_even_with_the_token(env, header):
    r = await send(env, {"chat_id": "general", "text": "x"}, headers={header: "203.0.113.9"})
    assert r.status == 403 and texts(env) == []


async def test_a_request_with_the_quick_tunnel_host_header_is_refused_even_with_the_token(env, monkeypatch):
    monkeypatch.setattr(env.hub, "connection", {"mode": "quick"})
    monkeypatch.setattr(env.hub, "tunnel_host", "tunnel-123.example.invalid")
    r = await send(env, {"chat_id": "general", "text": "x"}, headers={"Host": env.hub.tunnel_host})
    assert r.status == 403 and texts(env) == []


def test_proxied_looks_at_names_not_values_and_ignores_ordinary_headers():
    assert local_send.proxied({"via": ""}) and local_send.proxied({"X-Forwarded-Anything": "1"})
    assert not local_send.proxied({"Host": "127.0.0.1:8787", "Authorization": "Bearer x", "Content-Type": "application/json",
                                   "User-Agent": "python-urllib", "Accept-Encoding": "identity"})


def test_only_loopback_addresses_pass():
    ok = lambda remote: local_send.request_problem(remote, {}, TOKEN, TOKEN)
    assert ok("127.0.0.1") is None and ok("::1") is None
    assert ok("192.168.1.5") == "not local" and ok("8.8.8.8") == "not local" and ok(None) == "not local"


def test_ipv6_mapped_loopback_is_local():
    ok = lambda remote: local_send.request_problem(remote, {}, TOKEN, TOKEN)
    assert ok("::ffff:127.0.0.1") is None
    assert ok("::1") is None
    # Unwrapping the mapped form must not let a mapped outside address through.
    assert ok("::ffff:8.8.8.8") == "not local" and ok("::ffff:192.168.1.5") == "not local"


async def test_a_chat_that_does_not_exist_is_not_created(env):
    r = await send(env, {"chat_id": "c-0123456789ab", "text": "x"})
    assert r.status == 404
    assert env.store.get_chat("c-0123456789ab") is None
    assert not env.store.chat_deleted("c-0123456789ab")


async def test_a_deleted_chat_is_not_recreated(env):
    assert env.store.chat_deleted("gone")
    r = await send(env, {"chat_id": "gone", "text": "x"})
    assert r.status == 404
    assert env.store.get_chat("gone") is None and env.store.chat_deleted("gone")


async def test_control_and_direction_characters_are_stripped(env):
    r = await send(env, {"chat_id": "general", "text": "ok\x00\x1b[31m red\u202e gone\u200b\r\nline 2\ttab"})
    assert r.status == 200
    assert texts(env) == ["ok[31m red gone\nline 2\ttab"]


@pytest.mark.parametrize("text", ["", "   \n", "\x00\x1b", None, 5, ["a"]])
async def test_empty_or_non_string_text_is_refused(env, text):
    r = await send(env, {"chat_id": "general", "text": text})
    assert r.status == 400 and texts(env) == []


async def test_the_length_cap_refuses_rather_than_cuts(env):
    assert (await send(env, {"chat_id": "general", "text": "a" * local_send.MAX_TEXT})).status == 200
    r = await send(env, {"chat_id": "general", "text": "a" * (local_send.MAX_TEXT + 1)})
    assert r.status == 413 and len(texts(env)) == 1


@pytest.mark.parametrize("body", [{"text": "x"}, {"chat_id": "", "text": "x"}, {"chat_id": 3, "text": "x"},
                                  {"chat_id": "general", "text": "x", "notify": "yes"}])
async def test_a_malformed_request_is_a_400(env, body):
    assert (await send(env, body)).status == 400 and texts(env) == []


async def test_the_token_never_reaches_the_log(env, caplog):
    caplog.set_level("DEBUG")
    await send(env, {"chat_id": "general", "text": "secret text body"})
    await send(env, {"chat_id": "general", "text": "x"}, token="wrong-token-value")
    assert TOKEN not in caplog.text and "wrong-token-value" not in caplog.text and "secret text body" not in caplog.text


# -- the token file ------------------------------------------------------------------------------------------------

def test_publish_writes_a_private_file_and_withdraw_removes_it(tmp_path):
    token = local_send.publish(tmp_path, "127.0.0.1", 8787)
    path = tmp_path / local_send.FILE_NAME
    if sys.platform != "win32":    # Windows has no POSIX modes: every file reads 0o666 there
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert json.loads(path.read_text()) == {"url": "http://127.0.0.1:8787", "token": token}
    assert local_send.publish(tmp_path, "127.0.0.1", 8787) != token   # a new token every start
    local_send.withdraw(tmp_path)
    assert not path.exists()
    local_send.withdraw(tmp_path)                        # already gone: fine


def test_publish_never_writes_through_a_planted_temp_file_or_symlink(tmp_path, monkeypatch):
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    monkeypatch.setattr(local_send.secrets, "token_hex", lambda n=6: "fixed")
    plant = tmp_path / f"{local_send.FILE_NAME}.{os.getpid()}.fixed.tmp"
    try:
        plant.symlink_to(victim)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable here")
    with pytest.raises(FileExistsError):                  # O_EXCL: an existing name is never reused
        local_send.publish(tmp_path, "127.0.0.1", 8787)
    assert victim.read_text() == "keep me"


def test_a_failed_publish_leaves_no_temp_file_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(local_send.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        local_send.publish(tmp_path, "127.0.0.1", 8787)
    assert list(tmp_path.iterdir()) == []


def test_publish_uses_an_ipv6_url_when_the_hub_listens_on_loopback_ipv6(tmp_path):
    token = local_send.publish(tmp_path, "::1", 8788)
    assert json.loads((tmp_path / local_send.FILE_NAME).read_text())["url"] == "http://[::1]:8788"


def test_publish_falls_back_to_ipv4_loopback_when_the_hub_listens_on_all_addresses(tmp_path):
    for host in ("0.0.0.0", "::"):
        local_send.publish(tmp_path, host, 8789)
        assert json.loads((tmp_path / local_send.FILE_NAME).read_text())["url"] == "http://127.0.0.1:8789"


@pytest.mark.parametrize("extra,want", [
    ({}, False),
    ({"local_send": True}, True),
    ({"local_send": False}, False),
])
def test_it_is_off_unless_asked_for(extra, want, monkeypatch):
    monkeypatch.setenv("WINGLET_LOCAL_SEND", "")
    assert local_send.enabled(extra) is want


def test_enabled_takes_only_the_extra():
    import inspect
    assert list(inspect.signature(local_send.enabled).parameters) == ["extra"]


def test_the_env_beats_the_yaml_extra_for_local_send(monkeypatch):
    monkeypatch.setenv("WINGLET_LOCAL_SEND", "false")
    assert local_send.enabled({"local_send": True}) is False
    monkeypatch.setenv("WINGLET_LOCAL_SEND", "true")
    assert local_send.enabled({"local_send": False}) is True


# -- the sender Hermes calls for `hermes send --to winglet:<chat>` -------------------------------------------------

@pytest.fixture
def sender(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(local_send, "_data_dir", lambda cfg: tmp_path)
    monkeypatch.setattr(local_send, "_post", lambda url, token, payload: calls.append((url, token, payload)) or {"message_id": "m1"})
    return types.SimpleNamespace(calls=calls, dir=tmp_path, run=lambda chat, text, **kw: asyncio.run(
        local_send.standalone_sender(None, chat, text, **kw)))


def test_sender_posts_with_the_token_from_the_file(sender):
    token = local_send.publish(sender.dir, "127.0.0.1", 9001)
    assert sender.run("general", "hello\x00 there") == {"success": True, "message_id": "m1"}
    assert sender.calls == [("http://127.0.0.1:9001", token, {"chat_id": "general", "text": "hello there", "notify": True})]


def test_sender_notify_can_be_switched_off(sender, monkeypatch):
    local_send.publish(sender.dir, "127.0.0.1", 9001)
    monkeypatch.setenv(local_send.NOTIFY_ENV, "false")
    sender.run("general", "hello")
    assert sender.calls[0][2]["notify"] is False


def test_sender_can_be_pointed_at_the_token_file_of_another_profile(sender, tmp_path, monkeypatch):
    other = tmp_path / "other"
    other.mkdir()
    token = local_send.publish(other, "127.0.0.1", 9002)
    monkeypatch.setenv(local_send.FILE_ENV, str(other / local_send.FILE_NAME))
    assert sender.run("general", "hi")["success"]
    assert sender.calls[0][:2] == ("http://127.0.0.1:9002", token)


def test_sender_says_so_when_local_send_is_off(sender):
    answer = sender.run("general", "hello")
    assert "WINGLET_LOCAL_SEND" in answer["error"] and sender.calls == []


@pytest.mark.parametrize("chat,text,kw", [("general", "", {}), ("", "hi", {}), ("general", "a" * 16_001, {}),
                                          ("general", "hi", {"media_files": ["/etc/passwd"]})])
def test_sender_refuses_before_touching_the_network(sender, chat, text, kw):
    local_send.publish(sender.dir, "127.0.0.1", 9001)
    assert "error" in sender.run(chat, text, **kw) and sender.calls == []


def test_sender_reports_an_unreachable_gateway_without_the_token(tmp_path, monkeypatch):
    token = local_send.publish(tmp_path, "127.0.0.1", 1)          # port 1: nothing listens
    monkeypatch.setattr(local_send, "_data_dir", lambda cfg: tmp_path)
    answer = asyncio.run(local_send.standalone_sender(None, "general", "hi"))
    assert "isn't reachable" in answer["error"] and token not in answer["error"]


async def test_sender_explains_a_stale_token_file(env, tmp_path, monkeypatch):
    """A gateway killed hard leaves its token file; the next run should be told what to do, not just 'Not allowed'."""
    local_send.publish(tmp_path, "127.0.0.1", env.client.port)        # a token the hub does not hold
    monkeypatch.setattr(local_send, "_data_dir", lambda cfg: tmp_path)
    answer = await local_send.standalone_sender(None, "general", "hi")
    assert "restart" in answer["error"] and "token file" in answer["error"] and texts(env) == []


async def test_sender_end_to_end_against_a_running_hub(env, tmp_path, monkeypatch):
    """The real urllib sender, talking to the real route on a real loopback socket."""
    local_send.publish(tmp_path, "127.0.0.1", env.client.port)
    env.hub.local_send_token = json.loads((tmp_path / local_send.FILE_NAME).read_text())["token"]
    monkeypatch.setattr(local_send, "_data_dir", lambda cfg: tmp_path)
    ok = await local_send.standalone_sender(None, "general", "coder settled: x")
    assert ok["success"] and texts(env) == ["coder settled: x"]
    missing = await local_send.standalone_sender(None, "c-aaaaaaaa", "x")
    assert "No such chat" in missing["error"] and env.store.get_chat("c-aaaaaaaa") is None


# -- the adapter wiring --------------------------------------------------------------------------------------------
# The adapter module needs Hermes's gateway package; reuse the interface doubles the other adapter tests build.
from test_adapter_approvals import adapter  # noqa: E402,F401  (a pytest fixture)


def module_of(instance):
    return type(instance)._publish_local_send.__globals__


def ctx(register_platform):
    return types.SimpleNamespace(register_platform=register_platform, register_cli_command=lambda **kw: None,
                                 register_hook=lambda *a, **k: None, register_tool=lambda *a, **k: None)


def test_the_platform_is_registered_with_the_standalone_sender(adapter):
    seen = {}
    module_of(adapter)["register"](ctx(lambda **kw: seen.update(kw)))
    assert seen["standalone_sender_fn"] is module_of(adapter)["local_send"].standalone_sender


def test_a_hermes_that_does_not_know_the_sender_still_registers_the_platform(adapter):
    seen = {}

    def older(**kw):
        if "standalone_sender_fn" in kw:
            raise TypeError("unexpected keyword argument 'standalone_sender_fn'")
        seen.update(kw)
    module_of(adapter)["register"](ctx(older))
    assert seen["name"] == "winglet" and "standalone_sender_fn" not in seen and "parse_target_ref_fn" in seen


@pytest.fixture
def wired(adapter, tmp_path, monkeypatch):
    monkeypatch.setitem(module_of(adapter), "data_dir", lambda: tmp_path)
    adapter._host, adapter._port, adapter._local_send = "0.0.0.0", 8787, False
    return types.SimpleNamespace(adapter=adapter, hub=types.SimpleNamespace(local_send_token="stale"), dir=tmp_path)


def test_by_default_no_token_is_made_and_a_stale_file_is_removed(wired):
    (wired.dir / local_send.FILE_NAME).write_text("{}")
    wired.adapter._publish_local_send(wired.hub)
    assert wired.hub.local_send_token is None and not (wired.dir / local_send.FILE_NAME).exists()


def test_when_switched_on_the_hub_and_the_file_share_one_token(wired):
    wired.adapter._local_send = True
    wired.adapter._publish_local_send(wired.hub)
    info = json.loads((wired.dir / local_send.FILE_NAME).read_text())
    assert info["token"] == wired.hub.local_send_token and info["url"] == "http://127.0.0.1:8787"


def test_a_host_the_loopback_cannot_reach_keeps_it_off(wired):
    wired.adapter._local_send, wired.adapter._host = True, "192.168.1.5"
    wired.adapter._publish_local_send(wired.hub)
    assert wired.hub.local_send_token is None and not (wired.dir / local_send.FILE_NAME).exists()


async def test_malformed_posts_do_not_use_up_the_rate_cap(env, monkeypatch):
    monkeypatch.setattr(local_send, "_rate_times", local_send.collections.deque())
    for _ in range(40):
        assert (await send(env, {"chat_id": "general", "text": ""})).status == 400
        assert (await send(env, {"chat_id": "general", "text": "x", "notify": "yes"})).status == 400
        assert (await send(env, {"chat_id": 7, "text": "x"})).status == 400
    assert len(local_send._rate_times) == 0
    assert (await send(env, {"chat_id": "general", "text": "still allowed"})).status == 200


async def test_a_per_process_rate_limit_blocks_excess_posts(env, monkeypatch):
    monkeypatch.setattr(local_send, "_rate_times", local_send.collections.deque())
    for i in range(30):
        r = await send(env, {"chat_id": "general", "text": f"x{i}"})
        assert r.status == 200, i
    r = await send(env, {"chat_id": "general", "text": "one too many"})
    assert r.status == 429 and texts(env) == [f"x{i}" for i in range(30)]
