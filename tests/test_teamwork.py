"""Bots ask each other, and make new ones with the owner's approval (plugin/teamwork.py)."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from plugin import teamwork

ROSTER = [{"name": "default", "title": "Hermes", "description": "The main bot"},
          {"name": "chef", "title": "Chef", "description": "Plans meals"},
          {"name": "scout", "title": "Scout", "description": "Finds things"}]


@pytest.fixture
def team(monkeypatch):
    sent = []
    state = SimpleNamespace(me="default", result={"status": "settled", "reply": "Pasta on Tuesday.\n"},
                            sent=sent, senders=[])
    monkeypatch.setattr(teamwork, "_roster", lambda: [dict(b) for b in ROSTER])
    monkeypatch.setattr(teamwork, "_me", lambda: state.me)

    def deliver(profile, content, sender):
        sent.append((profile, content))
        state.senders.append(sender)
        if isinstance(state.result, Exception):
            raise state.result
        return state.result
    monkeypatch.setattr(teamwork, "_deliver", deliver)
    return state


def test_asking_a_teammate_returns_its_answer(team):
    listing = json.loads(teamwork.ask_bot({"bot": ""}))
    assert [b["name"] for b in listing["bots"]] == ["chef", "scout"]  # never itself
    reply = json.loads(teamwork.ask_bot({"bot": "Chef", "message": "What's for dinner this week?"}))
    assert reply == {"bot": "Chef", "reply": "Pasta on Tuesday."}
    # Signed the way Hermes's Bot Mode signs a teammate's message, into the teammate's own profile.
    assert [(b, m.split("\n\n")[0]) for b, m in team.sent] == [("chef", "Message from 🤖 Hermes (@hermes): What's for dinner this week?")]
    assert "do not message anyone" in team.sent[0][1]  # the teammate answers in its reply, not via a messaging tool
    assert team.senders == ["default"]  # the turn's author, for Hermes's memory


def test_a_teammate_can_ask_the_main_bot(team):
    team.me = "chef"
    json.loads(teamwork.ask_bot({"bot": "@hermes", "message": "Is Tuesday free?"}))
    assert team.sent[-1][0] == "default"
    assert team.sent[-1][1].startswith("Message from 🤖 Chef (@chef): Is Tuesday free?")
    assert "That's you" in json.loads(teamwork.ask_bot({"bot": "chef", "message": "hi"}))["error"]


def test_asking_goes_wrong_in_plain_words(team):
    assert "no bot called" in json.loads(teamwork.ask_bot({"bot": "ghost", "message": "hi"}))["error"]
    assert "message" in json.loads(teamwork.ask_bot({"bot": "chef"}))["error"]
    assert "too long" in json.loads(teamwork.ask_bot({"bot": "chef", "message": "x" * 9000}))["error"]
    team.result = {"status": "failed", "error": "No inference provider configured"}
    failed = json.loads(teamwork.ask_bot({"bot": "chef", "message": "hi"}))
    assert failed["error"] == "Chef couldn't answer." and "No inference provider" in failed["detail"]
    team.result = Exception("authority is not ready")
    assert "isn't running right now" in json.loads(teamwork.ask_bot({"bot": "chef", "message": "hi"}))["error"]


def test_making_a_bot_needs_the_owners_ok(monkeypatch):
    made, changed = [], []
    monkeypatch.setattr(teamwork.hermes_api, "create_bot",
                        lambda name, title, persona, description="": made.append((name, title, persona)) or
                        {"name": name, "title": title, "description": description})
    monkeypatch.setattr(teamwork, "on_bots_changed", lambda: changed.append(True))
    assert teamwork.approve_making_bots(tool_name="make_bot", args={"title": "Chef"}) == {
        "action": "approve", "message": "Make a new bot, Chef, with your provider keys and model?"}
    assert teamwork.approve_making_bots(tool_name="ask_bot", args={}) is None
    out = json.loads(teamwork.make_bot({"title": "Meal Planner", "purpose": "Plans the week's meals."}))
    assert out["made"]["name"] == "meal-planner" and changed == [True]
    assert made == [("meal-planner", "Meal Planner", "You are Meal Planner. Plans the week's meals.")]
    assert "short name" in json.loads(teamwork.make_bot({"title": "X", "name": "Not OK", "purpose": ""}))["error"]
    assert "short name" in json.loads(teamwork.make_bot({"title": "Main", "name": "default", "purpose": ""}))["error"]
    assert "title" in json.loads(teamwork.make_bot({"purpose": "x"}))["error"]


def test_the_tools_and_the_approval_gate_are_registered():
    tools, hooks = [], []
    ctx = SimpleNamespace(register_tool=lambda **kw: tools.append(kw), register_hook=lambda name, fn: hooks.append((name, fn)))
    teamwork.register(ctx)
    assert [t["name"] for t in tools] == ["ask_bot", "make_bot"] and {t["toolset"] for t in tools} == {"bots"}
    assert teamwork.can_deliver() == (importlib.util.find_spec("tui_gateway") is not None)
    assert hooks == [("pre_tool_call", teamwork.approve_making_bots)]
    teamwork.register(SimpleNamespace())  # a Hermes without plugin tools: never fatal


