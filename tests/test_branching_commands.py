"""Regenerating a reply must not run a command the sender could not have typed.

Regenerate re-sends the stored prompt. If that prompt is a command (/yolo, /approvals off) the app only accepts it
on a signed request, and members may only use a short list, so the re-send has to pass the same gates a typed
message does, and has to be refused before the transcript is touched.
"""

from __future__ import annotations

import json

from test_branching import (  # noqa: F401  (fixtures are used by name)
    add_exchange, client, hub, op, regenerate, state, store,
)
from test_trust import pair_phone


async def _latest_bot(hub, chat_id):
    return [m for m in hub.store.all_messages(chat_id) if m["role"] == "bot"][-1]


async def _try(client, hub, phone, chat_id="general"):
    revision = (await (await state(client, phone, chat_id)).json())["revision"]
    bot = await _latest_bot(hub, chat_id)
    response = await regenerate(client, phone, {"op_id": op(), "message_id": bot["id"],
                                                "expected_revision": revision}, chat_id)
    return revision, response


def _untouched(hub, chat_id, before):
    assert [(m["id"], m["text"]) for m in hub.store.all_messages(chat_id)] == before
    assert hub.branching.bridge.rewinds == []
    assert hub.received == []


def _snapshot(hub, chat_id):
    return [(m["id"], m["text"]) for m in hub.store.all_messages(chat_id)]


async def test_a_device_token_alone_cannot_regenerate_a_signed_only_command(client, hub):
    phone = await pair_phone(client, hub)
    for text in ("/yolo", "/approvals off", "/approve", "/YOLO", "/yolo@winglet_bot now"):
        hub.store.ensure_chat("c-" + str(abs(hash(text))), "T")
        chat_id = "c-" + str(abs(hash(text)))
        add_exchange(hub, chat_id, text, "Approvals are off.")
        before = _snapshot(hub, chat_id)
        revision, response = await _try(client, hub, phone, chat_id)
        data = await response.json()
        assert response.status == 409 and data["code"] == "unsupported", (text, data)
        assert "signed" in data["error"], data
        _untouched(hub, chat_id, before)
        assert (await (await state(client, phone, chat_id)).json())["revision"] == revision


async def test_a_signed_only_alias_is_refused_too(client, hub):
    phone = await pair_phone(client, hub)
    hub.command_resolver = lambda name: "approvals" if name == "ap" else name
    add_exchange(hub, "general", "/ap off", "ok")
    before = _snapshot(hub, "general")
    _, response = await _try(client, hub, phone)
    assert response.status == 409
    _untouched(hub, "general", before)


async def test_a_member_cannot_regenerate_an_owner_only_command(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    hub.store.ensure_chat("mine", "Mine", owner_device=member.id)
    for text in ("/model gpt-x", "/reload"):
        hub.store.ensure_chat("m-" + text[1:4], "T", owner_device=member.id)
        add_exchange(hub, "m-" + text[1:4], text, "done")
        before = _snapshot(hub, "m-" + text[1:4])
        _, response = await _try(client, hub, member, "m-" + text[1:4])
        data = await response.json()
        assert response.status == 409 and data["code"] == "unsupported", (text, data)
        assert text.split()[0] in data["error"], data
        _untouched(hub, "m-" + text[1:4], before)


async def test_an_owner_demoted_to_member_cannot_regenerate_an_old_signed_command(client, hub):
    await pair_phone(client, hub, "Owner")  # someone has to stay an owner
    phone = await pair_phone(client, hub, "Alex")
    hub.store.ensure_chat("old", "Old", owner_device=phone.id)
    add_exchange(hub, "old", "/yolo", "ok")
    hub.store.update_device(phone.id, role="member")
    before = _snapshot(hub, "old")
    _, response = await _try(client, hub, phone, "old")
    assert response.status == 409
    _untouched(hub, "old", before)


async def test_regenerating_an_ordinary_prompt_still_replaces_the_newest_reply_for_both_roles(client, hub):
    owner = await pair_phone(client, hub)
    add_exchange(hub, "general", "what is 2+2", "four")
    _, response = await _try(client, hub, owner)
    assert response.status == 200, await response.text()
    assert [t for _, t in _snapshot(hub, "general")] == ["what is 2+2"]
    assert hub.received[-1][1] == "what is 2+2" and len(hub.branching.bridge.rewinds) == 1

    member = await pair_phone(client, hub, "Alex", role="member")
    hub.store.ensure_chat("theirs", "Theirs", owner_device=member.id)
    add_exchange(hub, "theirs", "/status", "all fine")  # a command members are allowed
    add_exchange(hub, "theirs", "hello", "hi")
    _, response = await _try(client, hub, member, "theirs")
    assert response.status == 200, await response.text()
    assert [t for _, t in _snapshot(hub, "theirs")] == ["/status", "all fine", "hello"]
    assert hub.received[-1][1] == "hello"


async def test_an_owner_may_still_regenerate_a_command_that_needs_no_signature(client, hub):
    owner = await pair_phone(client, hub)
    add_exchange(hub, "general", "/status", "all fine")
    _, response = await _try(client, hub, owner)
    assert response.status == 200, await response.text()
    assert hub.received[-1][1] == "/status"


async def test_a_signed_request_cannot_regenerate_it_either_and_never_without_a_signature(client, hub):
    """The route takes no signature, so the safe rule is one answer: a signed-only prompt is never re-sent here.
    Anyone who wants it again sends it again from the app, where the signature is checked."""
    phone = await pair_phone(client, hub)
    add_exchange(hub, "general", "/yolo", "Approvals are off.")
    before = _snapshot(hub, "general")
    revision = (await (await state(client, phone)).json())["revision"]
    bot = await _latest_bot(hub, "general")
    path = "/api/branching/chats/general/regenerate"
    body = json.dumps({"op_id": op(), "message_id": bot["id"], "expected_revision": revision}).encode()
    response = await client.post(path, data=body, headers=phone.signed("POST", path, body))
    assert response.status == 409
    _untouched(hub, "general", before)
