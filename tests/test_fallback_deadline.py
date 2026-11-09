"""The phone needs an absolute reset time: a relative count restarts whenever the app republishes."""
from types import SimpleNamespace

from plugin import fallback as fb

MID = ("⚠️ Model fallback: claude-sonnet-5-5 via anthropic unavailable (rate limit); "
       "using gpt-6.1-sol via openai-codex. Primary retry eligible in ~120 s; recovery is not guaranteed.")


def test_the_deadline_is_absolute_and_the_count_follows_it(monkeypatch):
    runner = SimpleNamespace()
    history = fb.FallbackHistory()
    monkeypatch.setattr(fb.time, "monotonic", lambda: 1000.0)
    monkeypatch.setattr(fb.time, "time", lambda: 1_700_000_000.0)
    history.notice(runner, "key", MID)

    first = history.read(runner, "key", None)["fallback"]
    assert first["retry_in_s"] == 120
    assert first["retry_at"] == 1_700_000_120, "the reset time is sent in wall-clock seconds"

    # Ten seconds later the count is lower and the deadline is unchanged: a republish cannot restart it.
    monkeypatch.setattr(fb.time, "monotonic", lambda: 1010.0)
    monkeypatch.setattr(fb.time, "time", lambda: 1_700_000_010.0)
    second = history.read(runner, "key", None)["fallback"]
    assert second["retry_in_s"] == 110
    assert second["retry_at"] == 1_700_000_120

    # Past the deadline both read zero; the phone shows "next message" rather than a stale timer.
    monkeypatch.setattr(fb.time, "monotonic", lambda: 1200.0)
    monkeypatch.setattr(fb.time, "time", lambda: 1_700_000_200.0)
    expired = history.read(runner, "key", None)["fallback"]
    assert expired["retry_in_s"] == 0
    assert expired["retry_at"] == 1_700_000_120


def test_a_fallback_without_a_cooldown_sends_no_deadline(monkeypatch):
    runner = SimpleNamespace()
    history = fb.FallbackHistory()
    monkeypatch.setattr(fb.time, "monotonic", lambda: 1000.0)
    history.notice(runner, "key", "⚠️ Provider fallback: anthropic/claude-sonnet-5-5 unavailable; "
                                  "using openai-codex/gpt-6.1-sol for this response.")
    state = history.read(runner, "key", None)["fallback"]
    assert state["retry_in_s"] is None
    assert "retry_at" not in state, "no cooldown means no invented deadline"
