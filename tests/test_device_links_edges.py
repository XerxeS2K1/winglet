"""Expiry, resource bounds and malformed protocol inputs for browser linking."""

import pytest

from plugin import keys
from test_trust import client, hub, store, Phone, pair_phone, post_signed, seal
from test_device_links import start_link, claim_link, approve


@pytest.mark.parametrize("payload", [{}, {"sealed": []}, {"sealed": "bad"}, {"sealed": "x" * 4097}, []])
async def test_invalid_create_never_crashes_or_allocates(client, hub, payload):
    response = await client.post("/api/device-links", json=payload)
    assert response.status == 400
    assert not hub.device_links.pending


async def test_sealed_creation_cannot_be_reused_as_claim(client, hub):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    await approve(client, phone, browser, link)
    path = f"/api/device-links/{link['id']}/claim"
    blob = seal(hub.keys.public_info(), "device-link-create", {"poll_token": link["poll_token"], "signature": "x"})
    assert (await client.post(path, json={"sealed": blob})).status == 403
    assert (await claim_link(client, hub, browser, link)).status == 200


async def test_claim_proof_is_bound_to_request_id(client, hub):
    browser, first = await start_link(client, hub)
    _, second = await start_link(client, hub, browser=browser)
    payload = f"winglet-device-link-claim-v1\n{first['id']}\n{second['poll_token']}".encode()
    response = await claim_link(client, hub, browser, second, signature=keys.b64e(browser.key.sign(payload)))
    assert response.status == 403


async def test_bad_claims_are_throttled_without_creating_device(client, hub):
    from plugin.hub import PAIR_FAILURES_PER_MINUTE
    browser, link = await start_link(client, hub)
    for _ in range(PAIR_FAILURES_PER_MINUTE):
        assert (await claim_link(client, hub, browser, link, token="x" * 43)).status == 403
    assert (await claim_link(client, hub, browser, link)).status == 429
    assert not hub.store.list_devices()


async def test_approved_request_still_expires_without_device(client, hub, monkeypatch):
    from plugin import device_links
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    await approve(client, phone, browser, link)
    monotonic = device_links.time.monotonic()
    monkeypatch.setattr(device_links, "time", type("Clock", (), {
        "monotonic": staticmethod(lambda: monotonic + 181),
        "time": staticmethod(lambda: 1),
    }))
    assert (await claim_link(client, hub, browser, link)).status == 404
    assert len(hub.store.list_devices()) == 1


async def test_restart_drops_outstanding_approvals_but_not_paired_devices(client, hub, aiohttp_client):
    from plugin.hub import Hub
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    await approve(client, phone, browser, link)
    restarted = Hub(hub.store)
    other = await aiohttp_client(restarted.build_app())
    assert not restarted.device_links.pending
    assert (await claim_link(other, restarted, browser, link)).status == 404
    paired = restarted.store.get_device(phone.id)
    assert paired and paired["verified"] is True


async def test_pending_capacity_prunes_expired_records(client, hub, monkeypatch):
    from plugin import device_links
    monkeypatch.setattr(device_links, "MAX_PENDING", 1)
    await start_link(client, hub)
    first = next(iter(hub.device_links.pending.values()))
    first["deadline"] = -1
    _, second = await start_link(client, hub)
    assert list(hub.device_links.pending) == [second["id"]]


async def test_no_credential_is_returned_to_approving_phone(client, hub):
    phone = await pair_phone(client, hub)
    browser, link = await start_link(client, hub)
    response = await approve(client, phone, browser, link)
    assert await response.json() == {"status": "approved"}
    assert len(hub.store.list_devices()) == 1
