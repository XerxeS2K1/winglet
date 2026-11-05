"""ask_bot through Hermes's own delivery code, end to end.

The unit tests in test_teamwork.py replace `_deliver` outright, so they can't notice when Hermes changes the
delivery door (that is how ask_bot silently vanished on Hermes 0.22.5). Here two profile homes exist on disk and
ask_bot runs unchanged: the real `find_canonical_live_owner`, `deliver_to_live_owner`, mailbox files and
`await_delivery`. Only the network call to the other bot's running gateway is stood in for, by a small fake that
accepts the delivery the way the real authority does and settles it a moment later.

Runs only where Hermes is installed (the CI job with Hermes).
"""

import importlib.util
import inspect
import json
import threading
import time
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(importlib.util.find_spec("tools") is None
                                or importlib.util.find_spec("hermes_cli") is None
                                or importlib.util.find_spec("hermes_state") is None,
                                reason="needs Hermes Agent installed")

from plugin import teamwork  # noqa: E402

ROSTER = [{"name": "default", "title": "Hermes", "description": "The main bot"},
          {"name": "chef", "title": "Chef", "description": "Plans meals"}]


@pytest.fixture
def two_bots(tmp_path, monkeypatch):
    """Profile homes for the main bot and `chef`, with a fake authority standing in for chef's live gateway."""
    from hermes_state import SessionDB
    from tools import bot_live_delivery as door

    homes = {"default": tmp_path / "home", "chef": tmp_path / "home" / "profiles" / "chef"}
    for home in homes.values():
        home.mkdir(parents=True)
        SessionDB(db_path=home / "state.db").close()  # a store with no Bot Chat yet, as a fresh profile has
    monkeypatch.setattr("hermes_cli.profiles.get_profile_dir", lambda name: homes[name])
    monkeypatch.setattr(teamwork, "_roster", lambda: [dict(b) for b in ROSTER])
    monkeypatch.setattr(teamwork, "_me", lambda: "default")

    import hermes_cli.gateway_runtime as runtime
    ready = SimpleNamespace(state="ready", endpoint=SimpleNamespace(instance_id="lease-1"))
    monkeypatch.setattr(runtime, "discover_gateway_endpoint", lambda home, timeout=5: ready)

    seen = SimpleNamespace(admitted=[], reply="Pasta on Tuesday.", status="settled", error="")

    def authority(home, params):
        """What chef's gateway does with a delivery: write the ticket, then settle it shortly after."""
        seen.admitted.append(params)
        with door._locked(home) as root:
            door._write(root / f"{params['id']}.json", {"status": "queued", "id": params["id"]})

        def finish():
            time.sleep(0.2)
            with door._locked(home) as root:
                record = door._read(root / f"{params['id']}.json")
                record["status"] = "claimed"
                door._write(root / f"{params['id']}.json", record)
            door.complete_delivery(home, params["id"], status=seen.status,
                                   reply=seen.reply if seen.status == "settled" else "", error=seen.error)
        threading.Thread(target=finish, daemon=True).start()
        return {"admitted": True}
    monkeypatch.setattr(door, "authority_delivery", authority)
    monkeypatch.setattr(door, "_POLL_SECONDS", 0.05)
    return seen


def test_ask_bot_gets_the_teammates_answer_through_hermes_delivery(two_bots):
    answer = json.loads(teamwork.ask_bot({"bot": "chef", "message": "What's for dinner?"}))
    assert answer.get("reply") == "Pasta on Tuesday." and "error" not in answer, answer
    (delivery,) = two_bots.admitted
    assert delivery["profile"] == "chef"
    assert "What's for dinner?" in delivery["message"]
    assert delivery["author"] == {"id": "bot:default", "name": "hermes", "is_bot": True}


def test_zero_wait_hands_off_through_real_receipt_code_without_resending(two_bots):
    from tools import bot_live_delivery as door
    from hermes_cli.profiles import get_profile_dir
    result = json.loads(teamwork.ask_bot({"bot": "chef", "message": "Long task", "wait": 0}))
    assert result['status'] == 'queued'
    assert len(two_bots.admitted) == 1
    assert two_bots.admitted[0]['id'] == result['delivery_id']
    receipt = door.await_delivery(get_profile_dir('chef'), result['delivery_id'], 2)
    assert receipt['reply'] == 'Pasta on Tuesday.'
    assert len(two_bots.admitted) == 1


def test_a_teammate_that_fails_is_reported_not_hung(two_bots):
    two_bots.status, two_bots.error = "failed", "model error"
    answer = json.loads(teamwork.ask_bot({"bot": "chef", "message": "Hello?"}))
    assert "error" in answer and "Chef" in answer["error"]


def test_a_gateway_that_isnt_running_is_said_plainly(two_bots, monkeypatch):
    import hermes_cli.gateway_runtime as runtime
    monkeypatch.setattr(runtime, "discover_gateway_endpoint",
                        lambda home, timeout=5: SimpleNamespace(state="stopped", endpoint=None))
    answer = json.loads(teamwork.ask_bot({"bot": "chef", "message": "Hello?"}))
    assert "isn't running" in answer["error"]
    assert not two_bots.admitted


def test_the_hermes_calls_ask_bot_makes_still_fit_their_signatures():
    """If Hermes renames or drops an argument, this fails here and not on the first live ask."""
    from tools import bot_live_delivery as door
    inspect.signature(door.find_canonical_live_owner).bind("home")
    inspect.signature(door.deliver_to_live_owner).bind("home", {}, "msg", delivery_id="a" * 32, author={})
    inspect.signature(door.settle_held_delivery).bind("home", {}, "msg", delivery_id="a" * 32, author={})
    inspect.signature(door.await_delivery).bind("home", "a" * 32, 1.0)
    assert teamwork.can_deliver() is True
