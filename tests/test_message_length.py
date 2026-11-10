"""A message that is too long is refused, never silently cut.

The phone had no length limit and the server sliced with ``[:MAX_TEXT]``, so a pasted 20,000-character
message became 16,000 on the server, the bubble shrank when the reply came back, and the tail was
never seen by the agent. A cut message is lost text the sender cannot see, so the server now refuses.
"""

import asyncio

import pytest

from plugin.branching import BranchRefused, plan_operation
from plugin.hub import MAX_TEXT, Hub, MessageRejected
from plugin.store import Store


@pytest.fixture
def env(tmp_path):
    store = Store(tmp_path / "winglet.db")
    hub = Hub(store, web_root=tmp_path / "web")
    owner, _ = store.add_device("Owner", "test", role="owner", verified=True)
    chat = store.create_chat("Long message test", owner_device=owner["id"])
    return hub, store, owner, chat


def test_a_message_over_the_limit_is_refused_and_nothing_is_stored(env):
    hub, store, owner, chat = env
    too_long = "x" * (MAX_TEXT + 1)

    with pytest.raises(MessageRejected) as caught:
        asyncio.run(hub.user_message(owner, chat["id"], too_long))

    said = str(caught.value)
    assert "not sent" in said
    # The count is in the error so the sender knows how far over they are.
    assert f"{MAX_TEXT + 1:,}" in said
    assert store.all_messages(chat["id"]) == []


def test_the_limit_is_readable_and_not_a_bare_number(env):
    hub, store, owner, chat = env
    with pytest.raises(MessageRejected) as caught:
        asyncio.run(hub.user_message(owner, chat["id"], "x" * (MAX_TEXT + 500)))
    assert f"{MAX_TEXT:,}" in str(caught.value)


def _messages():
    """The shape plan_operation expects: settled messages plus a transcript of snapshot rows."""
    messages = [
        {"id": "u1", "role": "user", "position": 1, "text": "one", "meta": {}, "status": "final",
         "created_at": 1, "updated_at": 1},
        {"id": "a1", "role": "bot", "position": 2, "text": "first", "meta": {}, "status": "final",
         "created_at": 1, "updated_at": 1},
    ]
    transcript = [
        {"role": "user", "content": "one", "message_id": "u1"},
        {"role": "assistant", "content": "first"},
    ]
    return messages, transcript


def test_a_branch_edit_over_the_limit_is_refused_not_cut():
    """plan_operation used to slice the replacement text and send a shorter prompt to Hermes."""
    messages, transcript = _messages()
    with pytest.raises(BranchRefused) as caught:
        plan_operation(messages, transcript, "u1", "edit", text="y" * (MAX_TEXT + 1))
    assert "characters or fewer" in str(caught.value)


def test_a_branch_edit_under_the_limit_keeps_the_whole_text():
    messages, transcript = _messages()
    text = "y" * MAX_TEXT
    plan = plan_operation(messages, transcript, "u1", "edit", text=text)
    assert plan.send_text == text
