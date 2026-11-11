"""Tokens and cost per hour, read from Hermes's own session_model_usage table."""

import logging
import sqlite3
import time

import pytest

from plugin import hermes_api
from plugin.hub import Hub
from plugin.store import Store
from test_agent import Refused, Unavailable
from test_trust import pair_phone

HOUR = 3600
# 2026-01-01 00:00:00 UTC, an exact hour boundary.
BASE = 1_767_225_600
NOW = BASE + 10 * HOUR + 600

COLUMNS = ("session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, "
           "cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, first_seen, last_seen")


def make_db(path, rows):
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, task TEXT, "
               "api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, "
               "cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, "
               "first_seen REAL, last_seen REAL)")
    for row in rows:
        db.execute(f"INSERT INTO session_model_usage ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", row)
    db.commit()
    db.close()


def row(session, model, last_seen, *, calls=1, inp=0, out=0, cr=0, cw=0, est=0.0, actual=0.0):
    return (session, model, calls, inp, out, cr, cw, 0, est, actual, last_seen - 60, last_seen)


# -- the pure part ----------------------------------------------------------------------------


def test_hour_rows_are_integers_oldest_first_and_sparse():
    shaped = hermes_api.usage_hour_rows([
        (BASE + HOUR, 5.0, 2, 0, 0, 1, 0.014),
        (BASE, 100, 40, 7, 3, 2, 0.5),
        (BASE + 2 * HOUR, 0, 0, 0, 0, 0, 0.0),  # nothing happened: left out
        (None, 1, 1, 1, 1, 1, 1.0),             # no time: left out
    ])
    assert shaped == [[BASE, 100, 40, 7, 3, 2, 50], [BASE + HOUR, 5, 2, 0, 0, 1, 1]]
    assert all(type(n) is int for r in shaped for n in r)


def test_hour_rows_treat_a_missing_cost_as_zero_and_empty_input_as_empty():
    assert hermes_api.usage_hour_rows([(BASE, 10, 0, 0, 0, 1, None)]) == [[BASE, 10, 0, 0, 0, 1, 0]]
    assert hermes_api.usage_hour_rows([]) == []


# -- the query, against a real SQLite file ----------------------------------------------------


def test_rows_land_in_the_hour_of_last_seen_across_a_boundary(tmp_path):
    db = tmp_path / "state.db"
    make_db(db, [
        row("a", "m1", BASE + HOUR - 1, inp=10, out=1),         # last second of the first hour
        row("b", "m1", BASE + HOUR, inp=20, out=2),              # first second of the next
        row("c", "m1", BASE + HOUR + 1799, inp=30, out=3),
    ])
    hours = hermes_api.usage_hours(1, now=NOW, db_path=db)["hours"]
    assert hours == [[BASE, 10, 1, 0, 0, 1, 0], [BASE + HOUR, 50, 5, 0, 0, 2, 0]]


def test_two_models_in_one_hour_are_summed(tmp_path):
    db = tmp_path / "state.db"
    make_db(db, [
        row("a", "claude", BASE + 100, calls=3, inp=1000, out=200, cr=50, cw=5, est=0.10),
        row("a", "gpt", BASE + 200, calls=2, inp=500, out=100, cr=10, cw=1, est=0.05),
    ])
    assert hermes_api.usage_hours(1, now=NOW, db_path=db)["hours"] == [[BASE, 1500, 300, 60, 6, 5, 15]]


def test_cost_prefers_a_real_actual_cost_and_survives_nulls(tmp_path):
    db = tmp_path / "state.db"
    make_db(db, [
        row("a", "m", BASE + 10, est=1.00, actual=0.80),     # measured wins
        row("b", "m", BASE + HOUR + 10, est=0.25, actual=0.0),  # Hermes stores 0, not NULL, when unmeasured
        row("c", "m", BASE + 2 * HOUR + 10, est=None, actual=None, inp=5),  # no cost at all
    ])
    costs = [h[6] for h in hermes_api.usage_hours(1, now=NOW, db_path=db)["hours"]]
    assert costs == [80, 25, 0]


def test_the_window_is_clamped_and_old_rows_are_left_out(tmp_path):
    db = tmp_path / "state.db"
    make_db(db, [row("old", "m", NOW - 50 * 86400, inp=1), row("recent", "m", NOW - 3 * 86400, inp=2),
                 row("today", "m", NOW - 60, inp=4)])
    assert [h[1] for h in hermes_api.usage_hours(100, now=NOW, db_path=db)["hours"]] == [2, 4]  # 40 days, not 100
    assert [h[1] for h in hermes_api.usage_hours(0, now=NOW, db_path=db)["hours"]] == [4]       # at least a day
    wide = hermes_api.usage_hours(100, now=NOW, db_path=db)
    assert wide["to"] - wide["from"] <= 40 * 86400 + 2 * HOUR


def test_a_missing_file_or_table_degrades_to_an_empty_series_with_a_warning(tmp_path, caplog):
    with caplog.at_level(logging.WARNING, logger="plugin.hermes_api"):
        gone = hermes_api.usage_hours(7, now=NOW, db_path=tmp_path / "nope.db")
        assert gone["hours"] == [] and gone["from"] < gone["to"]
        bare = tmp_path / "bare.db"
        sqlite3.connect(bare).close()
        assert hermes_api.usage_hours(7, now=NOW, db_path=bare)["hours"] == []
    assert sum("usage by hour unavailable" in r.message for r in caplog.records) == 2
    assert not (tmp_path / "nope.db").exists(), "a read-only open must not create the file"


def test_the_query_is_read_only_and_leaves_no_connection_or_lock(tmp_path):
    db = tmp_path / "state.db"
    make_db(db, [row("a", "m", BASE + 10, inp=1)])
    hermes_api.usage_hours(7, now=NOW, db_path=db)
    writer = sqlite3.connect(db, timeout=0.2)
    writer.execute("BEGIN IMMEDIATE")  # would fail if a reader still held the file
    writer.rollback()
    writer.close()


# -- the route --------------------------------------------------------------------------------


class Hermes:
    HermesRefused = Refused
    HermesUnavailable = Unavailable

    def __init__(self, db_path):
        self.db_path = db_path

    def usage_hours(self, days):
        return hermes_api.usage_hours(days, db_path=self.db_path)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = Hermes(tmp_path / "state.db")
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def test_the_endpoint_returns_a_sparse_integer_list_for_owners_only(client, hub, tmp_path):
    now = int(time.time())
    hour = (now // HOUR) * HOUR
    make_db(tmp_path / "state.db", [
        row("a", "m", hour - 5 * HOUR + 5, calls=2, inp=100, out=10, cr=5, cw=1, est=0.019),
        row("b", "m", hour - 2 * HOUR + 5, calls=1, inp=7),
    ])
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await client.get("/api/usage/hours", headers=member.auth)).status == 403
    assert (await client.get("/api/usage/hours")).status in (401, 403)
    resp = await client.get("/api/usage/hours?days=2", headers=owner.auth)
    assert resp.status == 200
    body = await resp.json()
    assert set(body) == {"from", "to", "hours"}
    assert body["hours"] == [[hour - 5 * HOUR, 100, 10, 5, 1, 2, 2], [hour - 2 * HOUR, 7, 0, 0, 0, 1, 0]]
    assert all(type(n) is int for r in body["hours"] for n in r) and type(body["from"]) is int
    assert len(body["hours"]) == 2, "empty hours must be omitted"


async def test_the_endpoint_clamps_days_and_rejects_junk(client, hub, tmp_path):
    now = int(time.time())
    make_db(tmp_path / "state.db", [row("old", "m", now - 60 * 86400, inp=9), row("new", "m", now - 60, inp=1)])
    owner = await pair_phone(client, hub)
    wide = await (await client.get("/api/usage/hours?days=9999", headers=owner.auth)).json()
    assert [h[1] for h in wide["hours"]] == [1]
    assert 39 * 86400 < wide["to"] - wide["from"] <= 40 * 86400 + 2 * HOUR
    narrow = await (await client.get("/api/usage/hours?days=-5", headers=owner.auth)).json()
    assert narrow["to"] - narrow["from"] <= 86400 + 2 * HOUR
    assert (await client.get("/api/usage/hours?days=lots", headers=owner.auth)).status == 400
    default = await (await client.get("/api/usage/hours", headers=owner.auth)).json()
    assert 6 * 86400 < default["to"] - default["from"] <= 7 * 86400 + 2 * HOUR


async def test_the_endpoint_degrades_when_the_database_is_missing(client, hub):
    owner = await pair_phone(client, hub)
    resp = await client.get("/api/usage/hours", headers=owner.auth)
    assert resp.status == 200
    assert (await resp.json())["hours"] == []


async def test_the_usage_route_is_in_the_policy_table(hub):
    from plugin.hub import ROUTE_POLICY
    assert ROUTE_POLICY["h_usage_hours"] == "owner"
