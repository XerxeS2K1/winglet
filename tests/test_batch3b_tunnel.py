"""Review finding #34: one readiness check of the public tunnel address has a total deadline."""
import asyncio

import httpx

from plugin import tunnel


def real_sleep_capped(real):
    async def sleep(seconds, *args):
        if seconds >= 60:
            await real(3)
            raise AssertionError("the readiness check was still waiting after 3 s: it has no total deadline")
        return await real(seconds, *args)
    return sleep


async def test_a_public_address_that_never_finishes_answering_is_not_ready_and_does_not_hang(monkeypatch):
    class Dripping:
        """Accepts the connection, then trickles: httpx's per-phase timeouts never fire."""
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def get(self, url):
            await asyncio.sleep(60)
    monkeypatch.setattr(tunnel.httpx, "AsyncClient", Dripping)
    monkeypatch.setattr(tunnel, "VERIFY_DEADLINE", 0.2, raising=False)
    monkeypatch.setattr(asyncio, "sleep", real_sleep_capped(asyncio.sleep))   # an unfixed check ends in 3 s, as a failure
    assert await tunnel.verify_url("https://some-name.trycloudflare.com", "s") is False


async def test_a_check_inside_the_deadline_still_succeeds(monkeypatch):
    original = httpx.AsyncClient
    handler = lambda request: httpx.Response(200, json={"app": "winglet", "server_id": "s"})
    monkeypatch.setattr(tunnel.httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    assert await tunnel.verify_url("https://some-name.trycloudflare.com", "s") is True
