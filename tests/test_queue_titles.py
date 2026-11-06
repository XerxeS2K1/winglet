"""Short titles for the hand-off queue sheet.

A calling agent passes `title` to Winglet's ask_bot; it is cleaned, kept in the hand-off ledger under the delivery id,
and shown as the main line of the owner's queue sheet. The queue itself is Hermes's admission table, whose request id is
"bot:" + the delivery id Winglet chose, so the match is exact. Anything without a title (hand-offs that did not come from
ask_bot, such as Hermes's own message_agent) shows the first line of the request instead. A title is the sender's own
text: untrusted, plain text, capped on the server.
"""

import asyncio
import json
import sqlite3
import uuid

import pytest

from plugin import hermes_api, teamwork
from plugin.handoffs import TITLE_MAX, FALLBACK_MAX, clean_title, delivery_id_from_request, first_line_title
from plugin.hub import Hub
from plugin.store import Store
from test_handoffs import origin, team  # noqa: F401  (fixtures)


def hexid():
    return uuid.uuid4().hex


# -- cleaning a title ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ("Plan dinner", "Plan dinner"),
    ("  Plan \n\t  dinner  ", "Plan dinner"),                    # whitespace collapsed and trimmed
    ("Plan\x07 dinner\x00", "Plan dinner"),                      # control characters removed
    ("Plan\u200b dinner", "Plan dinner"),                        # zero-width characters removed
    ("evil\u202egnp.exe", "evilgnp.exe"),                        # bidi override removed: it could reverse what is shown
    ("line one\u2028line two", "line one line two"),             # line separator is whitespace
    ("Pasta 🍝 night", "Pasta 🍝 night"),                          # ordinary emoji are kept
    ("", ""), ("   ", ""), ("\x00\x01\x02", ""), (None, ""), (5, ""), (["a"], ""), ({"a": 1}, ""), (b"bytes", ""), (True, ""),
])
def test_a_title_is_plain_single_line_text(raw, expected):
    assert clean_title(raw) == expected


def test_a_long_title_is_cut_not_refused():
    assert TITLE_MAX == 50
    assert clean_title("x" * 50) == "x" * 50
    assert clean_title("x" * 51) == "x" * 50
    assert clean_title("x" * 500) == "x" * 50
    cut = clean_title("a" * 49 + " " + "b" * 40)
    assert cut == "a" * 49 and not cut.endswith(" ")          # no trailing space left by the cut
    assert len(clean_title("é" * 80)) == 50                     # counted in characters, not bytes


def test_cleaning_is_idempotent_and_cannot_grow():
    for raw in ("  Compare\n\nsources  ", "x" * 200, "a\u200bb\x07c", "ok"):
        once = clean_title(raw)
        assert clean_title(once) == once and len(once) <= TITLE_MAX


# -- matching a queue row to its hand-off ----------------------------------------------------------------------------


@pytest.mark.parametrize("request_id,expected", [
    ("bot:" + "a" * 32, "a" * 32), ("bot:" + "0123456789abcdef" * 4, "0123456789abcdef" * 4),
    ("bot:" + "a" * 32 + ":retry", "a" * 32),                   # Hermes's one automatic retry of the same hand-off
])
def test_the_delivery_id_comes_out_of_the_admission_request_id(request_id, expected):
    assert delivery_id_from_request(request_id) == expected


@pytest.mark.parametrize("request_id", [
    "bot:" + "a" * 31, "bot:" + "a" * 65, "bot:" + "A" * 32, "bot:" + "g" * 32, "bot:", "bot", "", "dm:" + "a" * 32,
    "bot:" + "a" * 32 + ":other", "bot:" + "a" * 32 + "\n", " bot:" + "a" * 32, "xbot:" + "a" * 32, None, 5, ["bot:" + "a" * 32],
    "bot:" + "a" * 32 + ":retry:retry",
])
def test_anything_else_does_not_match(request_id):
    assert delivery_id_from_request(request_id) is None


# -- the ledger --------------------------------------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


def test_a_subject_is_kept_with_the_hand_off_and_found_by_delivery_id(store):
    chat = store.create_chat("Jobs")
    a, b, c = hexid(), hexid(), hexid()
    store.register_handoff(a, chat["id"], "chef", "Chef", "Plan dinner", 0, subject="Plan dinner")
    store.register_handoff(b, chat["id"], "chef", "Chef", "Shop", 0)                # no subject given
    store.register_handoff(c, chat["id"], "chef", "Chef", "Cook", 0, subject="")
    assert store.handoff_subjects([a, b, c, hexid()]) == {a: "Plan dinner"}          # only real titles, only known ids
    assert store.handoff_subjects([]) == {}
    assert store._one("SELECT title FROM handoffs WHERE delivery_id=?", (a,))["title"] == "Chef"   # the bot's name is unchanged


def test_the_ledger_cleans_a_subject_even_if_a_caller_forgot(store):
    chat = store.create_chat("Jobs")
    a = hexid()
    store.register_handoff(a, chat["id"], "chef", "Chef", "q", 0, subject="  x\x07" + "y" * 100)
    assert store.handoff_subjects([a])[a] == "x" + "y" * 49
    assert store._one("SELECT subject FROM handoffs WHERE delivery_id=?", (a,))["subject"] == "x" + "y" * 49   # clean on disk, not only on read


def test_a_subject_read_back_is_cleaned_again(store):
    chat = store.create_chat("Jobs")
    a = hexid()
    store.register_handoff(a, chat["id"], "chef", "Chef", "q", 0, subject="ok")
    store._exec("UPDATE handoffs SET subject=? WHERE delivery_id=?", ("bad\x07\u202e title " + "z" * 300, a))   # a damaged or hand-edited row
    assert store.handoff_subjects([a])[a] == "bad title " + "z" * 40


def test_many_ids_at_once_do_not_trip_sqlites_variable_limit(store):
    ids = [hexid() for _ in range(2500)]
    assert store.handoff_subjects(ids) == {}


def test_an_existing_database_gains_the_column_and_keeps_its_hand_offs(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE handoffs (delivery_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, from_bot TEXT NOT NULL DEFAULT '',
            to_bot TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'inline',
            inline_until REAL NOT NULL, created_at REAL NOT NULL);
        INSERT INTO handoffs VALUES ('old1', 'c1', '', 'chef', 'Chef', 'Cook', 'waiting', 1, 1);
    """)
    db.commit()
    db.close()
    s = Store(path)
    try:
        row = s._one("SELECT * FROM handoffs WHERE delivery_id='old1'")
        assert row["question"] == "Cook" and row["state"] == "waiting" and row["subject"] == ""
        assert s.handoff_subjects(["old1"]) == {}
    finally:
        s.close()


# -- ask_bot takes a title -----------------------------------------------------------------------------------------------


def test_the_tool_tells_agents_to_pass_a_short_title():
    props = teamwork.ASK_SCHEMA["parameters"]["properties"]
    assert props["title"]["type"] == "string"
    assert "50" in props["title"]["description"] and "short" in props["title"]["description"].lower()
    assert "maxLength" not in props["title"]                      # too long is cut by us, never refused by the schema
    assert "title" not in teamwork.ASK_SCHEMA["parameters"]["required"]
    assert "title" in teamwork.ASK_SCHEMA["description"].lower()


async def test_ask_bot_stores_the_cleaned_title_under_the_delivery_id(origin, monkeypatch):
    hub, store, chat = origin
    sent = []
    monkeypatch.setattr(teamwork, "_deliver", lambda profile, content, sender, **options: sent.append(content) or {"status": "claimed"})
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {
        "bot": "chef", "message": "Plan dinner for six", "wait": 0, "title": "  Plan \n dinner\x07 " + "x" * 80}))
    assert result["status"] == "queued"
    assert store.handoff_subjects([result["delivery_id"]]) == {result["delivery_id"]: ("Plan dinner " + "x" * 80)[:50].rstrip()}
    assert len(sent) == 1 and "Plan dinner for six" in sent[0] and "xxxx" not in sent[0]       # the target is not sent the title


@pytest.mark.parametrize("title", [None, "", "   ", 123, ["a"], {"a": 1}, "\x00\x01"])
async def test_ask_bot_without_a_usable_title_behaves_as_before(origin, monkeypatch, title):
    hub, store, chat = origin
    monkeypatch.setattr(teamwork, "_deliver", lambda profile, content, sender, **options: {"status": "claimed"})
    args = {"bot": "chef", "message": "Plan dinner", "wait": 0}
    if title is not None:
        args["title"] = title
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, args))
    assert result["status"] == "queued"
    assert store.handoff_subjects([result["delivery_id"]]) == {}


async def test_a_title_never_changes_what_the_target_is_sent(origin, monkeypatch):
    hub, store, chat = origin
    sent = {}
    monkeypatch.setattr(teamwork, "_deliver", lambda profile, content, sender, **options: sent.setdefault("a" if "a" not in sent else "b", content) and {"status": "claimed"})
    await asyncio.to_thread(teamwork.ask_bot, {"bot": "chef", "message": "Plan dinner", "wait": 0})
    await asyncio.to_thread(teamwork.ask_bot, {"bot": "chef", "message": "Plan dinner", "wait": 0, "title": "Dinner"})
    assert sent["a"] == sent["b"]


# -- the fallback: the first line of the request --------------------------------------------------------------------------


def test_a_short_first_line_is_shown_whole():
    assert first_line_title("Plan dinner for six") == "Plan dinner for six"
    assert first_line_title("Plan dinner for six\nand then shop\nand cook") == "Plan dinner for six"
    assert first_line_title("\n\n   \nPlan dinner\n") == "Plan dinner"                  # blank lines are skipped


def test_a_long_first_line_is_cut_at_a_word_boundary_with_an_ellipsis():
    line = "Puppet Master here, with Kraig's yes. New small item, same rules as before: own branch and worktree, tests first"
    assert FALLBACK_MAX == 60
    cut = first_line_title(line)
    assert cut.endswith("…") and len(cut) <= FALLBACK_MAX + 1
    body = cut[:-1]
    assert line.startswith(body) and line[len(body)] == " "                          # ended exactly at a word boundary
    assert body == "Puppet Master here, with Kraig's yes. New small item, same"


def test_a_line_of_exactly_the_limit_is_not_cut_and_one_longer_is():
    assert first_line_title("a " * 29 + "bb") == "a " * 29 + "bb" and len("a " * 29 + "bb") == 60
    assert first_line_title("a " * 30 + "bb").endswith("…")


def test_one_endless_word_is_cut_hard_rather_than_shown_whole():
    cut = first_line_title("x" * 300)
    assert cut == "x" * 60 + "…"


def test_the_fallback_is_plain_text_too():
    assert first_line_title("Plan\x07 dinner\u202e now") == "Plan dinner now"
    assert first_line_title("") == "" and first_line_title(None) == "" and first_line_title("\x00\n \n") == ""


def payload(text, name="Puppet Master", *, kind="local_automation_v1"):
    return json.dumps({"text": text, kind: {"turn_author": {"name": name, "is_bot": True}}})


def test_a_queue_entry_always_has_a_title_and_still_has_the_old_preview():
    header = "Message from 🤖 Puppet Master (@hermes), sent from the chat \"General\": "
    text = header + "Compare the two sources and tell me which is newer.\n\nMore detail on the next line.\n\n(Answer in your reply to this message.)"
    entry = hermes_api._bot_queue_entry(3, "bot:" + "a" * 32, "queued", payload(text))
    assert entry["title"] == "Compare the two sources and tell me which is newer."
    assert entry["preview"].startswith("Compare the two sources") and "(Answer" not in entry["preview"]   # old apps keep working
    assert entry["from"] == "Puppet Master" and entry["sequence"] == 3 and entry["id"] == "bot:" + "a" * 32


def test_the_header_is_stripped_before_the_first_line_is_taken():
    header = "Message from 🤖 Research (@research): "
    entry = hermes_api._bot_queue_entry(1, "bot:" + "a" * 32, "queued", payload(header + "Find the licence\nof the pet source"))
    assert entry["title"] == "Find the licence"


@pytest.mark.parametrize("raw", ["not json", "[]", '{"private":"do not expose"}', "x" * 70000, '{"text": 5}', '{"text": ""}', "null"])
def test_an_unreadable_payload_gets_a_neutral_title_and_never_its_raw_content(raw):
    entry = hermes_api._bot_queue_entry(1, "bot:" + "a" * 32, "queued", raw)
    assert entry["title"] == "Details unavailable" and "private" not in json.dumps(entry)


# -- the hub joins titles onto the queue --------------------------------------------------------------------------------


def queue_row(delivery, text, sequence=1, suffix=""):
    return {"id": f"bot:{delivery}{suffix}", "sequence": sequence, "from": "Hermes", "preview": text[:120],
            "title": first_line_title(text), "status": "queued"}


@pytest.fixture
async def hub(store, tmp_path):
    h = Hub(store, web_root=tmp_path / "web")
    yield h
    await h.aclose()


async def snapshot(hub, rows):
    hub.activity_provider = lambda: {"chef": {"state": "working", "queued": len(rows), "queue": rows}}
    return (await hub.refresh_bot_activity(fresh=True))["chef"]["queue"]


async def test_a_queue_row_takes_the_title_from_the_matching_hand_off(hub, store):
    chat = store.create_chat("Jobs")
    mine, other = hexid(), hexid()
    store.register_handoff(mine, chat["id"], "chef", "Chef", "Long request text that nobody wants to read", 0, subject="Plan dinner")
    rows = await snapshot(hub, [queue_row(mine, "Long request text that nobody wants to read", 1),
                                queue_row(other, "Compare the sources\nplease", 2)])
    assert rows[0]["title"] == "Plan dinner"
    assert rows[1]["title"] == "Compare the sources"            # nothing in the ledger: the first line, as before


async def test_the_automatic_retry_of_a_hand_off_keeps_its_title(hub, store):
    chat = store.create_chat("Jobs")
    mine = hexid()
    store.register_handoff(mine, chat["id"], "chef", "Chef", "q", 0, subject="Plan dinner")
    rows = await snapshot(hub, [queue_row(mine, "q", 1, ":retry")])
    assert rows[0]["title"] == "Plan dinner"


async def test_a_title_that_is_not_in_the_ledger_for_this_row_is_never_guessed(hub, store):
    chat = store.create_chat("Jobs")
    a, b = hexid(), hexid()
    store.register_handoff(a, chat["id"], "chef", "Chef", "q", 0, subject="Title for A")
    rows = await snapshot(hub, [queue_row(b, "Request for B", 1)])
    assert rows[0]["title"] == "Request for B"                  # only an exact delivery-id match counts
    rows = await snapshot(hub, [{**queue_row(a, "Request for A", 1), "id": "bot:" + "f" * 32}])
    assert rows[0]["title"] == "Request for A"


async def test_the_title_is_cleaned_and_capped_on_the_way_out_whatever_the_ledger_holds(hub, store):
    chat = store.create_chat("Jobs")
    a = hexid()
    store.register_handoff(a, chat["id"], "chef", "Chef", "q", 0, subject="fine")
    store._exec("UPDATE handoffs SET subject=? WHERE delivery_id=?", ("<b>bold</b>\x07\u202e " + "y" * 300, a))
    title = (await snapshot(hub, [queue_row(a, "q", 1)]))[0]["title"]
    assert "\x07" not in title and "\u202e" not in title and len(title) <= TITLE_MAX
    assert title.startswith("<b>bold</b>")                       # kept as plain text: the app never renders markup


async def test_a_row_the_provider_malformed_does_not_break_the_snapshot(hub, store):
    rows = await snapshot(hub, [{"id": 5, "sequence": 1}, "nonsense", None, {"sequence": 2}, queue_row(hexid(), "ok", 3)])
    assert rows[-1]["title"] == "ok"


async def test_a_ledger_that_cannot_be_read_leaves_the_fallback_and_does_not_make_activity_unknown(hub, store, monkeypatch):
    monkeypatch.setattr(store, "handoff_subjects", lambda ids: (_ for _ in ()).throw(sqlite3.OperationalError("locked")))
    snap = await snapshot(hub, [queue_row(hexid(), "Plan dinner", 1)])
    assert snap[0]["title"] == "Plan dinner"
    assert hub._bot_activity["chef"]["state"] == "working"


async def test_a_provider_without_a_queue_or_titles_still_works(hub, store):
    hub.activity_provider = lambda: {"chef": {"state": "idle", "queued": 0}, "default": {"state": "unknown", "queued": None, "queue": None}}
    assert (await hub.refresh_bot_activity(fresh=True))["chef"] == {"state": "idle", "queued": 0}


async def test_the_titles_travel_in_the_owner_only_activity_broadcast(hub, store):
    chat = store.create_chat("Jobs")
    mine = hexid()
    store.register_handoff(mine, chat["id"], "chef", "Chef", "q", 0, subject="Plan dinner")
    events = []

    async def capture(event):
        events.append(event)
    hub._broadcast = capture
    await snapshot(hub, [queue_row(mine, "q", 1)])
    sent = [e for e in events if e.get("type") == "bot.activity"]
    assert sent and sent[-1]["activities"]["chef"]["queue"][0]["title"] == "Plan dinner"
