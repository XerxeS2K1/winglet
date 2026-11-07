"""Trusted-phone approval of a browser's own signing key (no live server/data)."""

import asyncio
import json
import re
import time

import pytest

from plugin import keys
from test_trust import client, hub, store, Phone, pair_phone, post_signed, seal


async def start_link(client, hub, browser=None, **changes):
    browser = browser or Phone("Firefox")
    details = {"device_name": browser.name, "platform": "web", "sign_key": browser.public, **changes}
    response = await client.post("/api/device-links", json={
        "sealed": seal(hub.keys.public_info(), "device-link-create", details)})
    assert response.status == 200, await response.text()
    return browser, await response.json()


async def claim_link(client, hub, browser, link, *, token=None, signature=None, target=None):
    target = target or link["id"]
    token = link["poll_token"] if token is None else token
    payload = f"winglet-device-link-claim-v1\n{target}\n{token}".encode()
    data = {"poll_token": token, "signature": signature or keys.b64e(browser.key.sign(payload))}
    return await client.post(f"/api/device-links/{target}/claim", json={
        "sealed": seal(hub.keys.public_info(), "device-link-claim", data, target)})


async def approve(client, phone, browser, link, role="owner", **changes):
    path = f"/api/device-links/{link['id']}/approve"
    return await post_signed(client, phone, path, {
        "role": role, "sign_key": browser.public,
        "verification_code": link["verification_code"], **changes})


async def test_browser_needs_phone_approval_then_has_own_verified_key(client, hub):
    phone = await pair_phone(client, hub)
    before = len(hub.store.list_devices())
    browser, link = await start_link(client, hub)
    assert re.fullmatch(r"[A-Za-z0-9_-]{32}", link["id"])
    assert re.fullmatch(r"[0-9]{6}", link["verification_code"])
    assert link["fingerprint"] == hub.keys.fingerprint
    assert time.time() + 175 < link["expires_at"] <= time.time() + 180
    assert len(hub.store.list_devices()) == before
    response = await claim_link(client, hub, browser, link)
    assert response.status == 200
    assert (await response.json())["status"] == "pending"
    path = f"/api/device-links/{link['id']}"
    preview = await client.get(path, headers=phone.signed("GET", path))
    assert preview.status == 200
    details = await preview.json()
    assert details["sign_key"] == browser.public
    assert details["verification_code"] == link["verification_code"]
    assert not {"poll_token", "token", "approver_key"} & set(details)
    response = await approve(client, phone, browser, link)
    assert response.status == 200, await response.text()
    assert len(hub.store.list_devices()) == before  # creating a device waits for its proof
    response = await claim_link(client, hub, browser, link)
    assert response.status == 200, await response.text()
    result = await response.json()
    assert result["status"] == "paired"
    assert result["me"]["role"] == "owner" and result["me"]["verified"] is True
    assert result["device"]["id"] != phone.id
    assert hub.store.device_sign_key(result["device"]["id"]) == browser.public != phone.public
    assert len(hub.store.list_devices()) == before + 1
    browser.id, browser.token = result["device"]["id"], result["token"]
    path = "/api/devices/pairing-code"
    assert (await post_signed(client, browser, path, {"role": "member"})).status == 200
    assert (await claim_link(client, hub, browser, link)).status == 404


async def test_linking_feature_is_advertised(client):
    response = await client.get("/api/info")
    assert (await response.json())["features"].get("device_linking") is True


@pytest.mark.parametrize("role,pinned,signed,expected", [
    ("member", True, True, 403), ("owner", False, True, 403),
    ("owner", True, False, 403), (None, False, False, 401),
])
async def test_preview_approval_and_denial_need_current_signed_owner(client, hub, role, pinned, signed, expected):
    browser, link = await start_link(client, hub)
    phone = await pair_phone(client, hub, role=role, pinned=pinned) if role else Phone("Unknown")
    base = f"/api/device-links/{link['id']}"
    headers = phone.signed("GET", base) if signed else phone.auth
    assert (await client.get(base, headers=headers)).status == expected
    body = {"role": "owner", "sign_key": browser.public, "verification_code": link["verification_code"]}
    for suffix, payload in (("approve", body), ("deny", {})):
        path = base + "/" + suffix
        response = (await post_signed(client, phone, path, payload)) if signed else await client.post(path, json=payload, headers=phone.auth)
        assert response.status == expected
    assert (await (await claim_link(client, hub, browser, link)).json())["status"] == "pending"


@pytest.mark.parametrize("changes", [
    {"role": "admin"}, {"role": None}, {"sign_key": Phone("Other").public},
    {"verification_code": "wrong"},
])
async def test_approval_requires_exact_preview_and_explicit_role(client, hub, changes):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    assert (await approve(client, phone, browser, link, **changes)).status == 400
    assert hub.device_links.pending[link["id"]]["status"] == "pending"


@pytest.mark.parametrize("bad", ["token", "signature", "id"])
async def test_qr_id_or_poll_secret_alone_cannot_claim(client, hub, bad):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    assert (await approve(client, phone, browser, link)).status == 200
    kwargs = {"token": "x" * 43} if bad == "token" else {"signature": keys.b64e(Phone("Attacker").key.sign(b"wrong"))} if bad == "signature" else {"target": "z" * 32}
    response = await claim_link(client, hub, browser, link, **kwargs)
    assert response.status == (404 if bad == "id" else 403)
    assert len(hub.store.list_devices()) == 1
    assert (await claim_link(client, hub, browser, link)).status == 200


async def test_denied_request_never_creates_device(client, hub):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    path = f"/api/device-links/{link['id']}/deny"
    assert (await post_signed(client, phone, path, {})).status == 200
    response = await claim_link(client, hub, browser, link)
    assert response.status == 200
    assert (await response.json())["status"] == "denied"
    assert (await approve(client, phone, browser, link)).status == 409
    assert len(hub.store.list_devices()) == 1


@pytest.mark.parametrize("operation", ["remove", "demote", "key_change", "unverify"])
async def test_approver_authority_must_still_exist_at_claim(client, hub, operation):
    phone = await pair_phone(client, hub)
    await pair_phone(client, hub, name="Backup owner")
    browser, link = await start_link(client, hub)
    assert (await approve(client, phone, browser, link)).status == 200
    if operation == "remove":
        hub.store.remove_device(phone.id)
    elif operation == "demote":
        hub.store.update_device(phone.id, role="member")
    elif operation == "key_change":
        hub.store.set_device_key(phone.id, Phone("New key").public)
    else:
        hub.store._exec("UPDATE devices SET verified = 0 WHERE id = ?", (phone.id,))
    before = len(hub.store.list_devices())
    assert (await claim_link(client, hub, browser, link)).status == 403
    assert len(hub.store.list_devices()) == before
    assert (await claim_link(client, hub, browser, link)).status == 404


async def test_member_browser_is_verified_but_cannot_approve_devices(client, hub):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    assert (await approve(client, phone, browser, link, role="member")).status == 200
    data = await (await claim_link(client, hub, browser, link)).json()
    assert data["me"]["verified"] is True and data["me"]["role"] == "member"
    browser.id, browser.token = data["device"]["id"], data["token"]
    assert (await post_signed(client, browser, "/api/devices/pairing-code", {"role": "owner"})).status == 403


async def test_expiry_cannot_be_extended_by_wall_clock_changes(client, hub, monkeypatch):
    from plugin import device_links
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    deadline = hub.device_links.pending[link["id"]]["deadline"]
    monkeypatch.setattr(device_links.time, "monotonic", lambda: deadline + 1)
    assert (await claim_link(client, hub, browser, link)).status == 404
    assert (await approve(client, phone, browser, link)).status == 404
    assert len(hub.store.list_devices()) == 1


async def test_approval_cannot_be_replayed_or_replaced(client, hub):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    path = f"/api/device-links/{link['id']}/approve"
    body = json.dumps({"role": "member", "sign_key": browser.public, "verification_code": link["verification_code"]}).encode()
    headers = phone.signed("POST", path, body)
    assert (await client.post(path, data=body, headers=headers)).status == 200
    assert (await client.post(path, data=body, headers=headers)).status == 403
    assert (await approve(client, phone, browser, link)).status == 409
    assert (await post_signed(client, phone, f"/api/device-links/{link['id']}/deny", {})).status == 409


@pytest.mark.parametrize("changes", [
    {"sign_key": "bad"}, {"sign_key": []}, {"sign_key": "!" * 43},
    {"platform": "android"}, {"device_name": []}, {"device_name": ""},
    {"device_name": "a" * 65}, {"device_name": "name\nspoofed"},
])
async def test_malformed_creation_is_rejected_without_allocating(client, hub, changes):
    details = {"device_name": "Browser", "platform": "web", "sign_key": Phone("Firefox").public, **changes}
    response = await client.post("/api/device-links", json={"sealed": seal(hub.keys.public_info(), "device-link-create", details)})
    assert response.status == 400
    assert not hub.device_links.pending


async def test_creation_has_per_peer_and_global_rate_limits(client, hub, monkeypatch):
    from plugin import device_links
    monkeypatch.setattr(device_links, "MAX_PEER_CREATES_PER_MINUTE", 2)
    await start_link(client, hub)
    await start_link(client, hub)
    response = await client.post("/api/device-links", json={})
    assert response.status == 429
    monkeypatch.setattr(device_links, "MAX_PEER_CREATES_PER_MINUTE", 10)
    monkeypatch.setattr(device_links, "MAX_CREATES_PER_MINUTE", 2)
    assert (await client.post("/api/device-links", json={})).status == 429
    assert len(hub.device_links.pending) == 2


async def test_concurrent_create_cannot_overrun_pending_limit(client, hub, monkeypatch):
    import asyncio
    from plugin import device_links
    monkeypatch.setattr(device_links, "MAX_PENDING", 1)
    original = hub.device_links._open
    arrived = 0
    both = asyncio.Event()

    async def rendezvous(*args, **kwargs):
        nonlocal arrived
        data = await original(*args, **kwargs)
        arrived += 1
        if arrived == 2:
            both.set()
        await asyncio.wait_for(both.wait(), 2)
        return data

    monkeypatch.setattr(hub.device_links, "_open", rendezvous)
    data = {"device_name": "Browser", "platform": "web", "sign_key": Phone("Firefox").public}
    payload = {"sealed": seal(hub.keys.public_info(), "device-link-create", data)}
    replies = await asyncio.gather(*(client.post("/api/device-links", json=payload) for _ in range(2)))
    assert sorted(r.status for r in replies) == [200, 429]
    assert len(hub.device_links.pending) == 1


async def test_concurrent_claim_creates_exactly_one_device(client, hub):
    import asyncio
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    assert (await approve(client, phone, browser, link)).status == 200
    replies = await asyncio.gather(*(claim_link(client, hub, browser, link) for _ in range(3)))
    assert sorted(r.status for r in replies) == [200, 404, 404]
    assert len(hub.store.list_devices()) == 2


async def test_signing_key_replaced_during_body_read_cannot_approve(client, hub, monkeypatch):
    """The middleware reads the signing key before the body; a rotation in that window must not let the
    revoked key's in-flight approval be blessed by the replacement key."""
    from aiohttp.web_request import BaseRequest
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    path = f"/api/device-links/{link['id']}/approve"
    original = BaseRequest.read
    entered = asyncio.Event()
    resume = asyncio.Event()
    held = False

    async def read(request):
        nonlocal held
        if request.path == path and request.method == "POST" and not held:
            held = True
            entered.set()
            await resume.wait()
        return await original(request)

    monkeypatch.setattr(BaseRequest, "read", read)
    task = asyncio.create_task(approve(client, phone, browser, link))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        assert hub.store.device_sign_key(phone.id) == phone.public
        hub.store.set_device_key(phone.id, Phone("replacement signing key").public)
    finally:
        resume.set()
    response = await task
    assert response.status == 403
    assert hub.device_links.pending[link["id"]]["status"] == "pending"
    assert (await claim_link(client, hub, browser, link)).status == 200
    assert len(hub.store.list_devices()) == 1


async def test_preview_and_audit_never_expose_poll_credentials(client, hub):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    await approve(client, phone, browser, link)
    path = f"/api/device-links/{link['id']}"
    text = await (await client.get(path, headers=phone.signed("GET", path))).text()
    rows = hub.store._all("SELECT * FROM audit")
    audit = json.dumps([dict(row) for row in rows])
    assert link["poll_token"] not in text + audit
    assert "poll_hash" not in text
    assert "approver_key" not in text
