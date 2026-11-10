"""Opt-in approvals from the notification shade: device switch, tokens, channels."""

import json
import time

from cryptography.hazmat.primitives.asymmetric import ec

from plugin import webpush
from plugin.hub import SHADE_TOKEN_TTL

from test_hub import client, hub, store  # noqa: F401  (pytest fixtures)
from test_trust import pair_phone, post_signed


def _path(item):
    return f"/api/inbox/{item['id']}/respond"


async def _set_toggle(client, phone, enabled):
    path = "/api/push/shade"
    body = json.dumps({"enabled": enabled}).encode()
    return await client.put(path, data=body, headers=phone.signed("PUT", path, body))


def _mint(hub, device, item, choice="once", ttl=SHADE_TOKEN_TTL):
    sig = hub.action_signature(item["id"], choice, device["shade_epoch"])
    hub.store.issue_shade_token(device["id"], item["id"], choice, sig, time.time() + ttl)
    return sig


async def _approval(hub, choices=("once", "deny")):
    return await hub.add_inbox("approval", "general", "Approval needed", "ls -la",
                               {"command": "ls -la", "description": "List the files",
                                "choices": list(choices), "session_key": "k"}, push=False)


async def test_shade_signature_is_accepted_once_then_replay_is_refused(client, hub):
    async def allow(item, choice):
        return True

    hub.on_approval = allow
    owner = await pair_phone(client, hub)
    assert (await _set_toggle(client, owner, True)).status == 200
    item = await _approval(hub)
    device = hub.store.get_device(owner.id)
    sig = _mint(hub, device, item)

    first = await client.post(_path(item), json={"choice": "once", "sig": sig})
    assert first.status == 200
    answered = (await first.json())["item"]
    assert answered["resolution"] == "once"
    assert answered["channel"] == "shade"

    replay = await client.post(_path(item), json={"choice": "once", "sig": sig})
    assert replay.status == 401


async def test_an_expired_shade_token_is_refused(client, hub):
    owner = await pair_phone(client, hub)
    item = await _approval(hub)
    device = hub.store.get_device(owner.id)
    sig = _mint(hub, device, item, ttl=-1)

    response = await client.post(_path(item), json={"choice": "once", "sig": sig})
    assert response.status == 401
    assert hub.store.get_inbox(item["id"])["status"] == "pending"


async def test_a_deny_signature_cannot_approve(client, hub):
    owner = await pair_phone(client, hub)
    item = await _approval(hub)
    deny = hub.action_signature(item["id"], "deny")

    response = await client.post(_path(item), json={"choice": "once", "sig": deny})
    assert response.status == 401
    assert hub.store.get_inbox(item["id"])["status"] == "pending"


async def test_always_is_refused_even_with_a_valid_token(client, hub):
    owner = await pair_phone(client, hub)
    item = await _approval(hub)
    device = hub.store.get_device(owner.id)
    sig = _mint(hub, device, item, choice="always")

    response = await client.post(_path(item), json={"choice": "always", "sig": sig})
    assert response.status == 400
    assert hub.store.get_inbox(item["id"])["status"] == "pending"


async def test_turning_the_toggle_off_refuses_a_still_valid_token(client, hub):
    owner = await pair_phone(client, hub)
    assert (await _set_toggle(client, owner, True)).status == 200
    item = await _approval(hub)
    device = hub.store.get_device(owner.id)
    sig = _mint(hub, device, item)

    assert (await _set_toggle(client, owner, False)).status == 200
    response = await client.post(_path(item), json={"choice": "once", "sig": sig})
    assert response.status == 403
    assert hub.store.get_inbox(item["id"])["status"] == "pending"


async def test_an_epoch_bump_invalidates_older_tokens(client, hub):
    owner = await pair_phone(client, hub)
    assert (await _set_toggle(client, owner, True)).status == 200
    item = await _approval(hub)
    device = hub.store.get_device(owner.id)
    sig = _mint(hub, device, item)

    # Any change bumps the counter; turning it off and on again is enough.
    assert (await _set_toggle(client, owner, False)).status == 200
    assert (await _set_toggle(client, owner, True)).status == 200
    response = await client.post(_path(item), json={"choice": "once", "sig": sig})
    assert response.status == 403


async def test_a_member_cannot_enable_shade_approvals(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    response = await _set_toggle(client, member, True)
    assert response.status == 403
    assert hub.store.get_device(member.id)["shade_approvals"] is False


async def test_an_unverified_owner_is_asked_to_verify_first(client, hub):
    legacy = await pair_phone(client, hub, "Unverified", sealed=False)
    path = "/api/push/shade"
    response = await client.put(path, json={"enabled": True}, headers=legacy.auth)
    assert response.status == 403
    assert (await response.json())["needs"] == "verify"
    assert hub.store.get_device(legacy.id)["shade_approvals"] is False


async def test_card_and_shade_answers_record_their_channel(client, hub):
    async def on_approval(item, choice):
        return True

    hub.on_approval = on_approval
    owner = await pair_phone(client, hub)
    card = await _approval(hub)
    response = await post_signed(client, owner, _path(card), {"choice": "once"})
    assert response.status == 200
    assert (await response.json())["item"]["channel"] == "card"

    assert (await _set_toggle(client, owner, True)).status == 200
    shade = await _approval(hub)
    device = hub.store.get_device(owner.id)
    sig = _mint(hub, device, shade)
    response = await client.post(_path(shade), json={"choice": "once", "sig": sig})
    assert response.status == 200
    assert (await response.json())["item"]["channel"] == "shade"


async def test_an_approval_push_carries_choices_and_the_full_command(client, hub):
    owner = await pair_phone(client, hub)
    ua_key = ec.generate_private_key(ec.SECP256R1())
    subscription = {"endpoint": "https://fcm.googleapis.com/abc",
                    "keys": {"p256dh": webpush.b64url_encode(webpush._public_bytes(ua_key.public_key())),
                             "auth": webpush.b64url_encode(b"0123456789abcdef")}}
    assert (await client.post("/api/push/webpush", json={"subscription": subscription},
                              headers=owner.auth)).status == 200
    assert (await _set_toggle(client, owner, True)).status == 200
    async def allow(item, choice):
        return True

    hub.on_approval = allow

    command = ("grep -R 'a-very-long-marker' /srv/projects | head -n 200 "
               + "a" * 240)
    description = "Search every project for the marker. This description must stay on screen too."
    item = await _add_command(hub, command, description, ["once", "deny"])
    url, kwargs = hub._http.posts[-1]
    assert url == subscription["endpoint"]
    note = json.loads(webpush.decrypt(kwargs["content"], ua_key, subscription["keys"]["auth"]))
    assert note["body"] == command + "\n\n" + description
    assert note["choices"] == ["once", "deny"]
    assert set(note["sig"]) == {"once", "deny"}

    response = await client.post(_path(item), json={"choice": "once", "sig": note["sig"]["once"]})
    assert response.status == 200
    assert (await response.json())["item"]["channel"] == "shade"


async def _add_command(hub, command, description, choices):
    return await hub.add_inbox("approval", "general", "Approval needed", command,
                               {"command": command, "description": description,
                                "choices": choices, "session_key": "k"})


def test_an_encrypted_approval_push_keeps_the_whole_body_and_signatures():
    from plugin import encrypted_push
    from test_encrypted_push import KEY, KID, open_envelope

    body = "command --safe " + "x" * 900
    envelope = encrypted_push.seal(KEY, KID, "server", "phone", {
        "kind": "approval", "title": "Run?", "body": body,
        "choices": ["once", "deny"], "sig": {"once": "a" * 32, "deny": "b" * 32}})
    note = open_envelope(envelope)["note"]
    assert note["body"] == body
    assert note["choices"] == ["once", "deny"]
    assert note["sig"]["once"] == "a" * 32


async def test_the_toggle_is_off_by_default_and_decline_still_reaches_the_push(client, hub):
    async def allow(item, choice):
        return True

    hub.on_approval = allow
    owner = await pair_phone(client, hub)
    assert hub.push_options(hub.store.get_device(owner.id)) == {"shade_actions": False}
    assert "shade.approvals" not in [e["action"] for e in hub.store.list_audit()]

    ua_key = ec.generate_private_key(ec.SECP256R1())
    subscription = {"endpoint": "https://fcm.googleapis.com/abc",
                    "keys": {"p256dh": webpush.b64url_encode(webpush._public_bytes(ua_key.public_key())),
                             "auth": webpush.b64url_encode(b"0123456789abcdef")}}
    assert (await client.post("/api/push/webpush", json={"subscription": subscription},
                              headers=owner.auth)).status == 200
    await _add_command(hub, "ls -la", "", ["once", "deny"])
    note = json.loads(webpush.decrypt(hub._http.posts[-1][1]["content"], ua_key,
                                      subscription["keys"]["auth"]))
    assert note["choices"] == ["deny"]
    assert note["sig"]["deny"] == hub.action_signature(note["item_id"], "deny")
    # The old deny link remains usable even though shade approvals are off.
    response = await client.post(_path({"id": note["item_id"]}),
                                 json={"choice": "deny", "sig": note["sig"]["deny"]})
    assert response.status == 200
    assert (await response.json())["item"]["channel"] == "shade"


async def test_changing_the_toggle_is_audited(client, hub):
    owner = await pair_phone(client, hub)
    assert (await _set_toggle(client, owner, True)).status == 200
    assert (await _set_toggle(client, owner, False)).status == 200
    actions = [entry["action"] for entry in hub.store.list_audit()]
    assert actions.count("shade.approvals") == 2
