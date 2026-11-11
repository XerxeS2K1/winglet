"""The daily USD->GBP rate: parsing, the cache file, failure fallback, and the additive usage field."""

import asyncio
import json

import pytest

from plugin import fx
from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone

V1 = {"amount": 1.0, "base": "USD", "date": "2026-11-10", "rates": {"GBP": 0.74501}}
V2 = {"date": "2026-11-11", "base": "USD", "quote": "GBP", "rate": 0.74547}


class Clock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


def fetcher(*answers):
    """An injected fetch: returns or raises each answer in turn, then the last one forever. Never the network."""
    calls = []

    async def fetch():
        calls.append(1)
        answer = answers[min(len(calls), len(answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer

    fetch.calls = calls
    return fetch


# -- parsing ------------------------------------------------------------------------------------

def test_both_frankfurter_shapes_parse():
    assert fx.parse_rate(V1) == 0.74501
    assert fx.parse_rate(V2) == 0.74547
    assert fx.parse_rate([V2]) == 0.74547


@pytest.mark.parametrize("bad", [None, "0.7", [], {}, {"rate": 0}, {"rate": -1}, {"rate": True}, {"rate": "0.75"},
                                 {"rate": float("nan")}, {"rate": float("inf")}, {"rate": 0.001}, {"rate": 500},
                                 {"rates": {"EUR": 0.9}}, {"rates": []}])
def test_nonsense_is_not_a_rate(bad):
    assert fx.parse_rate(bad) is None


@pytest.mark.parametrize("body", [
    {"date": "2026-11-11", "base": "EUR", "quote": "USD", "rate": 1.16},      # v2, euro to dollar: in the band, wrong pair
    {"date": "2026-11-11", "base": "USD", "quote": "EUR", "rate": 0.86},      # v2, right base, wrong quote
    {"date": "2026-11-11", "base": "EUR", "quote": "GBP", "rate": 0.87},      # v2, euro to pound
    {"amount": 1.0, "base": "EUR", "date": "2026-11-10", "rates": {"GBP": 0.87}},  # v1, euro base
])
def test_another_currency_pair_is_not_the_rate_even_inside_the_band(body):
    assert fx.parse_rate(body) is None
    assert fx.parse_rate([body]) is None


# -- the cache ----------------------------------------------------------------------------------

async def test_a_fetched_rate_is_kept_on_disk_and_survives_a_restart(tmp_path):
    clock = Clock()
    rates = fx.UsdGbp(tmp_path / "usd-gbp.json", fetcher(V2), clock)
    assert rates.rate is None and rates.due()
    assert await rates.refresh() is True
    assert rates.rate == 0.74547 and not rates.due()
    assert json.loads((tmp_path / "usd-gbp.json").read_text()) == {"usd_gbp": 0.74547, "fetched_at": clock.now}
    reloaded = fx.UsdGbp(tmp_path / "usd-gbp.json", fetcher(RuntimeError("offline")), clock)
    assert reloaded.rate == 0.74547 and not reloaded.due()


async def test_it_is_due_again_after_a_day(tmp_path):
    clock = Clock()
    rates = fx.UsdGbp(tmp_path / "r.json", fetcher(V2), clock)
    await rates.refresh()
    clock.now += fx.REFRESH_SECONDS - 1
    assert not rates.due()
    clock.now += 1
    assert rates.due()


@pytest.mark.parametrize("failure", [RuntimeError("offline"), {"rate": 0}, {"unexpected": True}, None])
async def test_a_failed_fetch_keeps_the_last_good_rate(tmp_path, failure):
    clock = Clock()
    rates = fx.UsdGbp(tmp_path / "r.json", fetcher(V1, failure), clock)
    await rates.refresh()
    clock.now += fx.REFRESH_SECONDS
    assert await rates.refresh() is False
    assert rates.rate == 0.74501
    assert json.loads((tmp_path / "r.json").read_text())["usd_gbp"] == 0.74501


async def test_a_damaged_cache_file_means_no_rate_not_a_crash(tmp_path):
    (tmp_path / "r.json").write_text("{not json")
    assert fx.UsdGbp(tmp_path / "r.json", fetcher(V1)).rate is None
    (tmp_path / "r.json").write_text(json.dumps({"usd_gbp": "lots", "fetched_at": 1}))
    assert fx.UsdGbp(tmp_path / "r.json", fetcher(V1)).rate is None


# -- the loop -----------------------------------------------------------------------------------

class Stop(Exception):
    pass


async def run_loop(rates, naps):
    async def sleep(seconds):
        naps.append(seconds)
        if len(naps) >= 5:
            raise Stop

    with pytest.raises(Stop):
        await rates.run(sleep)


async def test_failures_back_off_then_a_success_waits_about_a_day(tmp_path):
    clock = Clock()
    fetch = fetcher(RuntimeError("down"), RuntimeError("down"), V2)
    naps = []
    await run_loop(fx.UsdGbp(tmp_path / "r.json", fetch, clock), naps)
    assert naps[:2] == [fx.RETRY_FIRST_SECONDS, fx.RETRY_FIRST_SECONDS * 2]
    assert naps[2] == fx.REFRESH_SECONDS  # fetched, so the next look is a day away
    assert len(fetch.calls) == 3


async def test_the_backoff_is_capped(tmp_path):
    naps = []

    async def sleep(seconds):
        naps.append(seconds)
        if len(naps) >= 9:
            raise Stop

    with pytest.raises(Stop):
        await fx.UsdGbp(tmp_path / "r.json", fetcher(RuntimeError("down")), Clock()).run(sleep)
    assert max(naps) == fx.RETRY_MAX_SECONDS and naps[-1] == fx.RETRY_MAX_SECONDS


async def test_a_fresh_cache_is_not_fetched_again_at_startup(tmp_path):
    clock = Clock()
    (tmp_path / "r.json").write_text(json.dumps({"usd_gbp": 0.75, "fetched_at": clock.now - 3600}))
    fetch = fetcher(V2)
    await run_loop(fx.UsdGbp(tmp_path / "r.json", fetch, clock), [])
    assert fetch.calls == []


async def test_frankfurter_tries_the_older_address_when_the_newer_fails():
    seen = []

    class Resp:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            if self.body is None:
                raise RuntimeError("404")

        def json(self):
            return self.body

    class Client:
        async def get(self, url, **kw):
            seen.append(url)
            return Resp(None if "/v2/" in url else V1)

    assert fx.parse_rate(await fx.frankfurter(Client())) == 0.74501
    assert [u.split("/")[3] for u in seen] == ["v2", "v1"]


# -- the usage payload --------------------------------------------------------------------------

class FakeHermes:
    def usage(self, days):
        return {"daily": [], "by_model": [], "totals": {"total_estimated_cost": 0.01}, "period_days": days}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = FakeHermes()
    return h


async def usage(aiohttp_client, hub):
    client = await aiohttp_client(hub.build_app())
    owner = await pair_phone(client, hub)
    resp = await client.get("/api/usage?days=7", headers=owner.auth)
    assert resp.status == 200
    return await resp.json()


async def test_usage_has_no_rate_field_when_none_was_ever_fetched(aiohttp_client, hub, tmp_path):
    assert "usd_gbp" not in await usage(aiohttp_client, hub)  # no rates installed at all


async def test_usage_has_no_rate_field_while_the_fetch_has_not_succeeded(aiohttp_client, hub, tmp_path):
    hub.rates = fx.UsdGbp(tmp_path / "r.json", fetcher(RuntimeError("offline")))
    assert "usd_gbp" not in await usage(aiohttp_client, hub)


async def test_usage_carries_the_rate_and_changes_nothing_else(aiohttp_client, hub, tmp_path):
    hub.rates = fx.UsdGbp(tmp_path / "r.json", fetcher(V2))
    await hub.rates.refresh()
    body = await usage(aiohttp_client, hub)
    assert body.pop("usd_gbp") == 0.74547
    assert body == FakeHermes().usage(7)


async def test_the_background_fetch_never_holds_up_a_request(aiohttp_client, hub, tmp_path):
    release = asyncio.Event()
    started = asyncio.Event()

    async def hung():
        started.set()
        await release.wait()
        return V2

    hub.rates = fx.UsdGbp(tmp_path / "r.json", hung)
    body = await asyncio.wait_for(usage(aiohttp_client, hub), 5)  # served while the rate service hangs
    assert "usd_gbp" not in body
    await asyncio.wait_for(started.wait(), 5)  # ...and the startup did start the fetch
    release.set()


async def test_without_rates_the_startup_makes_no_fetch(aiohttp_client, hub):
    assert hub.rates is None
    await usage(aiohttp_client, hub)
    assert not [t for t in hub._tasks if "UsdGbp" in repr(t)]
