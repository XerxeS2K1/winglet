"""Session-scoped fallback evidence, independent of Hermes's intentionally short-lived agent cache.

Only a recognised server status or Hermes's explicit fallback flag creates a record. Different model names never do.
Nothing is persisted: a gateway restart starts without fallback evidence, rather than replaying an old warning.
"""
from copy import deepcopy
import math
import re
import time

_MODEL = re.compile(
    r"Model fallback: (?P<from_model>\S+) via (?P<from_provider>\S+) unavailable "
    r"\((?P<reason>[^()\n]+)\); using (?P<model>\S+) via (?P<provider>[^\s]+?)\."
    r"(?: Primary retry eligible in ~(?P<seconds>\d+) s; recovery is not guaranteed\.)?$")
_PROVIDER = re.compile(
    r"Provider fallback: (?P<from_provider>[^/\s]+)/(?P<from_model>\S+) unavailable; "
    r"using (?P<provider>[^/\s]+)/(?P<model>\S+) for this response\.$")


def parse_notice(text):
    """Only the two known Hermes notice formats; the pre-agent one does not supply a reset time."""
    match = _MODEL.search(text or "")
    pre_agent = match is None
    match = match or _PROVIDER.search(text or "")
    if match is None:
        return None
    fields = match.groupdict()
    seconds = fields.get("seconds")
    state = {"active": True, "reason": fields.get("reason", "provider unavailable")[:80],
             "retry_in_s": int(seconds) if seconds is not None else None,
             "from_model": fields["from_model"], "from_provider": fields["from_provider"]}
    return {"model": fields["model"], "provider": fields["provider"], "source": "last_turn", "fallback": state}, pre_agent


def context(runner, key):
    """Remember session identity and only the non-secret /model route, never config or credential material."""
    store = getattr(runner, "session_store", None)
    peek = getattr(store, "peek_session_id", None)
    identity = peek(key) if callable(peek) else None
    override = (getattr(runner, "_session_model_overrides", None) or {}).get(key) or {}
    return identity, override.get("model"), override.get("provider")


class FallbackHistory:
    def __init__(self):
        self._records = {}

    def _remember(self, key, value, boundary, *, pre_agent=False):
        retry = value["fallback"].get("retry_in_s")
        self._records[key] = {"value": deepcopy(value), "context": boundary, "pre_agent": pre_agent,
                              "until": time.monotonic() + retry if retry is not None else None}

    def notice(self, runner, key, text):
        parsed = parse_notice(text)
        if key and parsed is not None:
            value, pre_agent = parsed
            self._remember(key, value, context(runner, key), pre_agent=pre_agent)

    def read(self, runner, key, current):
        boundary = context(runner, key)
        record = self._records.get(key)
        if record and record["context"] != boundary:
            self._records.pop(key, None)
            record = None
        if current and current.get("fallback"):
            current = deepcopy(current)
            if record and not current["fallback"].get("reason"):
                current["fallback"]["reason"] = record["value"]["fallback"]["reason"]
            self._remember(key, current, boundary)
            record = self._records[key]
        elif record:
            cached = getattr(runner, "_cached_agent_for", None)
            live = cached(key) if callable(cached) else None
            # An uncached last-resolved string is NOT recovery evidence. A pre-agent fallback's live
            # agent has no fallback flag, so its explicitly announced route remains valid too.
            same_pre_agent = (record["pre_agent"] and current and
                              (current["model"], current["provider"]) ==
                              (record["value"]["model"], record["value"]["provider"]))
            if live is not None and not same_pre_agent:
                self._records.pop(key, None)
                record = None
        if record is None:
            return current
        result = deepcopy(record["value"])
        if record["until"] is not None:
            result["fallback"]["retry_in_s"] = max(0, math.ceil(record["until"] - time.monotonic()))
        return result


def history_for(adapter):
    """Lazy for older/test-created adapters; each real profile adapter owns its own history."""
    history = getattr(adapter, "_fallback_history", None)
    if history is None:
        history = adapter._fallback_history = FallbackHistory()
    return history
