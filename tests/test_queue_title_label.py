"""A leading "TITLE: ..." line as the title of a hand-off that carries no title argument.

Hand-offs sent with Hermes's own message_agent tool never go through ask_bot, so they have no `title`. By convention the
sender can open the message with a line "TITLE: a few words"; the queue sheet then shows those words. A title given to
ask_bot still wins, and a request without the line falls back to its first line, exactly as before.
"""

import json
import uuid

import pytest

from plugin import hermes_api
from plugin.handoffs import TITLE_MAX, first_line_title
from plugin.hub import Hub
from plugin.store import Store

HEADER = "Message from 🤖 Puppet Master (@hermes), sent from the chat \"General\": "


@pytest.mark.parametrize("text,expected", [
    ("TITLE: Go on with queue titles\n\nPuppet Master: Kraig's go.", "Go on with queue titles"),
    ("title: lower case", "lower case"),
    ("Title: Mixed case", "Mixed case"),
    ("TITLE:no space after the colon", "no space after the colon"),
    ("TITLE :  space before and extra   inside  ", "space before and extra inside"),
    ("   TITLE: indented", "indented"),
    ("\n\n  \nTITLE: after blank lines", "after blank lines"),
    ("TITLE: Plan\x07 dinner\u202e now", "Plan dinner now"),
    ("TITLE: line\u2028break", "line"),          # U+2028 ends a line in a request, like a newline
])
def test_a_leading_title_line_becomes_the_title(text, expected):
    assert first_line_title(text) == expected


def test_a_long_label_title_is_cut_like_any_other_title():
    assert first_line_title("TITLE: " + "x" * 200) == "x" * TITLE_MAX
    cut = first_line_title("TITLE: " + "a" * 49 + " " + "b" * 30)
    assert cut == "a" * 49 and len(cut) <= TITLE_MAX


@pytest.mark.parametrize("text,expected", [
    ("TITLED: not a label", "TITLED: not a label"),
    ("Subtitle: not a label", "Subtitle: not a label"),
    ("My TITLE: not at the start", "My TITLE: not at the start"),
    ("Hello there\nTITLE: only the first line counts", "Hello there"),
    ("TITLE without a colon", "TITLE without a colon"),
    ("<TITLE>: markup", "<TITLE>: markup"),
])
def test_only_a_line_that_starts_with_the_label_counts(text, expected):
    assert first_line_title(text) == expected


@pytest.mark.parametrize("text,expected", [
    ("TITLE:\nPlan dinner\nand cook", "Plan dinner"),      # a bare label says nothing: the next line is the first line
    ("TITLE:   \n\n  Plan dinner", "Plan dinner"),
    ("TITLE:", ""), ("TITLE:  \x07 ", ""),
])
def test_a_label_with_nothing_after_it_is_ignored(text, expected):
    assert first_line_title(text) == expected


def payload(text):
    return json.dumps({"text": text, "local_automation_v1": {"turn_author": {"name": "Puppet Master", "is_bot": True}}})


def test_a_message_agent_style_request_gets_the_title_and_keeps_the_old_preview():
    text = HEADER + "TITLE: Queue titles\n\nPuppet Master here, with Kraig's yes. New small item.\n\n(Answer in your reply to this message.)"
    entry = hermes_api._bot_queue_entry(1, "bot:" + "a" * 32, "queued", payload(text))
    assert entry["title"] == "Queue titles"
    assert entry["preview"].startswith("TITLE: Queue titles")          # older apps keep the text they always showed


def test_without_the_line_the_first_line_is_used_as_before():
    text = HEADER + "Please compare the two sources and tell me which is newer.\nMore detail here."
    entry = hermes_api._bot_queue_entry(1, "bot:" + "a" * 32, "queued", payload(text))
    assert entry["title"] == "Please compare the two sources and tell me which is newer."


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
async def hub(store, tmp_path):
    h = Hub(store, web_root=tmp_path / "web")
    yield h
    await h.aclose()


async def rows_for(hub, delivery, text):
    entry = hermes_api._bot_queue_entry(1, f"bot:{delivery}", "queued", payload(HEADER + text))
    hub.activity_provider = lambda: {"chef": {"state": "working", "queued": 1, "queue": [entry]}}
    return (await hub.refresh_bot_activity(fresh=True))["chef"]["queue"]


async def test_a_title_given_to_ask_bot_wins_over_a_title_line(hub, store):
    chat = store.create_chat("Jobs")
    delivery = uuid.uuid4().hex
    store.register_handoff(delivery, chat["id"], "chef", "Chef", "q", 0, subject="From the argument")
    assert (await rows_for(hub, delivery, "TITLE: From the line\nbody"))[0]["title"] == "From the argument"


async def test_without_a_ledger_title_the_title_line_is_used(hub, store):
    assert (await rows_for(hub, uuid.uuid4().hex, "TITLE: From the line\nbody"))[0]["title"] == "From the line"


async def test_an_ask_bot_hand_off_without_a_title_argument_can_use_the_line_too(hub, store):
    chat = store.create_chat("Jobs")
    delivery = uuid.uuid4().hex
    store.register_handoff(delivery, chat["id"], "chef", "Chef", "q", 0)              # no subject
    assert (await rows_for(hub, delivery, "TITLE: Plan dinner\nfor six"))[0]["title"] == "Plan dinner"
