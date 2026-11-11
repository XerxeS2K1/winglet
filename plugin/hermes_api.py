"""The one place Winglet touches Hermes internals.

Hermes moves quickly, and its internal modules aren't a stable API. Every import of ``hermes_cli``,
``agent``, ``cron`` or ``gateway`` internals that a feature depends on lives here, wrapped so that a
missing or renamed function turns that one feature off instead of breaking the plugin.
"""

from __future__ import annotations

import contextlib
import contextvars
import functools
import hashlib
import io
import json
import logging
import math
import re
import shutil
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


@functools.lru_cache(maxsize=1)
def hermes_version() -> str:
    """Human-readable Hermes version, or "" if this Hermes can't say. Read once: it may run git."""
    try:
        from hermes_cli.version_info import get_version_info
        info = get_version_info()
        for value in (getattr(info, "base_version", ""), getattr(info, "derived_version", "")):
            if value and value != "unknown":
                return str(value)
    except Exception:
        logger.debug("[winglet] version_info unavailable", exc_info=True)
    try:
        from hermes_cli import __release_date__
        return str(__release_date__)
    except Exception:
        return ""


async def cache_media(path: str, name: str, mime: str, voice: bool = False):
    """Hand an uploaded file to Hermes's own media cache, the same way Telegram or Slack do.
    Returns (cached path, media type, kind)."""
    import asyncio
    from pathlib import Path
    try:
        from gateway.platforms.base import cache_media_bytes_async
    except Exception as exc:
        raise HermesUnavailable("attachments unavailable") from exc
    data = await asyncio.to_thread(Path(path).read_bytes)
    if voice:
        # Hermes files .webm under video by its extension; a voice note is always audio, so it goes
        # straight to the audio cache, where speech-to-text picks it up.
        try:
            from gateway.platforms.base import cache_audio_from_bytes_async
        except Exception as exc:
            raise HermesUnavailable("voice attachments unavailable") from exc
        ext = Path(name).suffix.lower()
        ext = {".mp4": ".m4a", "": ".ogg"}.get(ext, ext)
        return await cache_audio_from_bytes_async(data, ext=ext), mime, "audio"
    cached = await cache_media_bytes_async(data, filename=name, mime_type=mime)
    if cached is None:
        raise ValueError(f"Hermes could not read {name} as {mime}")
    return cached.path, cached.media_type, cached.kind


# -- hands-free voice: the profile's own speech-to-text and text-to-speech --------------------
#
# Winglet's live voice is turn-based: the app records one utterance, this server transcribes it
# with the same provider chain Hermes uses for voice notes, the transcript becomes a normal chat
# message, and the finished reply is synthesized with the same TTS chain as `/speak`. The app
# never receives provider keys. Both operations run off the event loop under the profile's scope.

_SPEECH_MIME_BY_EXT = {
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
    ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
}


def speech_available() -> bool:
    """Whether this Hermes has the two functions the voice loop calls. A missing one leaves the
    capability false rather than half-working."""
    try:
        from tools.voice_mode import transcribe_recording
        from tools.tts_tool import text_to_speech_tool
    except Exception:
        logger.debug("[winglet] speech functions unavailable")
        return False
    return callable(transcribe_recording) and callable(text_to_speech_tool)


def _speech_error(message: str) -> str:
    """A user-facing reason, on one line and short enough for a phone toast."""
    # Provider responses may embed credentials, signed URLs or private request bodies.
    return "Speech provider failed. Check the configured speech provider and try again."


class SpeechBackend:
    """One object the hub can call without importing Hermes itself (plugin/live_voice.py)."""

    def __init__(self) -> None:
        self._available: Optional[bool] = None

    def available(self) -> bool:
        if self._available is None:
            self._available = speech_available()
        return self._available

    def status(self) -> dict:
        """Configured provider names for the app's explicit provider choice (never secrets)."""
        out = {"stt": {"provider": ""}, "tts": {"provider": ""}}
        try:
            from tools.transcription_tools import _get_provider as stt_provider, _load_stt_config
            with _profile_scope():
                out["stt"]["provider"] = str(stt_provider(_load_stt_config()) or "")
        except Exception:
            logger.debug("[winglet] could not read the STT provider")
        try:
            from tools.tts_tool import _get_provider as tts_provider, _load_tts_config
            with _profile_scope():
                out["tts"]["provider"] = str(tts_provider(_load_tts_config()) or "")
        except Exception:
            logger.debug("[winglet] could not read the TTS provider")
        return out

    async def transcribe(self, path: str, mime: str) -> dict:
        """A whole utterance as text. An empty transcript is silence, not a failure."""
        import asyncio

        def run() -> dict:
            with _profile_scope():
                from tools.voice_mode import transcribe_recording
                return transcribe_recording(path)

        try:
            result = await asyncio.to_thread(run)
        except Exception as exc:
            logger.warning("[winglet] speech-to-text provider failed")
            raise ValueError(_speech_error(f"Transcription failed: {exc}")) from exc
        if not isinstance(result, dict):
            raise ValueError("Transcription failed: unexpected response.")
        if not result.get("success"):
            error = str(result.get("error") or "Transcription failed.")
            # Hermes's own audio bridge treats "empty transcript" as silence: a quiet room should
            # re-listen, not show a failure card.
            if "empty transcript" in error.lower():
                return {"text": "", "provider": str(result.get("provider") or ""), "no_speech": True}
            raise ValueError(_speech_error(error))
        text = str(result.get("transcript") or "").strip()
        return {"text": text, "provider": str(result.get("provider") or ""), "no_speech": not text}

    async def speak(self, text: str) -> tuple:
        """Synthesized audio as (bytes, mime, provider). The temporary file is always removed."""
        import asyncio

        def run() -> tuple:
            import os
            from pathlib import Path

            with _profile_scope():
                from tools.tts_tool import text_to_speech_tool
                raw = text_to_speech_tool(text=text)
                try:
                    payload = json.loads(raw) if isinstance(raw, str) else raw
                except (TypeError, ValueError) as exc:
                    raise ValueError("Speech synthesis returned an unreadable response.") from exc
                if not isinstance(payload, dict) or not payload.get("success"):
                    error = payload.get("error") if isinstance(payload, dict) else ""
                    raise ValueError(_speech_error(str(error or "Speech synthesis failed.")))
                paths = [p for p in (payload.get("file_paths") or [payload.get("file_path")]) if p]
                if not paths:
                    raise ValueError("Speech synthesis returned no audio.")
                first = Path(paths[0])
                try:
                    if len(paths) != 1:
                        raise ValueError(_speech_error("The provider returned multiple audio files."))
                    data = first.read_bytes()
                finally:
                    for name in paths:
                        try:
                            os.unlink(name)
                        except OSError:
                            pass
                if not data:
                    raise ValueError("Speech synthesis returned empty audio.")
                mime = _SPEECH_MIME_BY_EXT.get(first.suffix.lower(), "audio/mpeg")
                return data, mime, str(payload.get("provider") or "")

        return await asyncio.to_thread(run)


def list_commands() -> list:
    """Gateway slash commands and skill commands, for the app's command palette."""
    with _profile_scope():  # each bot has its own skills, so its own commands
        out = []
        try:
            from hermes_cli.commands import COMMAND_REGISTRY, _is_gateway_available, _resolve_config_gates
            gates = _resolve_config_gates()
            for cmd in COMMAND_REGISTRY:
                if not _is_gateway_available(cmd, gates):
                    continue
                out.append({"cmd": f"/{cmd.name}", "hint": cmd.describe(), "args": cmd.args_hint or "",
                            "category": cmd.category, "kind": "command"})
        except Exception:
            logger.debug("[winglet] command registry unavailable", exc_info=True)
        try:
            from agent.skill_commands import get_skill_commands
            for key, meta in sorted((get_skill_commands() or {}).items()):
                name = key if str(key).startswith("/") else f"/{key}"
                out.append({"cmd": name, "hint": str((meta or {}).get("description") or "Skill")[:160], "args": "",
                            "category": "Skills", "kind": "skill"})
        except Exception:
            logger.debug("[winglet] skill commands unavailable", exc_info=True)
        return out


def resolve_command(name: str) -> str:
    """Hermes's canonical name for a typed command or alias ("reset" -> "new"), or "" if unknown."""
    try:
        from hermes_cli.commands import resolve_command as _resolve
        cmd = _resolve(name)
        return cmd.name if cmd is not None else ""
    except Exception:
        logger.debug("[winglet] command registry unavailable", exc_info=True)
        return ""


# -- your agent: model, providers, persona, memory, usage ------------------------------------
#
# These mirror what Hermes's own dashboard does, calling the same functions rather than its HTTP
# routes. Each raises HermesUnavailable when this Hermes doesn't have the function, so the hub can
# turn the feature off instead of failing.


# The bot (Hermes profile) the current request is about; None is the profile this gateway runs as.
# Set per request by the hub; asyncio.to_thread copies it to the worker thread.
_BOT: contextvars.ContextVar = contextvars.ContextVar("winglet_bot", default=None)


def set_bot(name: Optional[str]) -> contextvars.Token:
    return _BOT.set(name or None)


def reset_bot(token: contextvars.Token) -> None:
    _BOT.reset(token)


def current_bot() -> Optional[str]:
    return _BOT.get()


@contextlib.contextmanager
def _bot_scope(name: str):
    """Config, skills, memory and secrets of another profile this gateway serves, the way Hermes scopes a
    routed turn."""
    from hermes_cli.profiles import get_profile_dir
    home = get_profile_dir(name)
    try:
        from gateway.run import _profile_runtime_scope
    except Exception:
        _profile_runtime_scope = None
    if _profile_runtime_scope is not None:
        with _profile_runtime_scope(home):
            yield
        return
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


@contextlib.contextmanager
def _profile_scope():
    """Read this profile's secrets the way Hermes's own turns do. A gateway that serves several
    profiles refuses unscoped secret reads, and these functions run on worker threads. For another
    bot, everything is that bot's profile."""
    bot = _BOT.get()
    if bot:
        with _bot_scope(bot):
            yield
        return
    try:
        from agent.secret_scope import build_profile_secret_scope, current_secret_scope, reset_secret_scope, set_secret_scope
        from hermes_constants import get_hermes_home
    except Exception:
        yield
        return
    if current_secret_scope() is not None:
        yield
        return
    home = get_hermes_home()
    token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(token)


def _scoped(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _profile_scope():
            return fn(*args, **kwargs)
    return wrapper


class HermesUnavailable(RuntimeError):
    """This Hermes version doesn't offer the function a feature needs."""


class HermesRefused(ValueError):
    """Hermes rejected the request (a bad model, a rejected key); the message is for the user."""


def _detail(exc: Exception) -> str:
    return str(getattr(exc, "detail", "") or exc)


@_scoped
def configured_model() -> dict:
    """The model new chats start with, from config.yaml."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
    except Exception as exc:
        raise HermesUnavailable("config unavailable") from exc
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, dict):
        model, provider = model_cfg.get("default", model_cfg.get("name", "")), model_cfg.get("provider", "")
    else:
        model, provider = (str(model_cfg) if model_cfg else ""), ""
    agent = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    return {"model": str(model or ""), "provider": str(provider or ""),
            "reasoning_effort": str(agent.get("reasoning_effort") or ""), "label": provider_label(str(provider or ""))}


def provider_label(slug: str) -> str:
    try:
        from hermes_cli.providers import get_label
        return str(get_label(slug) or slug)
    except Exception:
        return slug


_FALLBACK_NOTICE = re.compile(r"Model fallback:.*?unavailable \((?P<reason>[^()]+)\); using", re.S)


def fallback_reason(notice: str) -> str:
    """The reason Hermes gave in its "Model fallback: X unavailable (<reason>); using Y" notice, or
    "" when the wording is not recognised (the strip then just says "Fallback")."""
    found = _FALLBACK_NOTICE.search(notice or "")
    return found.group("reason").strip()[:80] if found else ""


def fallback_state(agent, now: Optional[float] = None) -> Optional[dict]:
    """Whether this agent is on a fallback model, and when Hermes will try the primary again.

    Hermes only retries the primary at the start of a turn. Rate-limit and billing failures set a
    cooldown (``_rate_limited_until``, monotonic); other failures set none, so the next message
    retries. ``retry_in_s`` is the seconds left on a cooldown (0 once it has passed) and None when
    there is no cooldown. The reason text is not kept on the agent; the adapter adds it."""
    try:
        if not getattr(agent, "_provider_fallback_active", False):
            return None
        primary = getattr(agent, "_primary_runtime", None) or {}
        until = getattr(agent, "_rate_limited_until", 0) or 0
        clock = time.monotonic() if now is None else now
        retry = max(0, math.ceil(until - clock)) if until else None
        return {"active": True, "reason": "", "retry_in_s": retry,
                "from_model": str(primary.get("model") or ""), "from_provider": str(primary.get("provider") or "")}
    except Exception:
        logger.debug("[winglet] fallback state unavailable", exc_info=True)
        return None


def chat_model(runner, session_key: str) -> Optional[dict]:
    """The model a chat is really using, when Hermes knows: a /model switch for this chat, or the
    model its last turn resolved to (a fallback can change it). None means "the configured one"."""
    try:
        cached = getattr(runner, "_cached_agent_for", None)
        agent = cached(session_key) if callable(cached) else None
        if agent is not None and isinstance(getattr(agent, "model", None), str) and agent.model:
            found = {"model": agent.model, "provider": str(getattr(agent, "provider", "") or ""), "source": "last_turn"}
            fallback = fallback_state(agent)
            if fallback is not None:
                found["fallback"] = fallback
            return found
        override = (getattr(runner, "_session_model_overrides", None) or {}).get(session_key)
        if isinstance(override, dict) and override.get("model"):
            return {"model": str(override["model"]), "provider": str(override.get("provider") or ""), "source": "chat"}
        last = (getattr(runner, "_last_resolved_model", None) or {}).get(session_key)
        if last:
            return {"model": str(last), "provider": "", "source": "last_turn"}
    except Exception:
        logger.debug("[winglet] session model unavailable", exc_info=True)
    return None


@_scoped
def model_options(include_unconfigured: bool = False) -> dict:
    """Providers and their models, the same list Hermes's model pickers show."""
    try:
        from hermes_cli.inventory import build_model_options_payload, load_picker_context
    except Exception as exc:
        raise HermesUnavailable("model inventory unavailable") from exc
    payload = build_model_options_payload(load_picker_context(), include_unconfigured=include_unconfigured)
    providers = []
    for p in payload.get("providers") or []:
        models = list(dict.fromkeys(m if isinstance(m, str) else str((m or {}).get("id") or "")
                                    for m in (p.get("models") or [])))
        providers.append({"slug": p.get("slug", ""), "name": p.get("name") or p.get("slug", ""),
                          "authenticated": bool(p.get("authenticated")), "is_current": bool(p.get("is_current")),
                          "auth_type": p.get("auth_type", ""), "key_env": p.get("key_env", ""),
                          "models": [m for m in models if m], "total_models": p.get("total_models") or len(models),
                          "warning": p.get("warning", ""), "custom_models": True})
    return {"model": payload.get("model", ""), "provider": payload.get("provider", ""), "providers": providers}


@_scoped
def set_default_model(provider: str, model: str, *, confirm: bool = False) -> dict:
    """Make ``model`` the default for new chats, with Hermes's own validation and its warning for
    expensive models (returned as ``confirm_required`` until the user confirms)."""
    try:
        from hermes_cli.web_server_config import _apply_model_assignment_sync, _prepare_main_assignment
        from hermes_cli.config import load_config
        from hermes_cli.web_routers._common import _CONFIG_MUTATION_LOCK
    except Exception as exc:
        raise HermesUnavailable("model assignment unavailable") from exc
    if not confirm:
        try:
            from hermes_cli.model_selection_guards import combined_selection_warning
            warning = combined_selection_warning(model, provider=provider, base_url="")
        except Exception:
            warning = None
        if warning is not None:
            return {"ok": False, "confirm_required": True, "confirm_message": str(getattr(warning, "message", warning))}
    try:
        prepared = _prepare_main_assignment(load_config(), provider, model, "", "")
        # Hermes's own route prepares outside this lock, then applies and saves under it.
        with _CONFIG_MUTATION_LOCK:
            result = _apply_model_assignment_sync("main", provider, model, "", "", "", prepared=prepared)
    except Exception as exc:
        if type(exc).__name__ == "HTTPException" or isinstance(exc, ValueError):
            raise HermesRefused(_detail(exc)) from exc
        raise
    return {"ok": True, "provider": result.get("provider", provider), "model": result.get("model", model)}


# Cheap read-only calls that reject a bad key, as Hermes's dashboard uses before saving one.
_KEY_PROBES = {
    "OPENROUTER_API_KEY": ("https://openrouter.ai/api/v1/key", "bearer"),
    "OPENAI_API_KEY": ("https://api.openai.com/v1/models", "bearer"),
    "XAI_API_KEY": ("https://api.x.ai/v1/models", "bearer"),
    "ANTHROPIC_API_KEY": ("https://api.anthropic.com/v1/models", "x-api-key"),
    "GEMINI_API_KEY": ("https://generativelanguage.googleapis.com/v1beta/models", "query"),
}


async def check_provider_key(env_var: str, value: str) -> dict:
    """{ok, reachable, message}: ok=False with reachable=True means the provider rejected the key."""
    probe = _KEY_PROBES.get(env_var)
    if not probe:
        return {"ok": True, "reachable": False, "message": ""}
    import httpx
    url, auth = probe
    headers, params = {"Accept": "application/json"}, {}
    if auth == "bearer":
        headers["Authorization"] = f"Bearer {value}"
    elif auth == "x-api-key":
        headers.update({"x-api-key": value, "anthropic-version": "2023-06-01"})
    else:
        params["key"] = value
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers, params=params)
    except Exception:
        return {"ok": True, "reachable": False, "message": "Couldn't reach the provider to check the key; saved anyway."}
    if resp.status_code in (401, 403):
        return {"ok": False, "reachable": True, "message": "The provider rejected that key. Check it and try again."}
    return {"ok": True, "reachable": True, "message": ""}


@_scoped
def save_provider_key(env_var: str, value: str) -> None:
    try:
        from hermes_cli.credential_lifecycle import save_provider_env_credential
    except Exception as exc:
        raise HermesUnavailable("credential storage unavailable") from exc
    save_provider_env_credential(env_var, value)


@_scoped
def remove_provider_key(env_var: str) -> bool:
    try:
        from hermes_cli.credential_lifecycle import remove_provider_env_credential
    except Exception as exc:
        raise HermesUnavailable("credential storage unavailable") from exc
    return bool((remove_provider_env_credential(env_var) or {}).get("found", True))


def _home():
    from hermes_constants import get_hermes_home
    return get_hermes_home()


@_scoped
def read_persona() -> dict:
    path = _home() / "SOUL.md"
    if not path.exists():
        return {"content": "", "exists": False}
    return {"content": path.read_text(encoding="utf-8-sig"), "exists": True}


@_scoped
def write_persona(content: str) -> None:
    path = _home() / "SOUL.md"
    try:
        from utils import atomic_write_text
        atomic_write_text(path, content, preserve_mode=True, create_mode=0o644)
    except ImportError:
        tmp = path.with_suffix(".md.tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)


def _memory_store():
    try:
        from tools.memory_tool import load_on_disk_store
    except Exception as exc:
        raise HermesUnavailable("memory unavailable") from exc
    return load_on_disk_store()


@_scoped
def memory() -> dict:
    """What the agent remembers: notes about its world (MEMORY.md) and about you (USER.md)."""
    store = _memory_store()
    out = {}
    for target in ("memory", "user"):
        entries = list(getattr(store, f"{target}_entries", None) or store._entries_for(target))
        try:
            limit = store._char_limit(target)
        except Exception:
            limit = 0
        out[target] = {"entries": entries, "enabled": bool(store.target_enabled(target)), "limit": limit,
                       "used": len("\n§\n".join(entries))}
    return out


@_scoped
def edit_memory(action: str, target: str, entry: str = "", content: str = "") -> dict:
    """Add, replace or remove one memory entry through Hermes's own store (its limits and its scan
    for prompt-injection content apply)."""
    if target not in ("memory", "user") or action not in ("add", "replace", "remove"):
        raise HermesRefused("unknown memory action")
    store = _memory_store()
    if action == "add":
        result = store.add(target, content)
    elif action == "replace":
        result = store.replace(target, entry, content, matched_entry=entry)
    else:
        result = store.remove(target, entry, matched_entry=entry)
    if not result.get("success", False):
        raise HermesRefused(str(result.get("error") or "Hermes didn't accept that change."))
    return memory()


@_scoped
def usage(days: int = 30) -> dict:
    """Tokens and cost per day and per model, as Hermes's dashboard reports them."""
    try:
        from hermes_cli.web_routers.analytics import _get_usage_analytics
    except Exception as exc:
        raise HermesUnavailable("usage analytics unavailable") from exc
    data = _get_usage_analytics(max(1, min(int(days), 365)))
    keep = ("daily", "by_model", "totals", "period_days")
    return {k: data.get(k) for k in keep if k in data} if isinstance(data, dict) else {}


USAGE_HOURS_DEFAULT_DAYS = 7
USAGE_HOURS_MAX_DAYS = 40


def usage_hour_rows(grouped) -> List[List[int]]:
    """Shape rows already grouped by hour into ``[hour, input, output, cache_read, cache_write, calls,
    cost_cents]``. Pure: ints only, a missing value becomes 0, hours with no tokens and no calls are
    left out, and the result is oldest first. Cost is in hundredths of the currency Hermes recorded
    (USD), rounded once per hour so many tiny calls do not each round to nothing."""
    out: List[List[int]] = []
    for row in grouped:
        hour, *numbers = row
        if hour is None:
            continue
        numbers = list(numbers) + [0] * (6 - len(numbers))
        tokens_in, tokens_out, cache_read, cache_write, calls = (int(n or 0) for n in numbers[:5])
        cost = float(numbers[5] or 0)
        if not (tokens_in or tokens_out or cache_read or cache_write or calls):
            continue
        out.append([int(hour), tokens_in, tokens_out, cache_read, cache_write, calls, int(round(cost * 100))])
    out.sort(key=lambda r: r[0])
    return out


@_scoped
def usage_hours(days: int = USAGE_HOURS_DEFAULT_DAYS, *, now: Optional[float] = None,
                db_path: Optional[Path] = None) -> dict:
    """Tokens, calls and cost per UTC hour from Hermes's ``session_model_usage`` table.

    ``{from, to, hours: [[hour_start, input, output, cache_read, cache_write, calls, cost_cents]]}``,
    a sparse list, integers only. ``days`` is clamped to 1..40 and the window starts on an hour
    boundary so no hour is partial at the old end.

    Each row records a session's running total for one model, with the time it was last written. A
    row's tokens therefore land in the hour of ``last_seen``: a long session is attributed to when it
    last wrote, not spread over the hours it ran. That is an approximation, the honest one the table
    allows. Cost is ``actual_cost_usd`` when it is above zero (Hermes stores 0, not NULL, when no bill
    was measured), otherwise ``estimated_cost_usd``.

    The database is opened read-only for this one query and closed straight after, so nothing holds a
    connection or a lock on Hermes's file. If it is missing, locked or mid-migration, the answer is an
    empty series and a logged warning rather than an error.
    """
    days = max(1, min(int(days), USAGE_HOURS_MAX_DAYS))
    to = int(time.time() if now is None else now)
    start = (to // 3600) * 3600 - days * 86400
    result = {"from": start, "to": to, "hours": []}
    try:
        path = Path(db_path) if db_path is not None else _home() / "state.db"
        # SQLite does the bucketing: one summed row per hour comes back, never a row per call.
        with contextlib.closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=1.0)) as db:
            grouped = db.execute(
                "SELECT CAST(last_seen / 3600 AS INTEGER) * 3600 AS hour, "
                "SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)), "
                "SUM(COALESCE(cache_read_tokens, 0)), SUM(COALESCE(cache_write_tokens, 0)), "
                "SUM(COALESCE(api_call_count, 0)), "
                "SUM(COALESCE(NULLIF(actual_cost_usd, 0), estimated_cost_usd, 0)) "
                "FROM session_model_usage WHERE last_seen >= ? AND last_seen < ? "
                "GROUP BY hour ORDER BY hour", (start, to + 3600)).fetchall()
    except (sqlite3.Error, OSError, ImportError, ValueError) as exc:
        logger.warning("usage by hour unavailable: %s", exc)
        return result
    result["hours"] = usage_hour_rows(grouped)
    return result


async def resolve_slash_confirm(session_key: str, confirm_id: str, choice: str) -> str:
    try:
        from tools import slash_confirm
    except Exception as exc:
        raise HermesUnavailable("slash confirm unavailable") from exc
    return str(await slash_confirm.resolve(session_key, confirm_id, choice) or "")


# -- control center: health, pause, restart, updates, logs, schedule ------------------------


def system_stats() -> dict:
    """Host health for owners: CPU, memory, disk and uptime, without hostnames or paths."""
    import os
    import platform
    import time as _time
    info: dict = {"system": platform.system(), "arch": platform.machine(), "cpu_count": os.cpu_count()}
    try:
        import psutil
        vm = psutil.virtual_memory()
        info["memory"] = {"total": vm.total, "used": vm.used, "percent": vm.percent}
        du = psutil.disk_usage(str(_home()))
        info["disk"] = {"total": du.total, "used": du.used, "percent": du.percent}
        info["cpu_percent"] = psutil.cpu_percent(interval=0.1)
        info["uptime_seconds"] = int(_time.time() - psutil.boot_time())
    except Exception:
        try:
            info["load_avg"] = list(os.getloadavg())
        except (OSError, AttributeError):
            pass
    return info


def paused() -> Optional[dict]:
    """Whether new work is on hold (Hermes's /pause): {reason, engaged_at}, or None."""
    try:
        from agent import estop
    except Exception as exc:
        raise HermesUnavailable("pause unavailable") from exc
    return estop.get_state()


def set_paused(on: bool, reason: str = "") -> Optional[dict]:
    """Hold or release new work. Like ``paused()``, a Hermes without this switch is "unavailable", never a crash."""
    try:
        from agent import estop
        change = estop.engage if on else estop.disengage
        read = estop.get_state
    except Exception as exc:  # ImportError, or the module is there but a function was renamed
        raise HermesUnavailable("pause unavailable") from exc
    if on:
        change(reason or "paused from Winglet")
    else:
        change()
    return read()


def spawn_restart() -> int:
    """Restart this profile's gateway the way `hermes gateway restart` does, in a detached process
    (it stops this one). Returns the child's pid."""
    try:
        from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action
    except Exception as exc:
        raise HermesUnavailable("restart unavailable") from exc
    return _spawn_hermes_action(_gateway_subcommand(None, "restart"), "gateway-restart").pid


async def start_hermes_update() -> dict:
    """Start `hermes update` the way the dashboard's button does, with the same checks for installs that
    can't update in place. {ok, action_id} or {ok: False, message, update_command}."""
    try:
        from hermes_cli.web_routers.actions import update_hermes
    except Exception as exc:
        raise HermesUnavailable("update unavailable") from exc
    with _profile_scope():
        return dict(await update_hermes())


async def hermes_update_status() -> dict:
    """{running, exit_code, lines, action_id, receipt}: Hermes's own record of the last update, which
    survives the restart the update ends with."""
    try:
        from hermes_cli.web_routers.actions import get_action_status
    except Exception as exc:
        raise HermesUnavailable("update status unavailable") from exc
    with _profile_scope():
        return dict(await get_action_status("hermes-update", lines=40))


async def check_hermes_update(force: bool = False) -> dict:
    """{install_method, current_version, behind, update_available, can_apply, update_command, message}."""
    try:
        from hermes_cli.web_routers.actions import check_hermes_update as _check
    except Exception as exc:
        raise HermesUnavailable("update check unavailable") from exc
    with _profile_scope():
        return dict(await _check(force=force))


def _plugin_dir():
    from pathlib import Path
    return Path(__file__).resolve().parent


# -- which Winglet release is the newest -------------------------------------------------------------------
#
# The server decides this itself, from the GitHub releases of ONE hard-coded repository. The phone never names a
# repository, a branch or a commit. Hermes's own update check (run_checks) is not used for this answer: it reports
# "provenance drift" for every sub-directory install, which is how Winglet is installed.

RELEASE_REPO = "XerxeS2K1/winglet"
RELEASE_CACHE_SECONDS = 600
_API_PREFIX = f"https://api.github.com/repos/{RELEASE_REPO}/"
_RAW_PREFIX = f"https://raw.githubusercontent.com/{RELEASE_REPO}/"
_DOWNLOAD_PREFIX = f"https://github.com/{RELEASE_REPO}/releases/download/"
# GitHub redirects a release download to its asset CDN; the host it redirects to has changed before
# (objects. → release-assets.), and a miss here refuses every self-update with "redirect outside".
_ASSET_REDIRECT_PREFIXES = ("https://objects.githubusercontent.com/", "https://github-releases.githubusercontent.com/",
                            "https://release-assets.githubusercontent.com/")
_MAX_GITHUB_BYTES = 1_000_000
_MAX_ASSET_BYTES = 32 * 1024 * 1024
_VERSION = re.compile(r"(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\Z")
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_RELEASE_CACHE: dict = {}


class ReleaseCheckFailed(RuntimeError):
    """GitHub could not be asked, or its answer was not something a release can be built from."""


def parse_version(text) -> Optional[tuple]:
    """(major, minor, patch) for a plain ``1.2.3``; None for anything else (pre-releases, ``v`` prefixes, junk)."""
    if not isinstance(text, str):
        return None
    match = _VERSION.match(text)
    return tuple(int(part) for part in match.groups()) if match else None


def parse_tag(tag) -> Optional[tuple]:
    """The version of a release tag ``v1.2.3``; None for beta/rc tags, branches and everything else."""
    return parse_version(tag[1:]) if isinstance(tag, str) and tag.startswith("v") else None


def is_newer(candidate, current) -> bool:
    """A real, numeric 'newer than'. A version that cannot be read is never newer (unknown is not an upgrade)."""
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b


def _url_allowed(url, *, asset_redirect: bool = False) -> bool:
    prefixes = (_API_PREFIX, _RAW_PREFIX, _DOWNLOAD_PREFIX) + (_ASSET_REDIRECT_PREFIXES if asset_redirect else ())
    return (isinstance(url, str) and url.startswith(prefixes) and ".." not in url
            and not any(c.isspace() or c == "\\" or ord(c) < 32 for c in url))


class _SameRepoRedirect(urllib.request.HTTPRedirectHandler):
    """GitHub may move an address; it may not send us to a different repository or host."""

    def __init__(self, *, asset_redirect: bool = False):
        self.asset_redirect = asset_redirect

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _url_allowed(newurl, asset_redirect=self.asset_redirect):
            raise urllib.error.URLError(f"redirect outside {RELEASE_REPO} refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _github_get(url: str, *, text: bool = False):
    """One bounded GET to the Winglet repository on GitHub: parsed JSON, or text with ``text=True``."""
    if not _url_allowed(url):
        raise ReleaseCheckFailed("that address is not part of the Winglet repository")
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "winglet-plugin",
                                                   "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.build_opener(_SameRepoRedirect()).open(request, timeout=10) as response:
            data = response.read(_MAX_GITHUB_BYTES + 1)
        if len(data) > _MAX_GITHUB_BYTES:
            raise ReleaseCheckFailed("GitHub's answer was unexpectedly large")
        return data.decode("utf-8") if text else json.loads(data)
    except ReleaseCheckFailed:
        raise
    except (OSError, ValueError) as exc:  # URLError and HTTPError are OSErrors; bad JSON and bad UTF-8 are ValueErrors
        raise ReleaseCheckFailed(f"GitHub could not be read: {exc}") from exc


def _github_bytes(url: str) -> bytes:
    """One bounded GET for a release asset, only from the Winglet repository."""
    if not _url_allowed(url):
        raise ReleaseCheckFailed("that address is not part of the Winglet repository")
    request = urllib.request.Request(url, headers={"User-Agent": "winglet-plugin"})
    try:
        with urllib.request.build_opener(_SameRepoRedirect(asset_redirect=True)).open(request, timeout=30) as response:
            data = response.read(_MAX_ASSET_BYTES + 1)
        if len(data) > _MAX_ASSET_BYTES:
            raise ReleaseCheckFailed("the plugin asset was unexpectedly large")
        return data
    except ReleaseCheckFailed:
        raise
    except OSError as exc:
        raise ReleaseCheckFailed(f"the plugin asset could not be read: {exc}") from exc


def release_plugin_asset(release, fetch=None) -> dict:
    """Download the release's plugin zip and prove it is the published one.

    Returns ``{asset, manifest, digest, bytes}``.  Raises ReleaseCheckFailed when
    the release has no plugin zip, GitHub published no digest, the downloaded
    bytes do not match that digest, or the zip's ``plugin.yaml`` names another
    version.  This is gate 5 and gate 6; it never installs anything.
    """
    _check_release(release)
    tag = release["tag"]
    if fetch is None:
        entry = _github_get(f"{_API_PREFIX}releases/tags/{tag}")
        asset_fetch = _github_bytes
    else:
        entry = fetch(f"{_API_PREFIX}releases/tags/{tag}")
        asset_fetch = fetch
    if not isinstance(entry, dict):
        raise ReleaseCheckFailed("GitHub's release record was not a record")
    assets = entry.get("assets")
    if not isinstance(assets, list):
        raise ReleaseCheckFailed("the release has no assets")
    candidates = [asset for asset in assets if isinstance(asset, dict)
                  and isinstance(asset.get("name"), str) and asset["name"].lower().endswith(".zip")
                  and ("plugin" in asset["name"].lower() or "winglet" in asset["name"].lower())]
    if not candidates:
        raise ReleaseCheckFailed("the release has no plugin asset")
    problems = []
    for asset in candidates:
        digest = asset.get("digest")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
            problems.append(f"{asset['name']} has no published sha256")
            continue
        url = asset.get("browser_download_url")
        if not isinstance(url, str) or not _url_allowed(url):
            problems.append(f"{asset['name']} is not hosted by the Winglet repository")
            continue
        try:
            data = asset_fetch(url)
        except TypeError:  # a test fake written only for the JSON getter
            problems.append(f"{asset['name']} was not downloaded")
            continue
        if not isinstance(data, (bytes, bytearray)):
            problems.append(f"{asset['name']} was not downloaded")
            continue
        actual = "sha256:" + hashlib.sha256(data).hexdigest()
        if actual.lower() != digest.lower():
            problems.append(f"{asset['name']} does not match its published digest")
            continue
        manifest = _plugin_manifest_from_zip(bytes(data))
        if manifest.get("version") != release["version"]:
            problems.append(f"{asset['name']} contains Winglet {manifest.get('version') or 'with no version'}, "
                            f"not {release['version']}")
            continue
        return {"asset": asset, "manifest": manifest, "digest": digest, "bytes": bytes(data)}
    raise ReleaseCheckFailed("; ".join(problems) or "the release has no usable plugin asset")


def _plugin_manifest_from_zip(data: bytes) -> dict:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise ReleaseCheckFailed(f"the plugin asset is not a readable zip: {exc}") from exc
    with archive:
        names = [name for name in archive.namelist() if name == "plugin.yaml" or name.endswith("/plugin.yaml")]
        if not names:
            raise ReleaseCheckFailed("the plugin asset has no plugin.yaml")
        # Prefer the shallowest manifest: a release zip may contain the plugin
        # folder itself rather than the repository root.
        names.sort(key=lambda name: (name.count("/"), len(name)))
        try:
            text = archive.read(names[0]).decode("utf-8")
        except (KeyError, UnicodeDecodeError, OSError) as exc:
            raise ReleaseCheckFailed("the plugin asset's manifest cannot be read") from exc
    return {"version": _manifest_field(text, "version"), "requires_hermes": _manifest_field(text, "requires_hermes")}


def _tag_commit(tag: str, fetch) -> str:
    """The commit id a release tag points at (an annotated tag is followed once). Tags only, never a branch."""
    ref = fetch(f"{_API_PREFIX}git/ref/tags/{tag}")
    target = ref.get("object") if isinstance(ref, dict) else None
    if isinstance(target, dict) and target.get("type") == "tag" and isinstance(target.get("sha"), str) and _SHA.match(target["sha"]):
        annotated = fetch(f"{_API_PREFIX}git/tags/{target['sha']}")
        target = annotated.get("object") if isinstance(annotated, dict) else None
    sha = target.get("sha") if isinstance(target, dict) and target.get("type") == "commit" else None
    if not isinstance(sha, str) or not _SHA.match(sha):
        raise ReleaseCheckFailed(f"{tag} does not point at a commit")
    return sha


def _manifest_field(text: str, name: str) -> Optional[str]:
    match = re.search(rf"(?m)^{name}:[ \t]*(.*)$", text)
    if not match:
        return None
    value = re.sub(r"\s#.*$", "", match.group(1)).strip().strip("\"'").strip()
    return value or None


def latest_release(force: bool = False, *, fetch=None, clock=None) -> Optional[dict]:
    """The newest stable Winglet release: {version, tag, sha, notes, url, requires_hermes}, or None when none exists.

    Drafts, pre-releases and tags that are not exactly ``vX.Y.Z`` are ignored, and the highest version wins (not the
    most recently published: a backport must not hide the real latest). The tag is resolved to its commit, and the
    plugin manifest at that commit must carry the same version. Remembered for ten minutes."""
    fetch = fetch or _github_get
    now = (clock or time.monotonic)()
    cached = _RELEASE_CACHE.get("entry")
    if cached is not None and not force and now - cached["at"] < RELEASE_CACHE_SECONDS:
        return cached["value"]
    try:
        value = _newest_release(fetch)
    except ReleaseCheckFailed:
        raise
    except Exception as exc:  # whatever the fetch raised: the check failed, and a failure is not remembered
        raise ReleaseCheckFailed(f"GitHub could not be read: {exc}") from exc
    _RELEASE_CACHE["entry"] = {"at": now, "value": value}
    return value


def _newest_release(fetch) -> Optional[dict]:
    listing = fetch(f"{_API_PREFIX}releases?per_page=30")
    if not isinstance(listing, list):
        raise ReleaseCheckFailed("GitHub's list of releases was not a list")
    best = None
    for entry in listing:
        if not isinstance(entry, dict) or entry.get("draft") is not False or entry.get("prerelease") is not False:
            continue
        found = parse_tag(entry.get("tag_name"))
        if found is not None and (best is None or found > best[0]):
            best = (found, entry)
    value = None
    if best is not None:
        numbers, entry = best
        tag, version = entry["tag_name"], ".".join(str(n) for n in numbers)
        sha = _tag_commit(tag, fetch)
        manifest = fetch(f"{_RAW_PREFIX}{sha}/plugin/plugin.yaml", text=True)
        if not isinstance(manifest, str):
            raise ReleaseCheckFailed("the plugin manifest could not be read")
        declared = _manifest_field(manifest, "version")
        if declared != version:
            raise ReleaseCheckFailed(f"{tag} contains Winglet {declared or 'with no version'}, not {version}")
        notes = entry.get("body")
        value = {"version": version, "tag": tag, "sha": sha, "notes": notes[:4000] if isinstance(notes, str) else "",
                 "url": f"https://github.com/{RELEASE_REPO}/releases/tag/{tag}",
                 "requires_hermes": _manifest_field(manifest, "requires_hermes")}
    return value


# -- installing a release from the app ---------------------------------------------------------------------------
#
# Order, each step failing closed: backup, watch script, cron job, pending-update record, then the install. A failed
# install is undone in-process (files and install record only) and never restarts the gateway. If the new version
# installs but does not start, the cron script (plugin/update_rollback.py) restores the files, record and database and
# messages Kraig; he restarts the gateway himself.

UPDATE_INSTALL_WINDOW_SECONDS = 600   # how long the install itself may take before the watch treats the update as failed
UPDATE_WATCH_RUNS = 60                # the one-minute cron job removes itself after this many runs (outlasts the install and the longest wait for a quiet moment)
UPDATE_ALERT_DELIVER = "telegram"     # Kraig's home channel through Hermes cron delivery (Winglet itself may be down)
UPDATE_STALE_SECONDS = 3600           # an unconfirmed update record older than this no longer blocks a new update


def _updater():
    from . import update_rollback
    return update_rollback


def _check_release(release) -> None:
    """Only a release this module found itself (plain version, matching tag, 40-hex commit) can be installed."""
    if not isinstance(release, dict):
        raise ValueError("that release is not one this server can install")
    version, tag, sha = release.get("version"), release.get("tag"), release.get("sha")
    if parse_version(version) is None or parse_tag(tag) != parse_version(version) or not (isinstance(sha, str) and _SHA.match(sha)):
        raise ValueError("that release is not one this server can install")


def _default_db_path():
    from .adapter import data_dir
    return data_dir() / "data.db"


@_scoped
def _create_watch_job(script) -> str:
    job = _cron().create_job(None, "every 1m", name="Winglet update watch", deliver=UPDATE_ALERT_DELIVER, script=str(script),
                             no_agent=True, repeat=UPDATE_WATCH_RUNS)
    return str(job["id"])


@_scoped
def _remove_job(job_id: str) -> None:
    _cron().remove_job(job_id)


def remove_update_watch(job_id) -> None:
    """Stand the cron watch down. Best effort: a job that cannot be removed removes itself after its last run."""
    if isinstance(job_id, str) and job_id:
        try:
            _remove_job(job_id)
        except Exception as exc:
            logger.info("[winglet] could not remove the update watch job: %s", exc)


def _install_watch_script(destination) -> None:
    """Copy the RUNNING plugin's rollback script into Hermes's scripts folder (cron only runs scripts from there)."""
    import os
    updater = _updater()
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        temp.write_bytes(Path(updater.__file__).read_bytes())
        os.chmod(temp, 0o700)
        os.replace(temp, destination)
    finally:
        if temp.exists():
            temp.unlink()


def begin_update(release, from_version, *, plugin_dir=None, db_path=None, home=None, now=None) -> dict:
    """Make everything ready for an install and return what the later steps need. Raises (installing nothing, leaving
    nothing pending) if any part of the safety net cannot be set up."""
    import os
    updater = _updater()
    _check_release(release)
    if parse_version(from_version) is None:
        raise ValueError("the running version is not a plain x.y.z")
    plugin_dir = Path(plugin_dir) if plugin_dir is not None else _plugin_dir()
    home = Path(home) if home is not None else _home()
    db_path = db_path if db_path is not None else _default_db_path()
    now = time.time() if now is None else now
    root = plugin_dir.parent.parent
    if os.path.realpath(updater.hermes_root(home)) != os.path.realpath(root):
        raise ValueError("this install layout cannot update itself: the cron scripts and the backups would be in different places")
    folder = root / "backups" / updater.BACKUP_FOLDER
    try:
        existing = updater.read_marker(folder)
    except ValueError as exc:
        raise ValueError("an earlier update's record cannot be read; look in backups/winglet-plugin before updating") from exc
    if existing and existing.get("state") == "pending":
        created = existing.get("created")
        if not isinstance(created, (int, float)) or now - created < UPDATE_STALE_SECONDS:
            raise ValueError("An update is already waiting to be confirmed.")
        remove_update_watch(existing.get("cron_job"))
    backup = updater.create_backup(plugin_dir=plugin_dir, db_path=db_path, from_version=from_version,
                                   to_version=release["version"], now=now)
    script = home / "scripts" / updater.SCRIPT_NAME
    _install_watch_script(script)
    job_id = None
    try:
        job_id = _create_watch_job(script)
        updater.write_marker(folder, {"from": from_version, "to": release["version"], "backup": backup.name, "state": "pending",
                                      "cron_job": job_id, "created": now, "deadline": now + UPDATE_INSTALL_WINDOW_SECONDS})
    except BaseException:
        remove_update_watch(job_id)
        updater.clear_marker(folder)
        if backup.parent == folder:  # the backup made a moment ago for an update that will not happen; an earlier one is never touched
            shutil.rmtree(backup, ignore_errors=True)
        raise
    return {"backup": str(backup), "job": job_id, "script": str(script), "from": from_version, "to": release["version"],
            "folder": str(folder), "root": str(root)}


def arm_deadline(prepared: dict, *, now=None) -> bool:
    """The install is done and the gateway is about to restart: the new version now has a few minutes to confirm itself."""
    updater = _updater()
    folder = Path(prepared["folder"])
    with updater.marker_lock(folder):
        marker = updater.read_marker(folder)
        if not marker or marker.get('state') != 'pending' or marker.get('backup') != Path(prepared['backup']).name:
            return False
        marker["deadline"] = (time.time() if now is None else now) + updater.DEADLINE_SECONDS
        updater.write_marker(folder, marker)
        return True


def restart_update(prepared: dict):
    """Authorize and request restart under the watch lock. None means the update has already gone."""
    updater = _updater()
    folder = Path(prepared['folder'])
    with updater.marker_lock(folder):
        marker = updater.read_marker(folder)
        if not marker or marker.get('state') != 'pending' or marker.get('backup') != Path(prepared['backup']).name:
            return None
        marker['deadline'] = time.time() + updater.DEADLINE_SECONDS
        updater.write_marker(folder, marker)
        return spawn_restart()


def hold_lease(prepared: dict, note: Optional[str] = None, *, now=None) -> bool:
    """While an installed update waits for a quiet moment to restart: push the rollback deadline a few minutes ahead, so
    the watch leaves a healthy update that merely hasn't been loaded yet alone. The hub calls this again and again; the
    rollback clock therefore runs from the last call before the restart, i.e. from the restart. ``note`` is what the
    watch tells Kraig on Telegram, once. False means the update is not pending any more (the watch already acted)."""
    updater = _updater()
    folder = Path(prepared["folder"])
    with updater.marker_lock(folder):
        marker = updater.read_marker(folder)
        if not marker or marker.get("state") != "pending" or marker.get("backup") != Path(prepared["backup"]).name:
            return False
        marker["deadline"] = (time.time() if now is None else now) + updater.DEADLINE_SECONDS
        if isinstance(note, str) and note.strip() and "note" not in marker:
            marker["note"] = "".join(ch for ch in " ".join(note.split()) if ch.isprintable())[:800]
        updater.write_marker(folder, marker)
        return True


def mark_started(current_version, *, home=None, now=None) -> bool:
    """The new version records, just before it first opens its database, that it started. The rollback watch puts the
    database back only if it finds this mark: if the new code never ran, the database holds only what the old version
    wrote, which is newer than the backup. Never raises: a start-up must not depend on this record."""
    try:
        updater = _updater()
        folder = updater.hermes_root(Path(home) if home is not None else _home()) / "backups" / updater.BACKUP_FOLDER
        if not folder.exists():
            return False
        with updater.marker_lock(folder):
            marker = updater.read_marker(folder)
            if not marker or marker.get("state") != "pending" or marker.get("to") != current_version or updater._has_started(marker):
                return False
            marker["started"] = time.time() if now is None else now
            updater.write_marker(folder, marker)
            return True
    except Exception as exc:
        logger.info("[winglet] could not record that the new version started: %s", exc)
        return False


def snapshot_database(prepared: dict) -> None:
    """A fresh copy of the database in this update's backup (see update_rollback.refresh_database)."""
    _updater().refresh_database(Path(prepared["backup"]))


def cancel_update(prepared: dict, *, now=None) -> dict:
    """The install failed (or the restart could not be started): put the old files and install record back. The new
    code never ran, so the database is left alone. Does not restart anything."""
    updater = _updater()
    folder = Path(prepared["folder"])
    with updater.marker_lock(folder):
        return _cancel_update_locked(updater, prepared, folder, now)


def _cancel_update_locked(updater, prepared, folder, now):
    try:
        report = updater.restore(Path(prepared["root"]), Path(prepared["backup"]), time.time() if now is None else now,
                                 with_database=False)
    except updater.RollbackError as exc:
        marker = updater.read_marker(folder) or {}
        marker.update(state="rollback_failed", error=str(exc)[:300])
        updater.write_marker(folder, marker)
        raise
    finally:
        remove_update_watch(prepared.get("job"))
    updater.clear_marker(folder)
    return report


def installed_version_is(version, *, plugin_dir=None) -> bool:
    """Whether the plugin folder on disk now says it is this version (what the install should have produced)."""
    try:
        text = ((Path(plugin_dir) if plugin_dir is not None else _plugin_dir()) / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return False
    return parse_version(version) is not None and _manifest_field(text, "version") == version


def settle_pending_update(current_version, *, home=None) -> Optional[dict]:
    """Called when Winglet starts. If the update that was waiting is this very version, it worked: clear the record and
    stand the watch down. If the watch rolled it back, say so once. Otherwise leave it to the watch."""
    updater = _updater()
    folder = updater.hermes_root(Path(home) if home is not None else _home()) / "backups" / updater.BACKUP_FOLDER
    if not folder.exists():
        return None
    with updater.marker_lock(folder):
        return _settle_pending_locked(updater, folder, current_version)


def _settle_pending_locked(updater, folder, current_version):
    try:
        marker = updater.read_marker(folder)
    except ValueError:
        return None
    if not marker:
        return None
    state = marker.get("state")
    result = {"from": marker.get("from"), "to": marker.get("to")}
    if state == "pending" and marker.get("to") == current_version:
        result = {"outcome": "succeeded", **result}
    elif state in ("rolled_back", "rollback_failed"):
        result = {"outcome": state, **result, "error": marker.get("error"), "kept": marker.get("kept")}
    else:
        return None
    updater.clear_marker(folder)
    remove_update_watch(marker.get("cron_job"))
    return result


async def install_release(sha, timeout: float = UPDATE_INSTALL_WINDOW_SECONDS - 60) -> tuple:
    """Install the server-resolved commit, consenting to its declared Python dependencies without a TTY.

    The signed owner update request is the consent; repo/ref stay server-controlled. ``--yes-deps``
    answers only Hermes's Python-dependency question, not capability grants or gateway activation.
    Returns (exit code, output tail).
    """
    import asyncio as _asyncio
    import os
    if not isinstance(sha, str) or not _SHA.match(sha):
        raise ValueError("an install needs a full commit id")
    try:
        from hermes_cli._launchers import runtime_command
        from hermes_cli.web_server import PROJECT_ROOT
    except Exception as exc:
        raise HermesUnavailable("plugin install unavailable") from exc
    args = ("plugins", "install", f"{RELEASE_REPO}/plugin", "--ref", sha, "--force", "--no-enable", "--yes-deps")
    env = {**_install_environment(os.environ), "HERMES_HOME": str(_home()), "COLUMNS": "200"}
    proc = await _asyncio.create_subprocess_exec(*runtime_command(PROJECT_ROOT, args), env=env, stdin=_asyncio.subprocess.DEVNULL,
                                                 stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.STDOUT,
                                                 **({'start_new_session': True} if os.name != 'nt' else {}))
    try:
        out, _ = await _asyncio.wait_for(proc.communicate(), timeout)
    except _asyncio.TimeoutError:
        await _stop_installer_tree(proc)
        return -1, ["The install took too long and was stopped."]
    except _asyncio.CancelledError:
        await _stop_installer_tree(proc)
        raise
    return proc.returncode, clean_output(out.decode("utf-8", errors="replace"))


async def _stop_installer_tree(proc) -> None:
    """Stop inherited PM workers and reap the launcher before rollback touches their files.

    Cooperative process cleanup, not a sandbox against a dependency escaping the group.
    """
    import asyncio
    import os
    import signal
    import subprocess

    if os.name == 'nt':
        taskkill = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'taskkill.exe')
        stopped = await asyncio.to_thread(subprocess.run, [taskkill, '/PID', str(proc.pid), '/T', '/F'],
                                          stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        if stopped.returncode and proc.returncode is None:
            proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    await proc.wait()


# What the install child may inherit: where programs are, who is running them, the language, and what git and TLS need to reach
# GitHub. Nothing else: the gateway's environment holds API keys and tokens that an install has no use for.
_INSTALL_ENV = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
                "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")


def _install_environment(environ) -> dict:
    return {name: value for name, value in environ.items() if name in _INSTALL_ENV or name.startswith("LC_")}


_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")
OUTPUT_LINES = 30
OUTPUT_LINE_CHARS = 300


def clean_output(text: str) -> list:
    """The last lines a child printed as plain, bounded text for the phone: no colour codes, no control, zero-width or
    direction-changing characters, no blank lines, no line longer than OUTPUT_LINE_CHARS."""
    lines = []
    for raw in text.splitlines():
        line = _ANSI.sub("", raw).replace("\t", " ")
        line = "".join(ch for ch in line if not unicodedata.category(ch).startswith("C")).strip()
        if line:
            lines.append(line if len(line) <= OUTPUT_LINE_CHARS else line[:OUTPUT_LINE_CHARS - 1] + "\u2026")
    return lines[-OUTPUT_LINES:]


def busy_bots(activity) -> dict:
    """Who a gateway restart would interrupt: {bots: [{bot, state, queued}], unknown}. ``activity`` is the bot activity
    snapshot ({name: {state, queued}}) or None when nothing could look. Unknown stays unknown: it is never counted as
    idle. Counts and states only, no queue previews."""
    if not isinstance(activity, dict):
        return {"bots": [], "unknown": True}
    bots, unknown = [], False
    for name in sorted(activity, key=str):
        entry = activity[name]
        state = entry.get("state") if isinstance(entry, dict) else None
        if state not in ("idle", "working"):
            unknown = True
            continue
        queued = entry.get("queued")
        queued = queued if isinstance(queued, int) and not isinstance(queued, bool) and queued > 0 else 0
        if state == "working" or queued:
            bots.append({"bot": str(name), "state": state, "queued": queued})
    return {"bots": bots, "unknown": unknown}


def hermes_supports(requirement, running) -> Optional[bool]:
    """Whether the running Hermes satisfies a release's ``requires_hermes`` range. None when it cannot be told."""
    if requirement is None or not str(requirement).strip():
        return True
    match = re.match(r"\s*v?([0-9]+(?:\.[0-9]+){0,3})", running) if isinstance(running, str) else None
    if not match:
        return None
    try:
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version
        return bool(SpecifierSet(str(requirement)).contains(Version(match.group(1)), prereleases=True))
    except Exception:  # no packaging, or a range it cannot read
        return None


_LOG_FILES = {"agent": "agent.log", "gateway": "gateway.log", "errors": "errors.log"}
_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


def read_log(name: str, *, lines: int = 300, level: str = "", query: str = "") -> dict:
    """The end of one of Hermes's logs, redacted the way Hermes redacts tool output, filtered by
    minimum level and a search string."""
    filename = _LOG_FILES.get(name)
    if filename is None:
        raise HermesRefused("unknown log")
    path = _home() / "logs" / filename
    if not path.exists():
        return {"lines": [], "size": 0}
    size = path.stat().st_size
    with open(path, "rb") as f:
        f.seek(max(0, size - 512 * 1024))
        text = f.read().decode("utf-8", errors="replace")
    rows = text.splitlines()[1:] if size > 512 * 1024 else text.splitlines()
    floor = _LEVELS.index(level) if level in _LEVELS else 0
    q = query.lower()

    def keep(row: str) -> bool:
        if floor:
            found = next((lv for lv in _LEVELS if f" {lv} " in row[:80]), None)
            if found is None or _LEVELS.index(found) < floor:
                return False
        return not q or q in row.lower()

    picked = [r for r in rows if keep(r)][-max(1, min(lines, 1000)):]
    try:
        from agent.redact import redact_sensitive_text
        picked = redact_sensitive_text("\n".join(picked), force=True, redact_url_credentials=True).split("\n")
    except Exception:
        picked = ["(Hermes's redaction is unavailable on this version, so logs aren't shown.)"]
    return {"lines": picked, "size": size}


def _cron():
    try:
        from cron import jobs
    except Exception as exc:
        raise HermesUnavailable("schedule unavailable") from exc
    return jobs


_JOB_FIELDS = ("id", "name", "prompt", "schedule_display", "state", "enabled", "next_run_at", "last_run_at",
               "last_status", "last_error", "deliver", "created_at", "paused_reason", "manual_run_at")


def _job_view(job: dict) -> dict:
    out = {k: job.get(k) for k in _JOB_FIELDS}
    schedule = job.get("schedule") or {}
    out["kind"] = schedule.get("kind") if isinstance(schedule, dict) else None
    try:
        out["state"] = _cron().effective_job_state(job)
    except Exception:
        pass
    return out


@_scoped
def list_schedule() -> List[dict]:
    return [_job_view(j) for j in _cron().list_jobs(include_disabled=True)]


@_scoped
def parse_schedule(text: str) -> dict:
    jobs = _cron()
    try:
        schedule = jobs.parse_schedule(text)
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc
    nxt = jobs.compute_next_run(schedule)
    return {"display": schedule.get("display") or text, "kind": schedule.get("kind"), "next_run_at": nxt}


# Routine results arrive in the Winglet Updates chat.
ROUTINE_DELIVERY = "winglet:home"


@_scoped
def create_routine(name: str, prompt: str, schedule: str) -> dict:
    try:
        return _job_view(_cron().create_job(prompt=prompt, schedule=schedule, name=name or None, deliver=ROUTINE_DELIVERY))
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc


@_scoped
def change_routine(job_id: str, action: str, updates: Optional[dict] = None) -> Optional[dict]:
    jobs = _cron()
    try:
        if action == "update":
            allowed = {k: v for k, v in (updates or {}).items() if k in ("name", "prompt", "schedule")}
            job = jobs.update_job(job_id, allowed)
        elif action == "pause":
            job = jobs.pause_job(job_id, "paused from Winglet")
        elif action == "resume":
            job = jobs.resume_job(job_id)
        elif action == "run":
            job = jobs.trigger_job(job_id)
        elif action == "delete":
            return {"deleted": bool(jobs.remove_job(job_id))}
        else:
            raise HermesRefused("unknown action")
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc
    return _job_view(job) if job else None


def routine_history_available() -> bool:
    try:
        from cron import executions, jobs
        from hermes_state import SessionDB
        from hermes_time import get_timezone_name
        return (all(callable(getattr(executions, k, None)) for k in ('list_executions', 'get_execution', '_owner_is_live'))
                and all(callable(getattr(jobs, k, None)) for k in ('_current_cron_store', '_normalize_job_record', 'get_cron_output_dir'))
                and isinstance(getattr(executions, 'MAX_TERMINAL_EXECUTIONS', None), int)
                and hasattr(executions, 'EXECUTIONS_FILE')
                and callable(get_timezone_name) and callable(getattr(SessionDB, 'list_cron_job_runs', None)))
    except Exception:
        return False


@_scoped
def routine_history_source(routine_id: Optional[str] = None) -> dict:
    """Read the pinned scheduler's real ledger, output documents and session records.

    No recovery/migration/tick API is invoked: observation cannot execute a job or rewrite
    Hermes state. All paths resolve inside the current authenticated profile context.
    """
    import hashlib
    import re
    import sqlite3
    from pathlib import Path
    from cron import executions
    from hermes_constants import get_hermes_home
    from hermes_time import get_timezone_name, now
    from hermes_state import SessionDB
    if not routine_history_available(): raise HermesUnavailable('routine history unavailable')
    if routine_id is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', routine_id):
        raise HermesRefused('Invalid routine identity.')
    home = get_hermes_home().resolve()
    # list_jobs() invokes load_jobs() repair and latest_executions() schema setup.
    # Observe the canonical file directly so opening History cannot repair or execute.
    jobs_path = _cron()._current_cron_store().jobs_file
    if jobs_path.is_file():
        with jobs_path.open('rb') as handle: raw_jobs = handle.read(4 * 1024 * 1024 + 1)
        if len(raw_jobs) > 4 * 1024 * 1024: raise HermesUnavailable('Routine definitions exceed the read bound.')
        data = json.loads(raw_jobs)
        jobs = data.get('jobs', []) if isinstance(data, dict) else data
        if not isinstance(jobs, list) or any(not isinstance(j, dict) for j in jobs):
            raise HermesUnavailable('Routine definitions need repair in Hermes.')
        jobs = [_cron()._normalize_job_record(j) for j in jobs]
    else: jobs = []
    ledger = Path(executions.EXECUTIONS_FILE) if executions.EXECUTIONS_FILE else home / 'cron/executions.db'
    records = []
    complete_executions = True
    complete_records = True
    coverage_from = None
    if ledger.is_file():
        db = sqlite3.connect(ledger.resolve().as_uri() + '?mode=ro', uri=True, timeout=0.5)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')  # Counts, coverage and rows describe one consistent ledger snapshot.
            where, args = (' WHERE job_id=?', (routine_id,)) if routine_id else ('', ())
            count = db.execute('SELECT COUNT(*) FROM executions' + where, args).fetchone()[0]
            terminals = db.execute("SELECT COUNT(*) FROM executions WHERE status IN ('completed','failed','unknown')").fetchone()[0]
            complete_records = count <= 5000
            complete_executions = complete_records
            if terminals >= executions.MAX_TERMINAL_EXECUTIONS:
                # Native pruning removes the oldest FINISHED terminal rows, never active
                # attempts. Beyond this boundary all potentially overlapping rows survive.
                oldest = db.execute("SELECT finished_at FROM executions WHERE status IN ('completed','failed','unknown') ORDER BY julianday(finished_at),finished_at LIMIT 1").fetchone()
                coverage_from = oldest[0] if oldest else None
                if not coverage_from: complete_executions = False
            records = [dict(x) for x in db.execute('SELECT * FROM executions' + where + ' ORDER BY julianday(claimed_at) DESC,claimed_at DESC,id DESC LIMIT 5000', args)]
        finally: db.close()
    for record in records:
        if record.get('status') in {'claimed', 'running'}:
            try: record['owner_gone'] = not executions._owner_is_live(int(record['pid']), record.get('process_started_at'))
            except Exception: record['owner_gone'] = False
    selected = [routine_id] if routine_id else list(dict.fromkeys(str(x['job_id']) for x in records))[:40]
    output_root = _cron().get_cron_output_dir().resolve()
    outputs = []
    complete_outputs = True
    for job_id in selected:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', job_id): continue
        directory = (output_root / job_id).resolve()
        if directory.parent != output_root or not directory.is_dir(): continue
        files = []
        for path in directory.glob('*.md'):
            try:
                if path.is_file() and path.resolve().parent == directory:
                    files.append((path.stat().st_mtime, path))
            except FileNotFoundError: continue
        if len(files) > 50: complete_outputs = False
        files = [path for _, path in sorted(files, key=lambda x: x[0], reverse=True)[:50]]
        for path in files:
            try:
                with path.open('rb') as handle: raw = handle.read(65537)
                stamp = path.stat().st_mtime
            except (FileNotFoundError, PermissionError): continue
            digest = hashlib.sha256((job_id + ':' + path.name).encode() + raw).hexdigest()[:32]
            outputs.append({'id': digest, 'job_id': job_id, 'at': stamp,
                            'text': raw[:65536].decode('utf8', errors='replace'), 'truncated': len(raw) > 65536})
            if len(outputs) >= 200: break
        if len(outputs) >= 200:
            complete_outputs = False
            break
    sessions = []
    complete_sessions = True
    if (home / 'state.db').is_file():
        db = SessionDB(db_path=home / 'state.db', read_only=True)
        try:
            for job_id in selected:
                limit = min(200, 500-len(sessions))
                batch = db.list_cron_job_runs(job_id, limit=limit, offset=0)
                if len(batch) >= limit: complete_sessions = False
                for row in batch:
                    sessions.append({k: row.get(k) for k in ('id', 'started_at', 'ended_at', 'source') } | {'job_id': job_id})
                if len(sessions) >= 500:
                    complete_sessions = False
                    break
        finally: db.close()
    return {'jobs': jobs[:1000], 'complete_jobs': len(jobs) <= 1000, 'executions': records,
            'coverage_from': coverage_from, 'routine_id': routine_id, 'complete_records': complete_records, 'complete_executions': complete_executions, 'complete_outputs': complete_outputs, 'complete_sessions': complete_sessions, 'outputs': outputs, 'sessions': sessions, 'timezone': get_timezone_name() or str(now().tzinfo)}


def watch_routine_history(callback):
    """A supported content-free lifecycle wakeup; durable polling also covers other processes."""
    try:
        from agent.monitoring.emitter import get_emitter
        emitter = get_emitter()
        def observed(batch):
            if any(getattr(event, 'EVENT', '') == 'cron_execution' or (isinstance(event, dict) and event.get('event') == 'cron_execution') for event in batch): callback()
        emitter.subscribe(observed)
        return lambda: emitter.unsubscribe(observed)
    except Exception:
        return lambda: None


# -- goals ---------------------------------------------------------------------------------


def goals_available() -> bool:
    """Whether this Hermes has standing goals (/goal). Older versions don't."""
    try:
        import hermes_cli.goals  # noqa: F401
    except Exception:
        return False
    return True


def chat_goal(runner, session_key: str) -> Optional[dict]:
    """The standing goal (/goal) a chat's Hermes session is working on, or None. Read-only: the app
    changes goals by sending /goal and /subgoal, so Hermes's own rules and judge apply."""
    try:
        session_id = runner.session_store.peek_session_id(session_key)
    except Exception:
        return None
    if not session_id:
        return None
    try:
        from hermes_cli.goals import load_goal
    except Exception as exc:
        raise HermesUnavailable("goals unavailable") from exc
    with _profile_scope():
        state = load_goal(session_id)
    if state is None or state.status == "cleared" or not state.goal:
        return None
    import time as _time
    waiting = bool(state.waiting_reason) and (not state.waiting_until or state.waiting_until > _time.time())
    return {"goal": state.goal, "status": state.status, "turns_used": state.turns_used, "max_turns": state.max_turns,
            "subgoals": list(state.subgoals), "last_verdict": state.last_verdict, "last_reason": state.last_reason,
            "paused_reason": state.paused_reason, "waiting_reason": state.waiting_reason if waiting else None,
            "created_at": state.created_at, "last_turn_at": state.last_turn_at}


# -- workspace checkpoints --------------------------------------------------------------------
#
# Hermes snapshots the folder a bot works in just before the agent changes files (its own
# /rollback, tools/checkpoint_manager.py). These read and restore those snapshots; they never
# touch the transcript. A snapshot belongs to one folder and one Hermes profile.


def checkpoints_available() -> bool:
    """Whether this Hermes keeps filesystem checkpoints at all."""
    try:
        from tools.checkpoint_manager import CheckpointManager  # noqa: F401
    except Exception:
        return False
    return True


def checkpoint_restore_available() -> bool:
    """Whether it can also put them back (a list-only Hermes keeps the restore button hidden)."""
    try:
        from tools.checkpoint_manager import CheckpointManager
    except Exception:
        return False
    return callable(getattr(CheckpointManager, "restore", None))


def _checkpoint_dir() -> str:
    """The folder this bot works in: Hermes's own terminal scope, never a caller-supplied path."""
    import os
    from pathlib import Path

    raw = ""
    try:
        from gateway.run import _terminal_scope_cwd
    except ImportError:
        _terminal_scope_cwd = None
    if _terminal_scope_cwd is not None:
        # Raises rather than borrowing the launch profile's folder when a refusal scope is active.
        raw = _terminal_scope_cwd("") or ""
    else:
        try:
            from tools.terminal_scope import terminal_env
            raw = terminal_env("TERMINAL_CWD", "") or ""
        except Exception:
            raw = os.environ.get("TERMINAL_CWD", "") or ""
    path = Path(raw).expanduser() if raw else Path.cwd()
    try:
        return str(path.resolve(strict=False))
    except OSError:
        return str(path)


def _display_path(path: str) -> str:
    """A folder for the screen: its home is shown as ``~``, never the server's whole path."""
    try:
        from pathlib import Path
        home = str(Path.home())
        text = str(path)
        if text == home:
            return "~"
        if text.startswith(home + ("\\" if "\\" in home else "/")):
            return "~" + text[len(home):]
        return text
    except Exception:
        return str(path)


def _checkpoint_manager():
    """Hermes's manager for this profile's checkpoint settings, or None if it has none."""
    try:
        from tools.checkpoint_manager import CheckpointManager
    except Exception:
        return None
    try:
        from hermes_cli.config import DEFAULT_CONFIG, load_config
        config = load_config() or {}
    except Exception as exc:
        raise HermesUnavailable("checkpoint settings unavailable") from exc
    section = config.get("checkpoints") if isinstance(config, dict) else None
    if isinstance(section, bool):
        section = {"enabled": section}
    if not isinstance(section, dict):
        section = {}
    defaults = DEFAULT_CONFIG.get("checkpoints") if isinstance(DEFAULT_CONFIG, dict) else {}
    defaults = defaults if isinstance(defaults, dict) else {}

    def pick(name, fallback):
        value = section.get(name, defaults.get(name, fallback))
        return value

    def number(name, fallback):
        try:
            return int(pick(name, fallback))
        except (TypeError, ValueError):
            return fallback

    return CheckpointManager(enabled=bool(pick("enabled", False)), max_snapshots=number("max_snapshots", 20),
                             max_total_size_mb=number("max_total_size_mb", 500),
                             max_file_size_mb=number("max_file_size_mb", 10))


def _checkpoint_epoch(value) -> float:
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _checkpoint_workspace(manager) -> str:
    """The folder Hermes checkpoints for this bot: its project-marker resolution, or the cwd."""
    directory = _checkpoint_dir()
    try:
        return str(manager.get_working_dir_for_path(directory))
    except Exception:
        logger.debug("[winglet] checkpoint folder resolution failed", exc_info=True)
        return directory


@_scoped
def checkpoints_state() -> dict:
    """{supported, enabled, reason, can_restore, workspace}: what this bot can do with checkpoints."""
    import os

    manager = _checkpoint_manager()
    if manager is None:
        return {"supported": False, "enabled": False, "can_restore": False,
                "reason": "This Hermes version doesn't keep checkpoints.", "workspace": {"path": "", "name": ""}}
    directory = _checkpoint_workspace(manager)
    reason = ""
    try:
        # Refused for a container terminal: the paths belong inside the container, not this host.
        reason = str(manager.unsupported_backend_reason() or "")
    except Exception:
        reason = ""
    enabled = bool(manager.enabled) and not reason
    if not manager.enabled:
        reason = ""
    return {"supported": True, "enabled": enabled, "reason": reason,
            "can_restore": callable(getattr(manager, "restore", None)),
            "workspace": {"path": _display_path(directory), "name": os.path.basename(directory.rstrip("/\\")) or directory}}


@_scoped
def list_checkpoints() -> list:
    """The workspace's snapshots, newest first, in one shape whatever Hermes calls the fields."""
    manager = _checkpoint_manager()
    if manager is None:
        raise HermesUnavailable("checkpoints unavailable")
    directory = _checkpoint_workspace(manager)
    rows = []
    for entry in manager.list_checkpoints(directory) or []:
        if not isinstance(entry, dict):
            continue
        digest = str(entry.get("hash") or "")
        rows.append({"hash": digest, "short": str(entry.get("short_hash") or digest[:8]),
                     "at": _checkpoint_epoch(entry.get("timestamp")),
                     "label": str(entry.get("reason") or "Checkpoint"),
                     "files": int(entry.get("files_changed") or 0),
                     "insertions": int(entry.get("insertions") or 0),
                     "deletions": int(entry.get("deletions") or 0)})
    return rows


@_scoped
def checkpoint_diff(commit_hash: str) -> dict:
    """What changed in the workspace since a checkpoint: {success, stat, diff} or {success: False, error}."""
    manager = _checkpoint_manager()
    if manager is None:
        raise HermesUnavailable("checkpoints unavailable")
    directory = _checkpoint_workspace(manager)
    result = manager.diff(directory, commit_hash)
    return dict(result) if isinstance(result, dict) else {"success": False, "error": "Couldn't read the changes."}


@_scoped
def restore_checkpoint(commit_hash: str, safe: bool = True) -> dict:
    """Put the workspace files back as they were at a checkpoint, Hermes's own safe restore when
    asked: files the owner edited themselves since are left alone."""
    manager = _checkpoint_manager()
    if manager is None:
        raise HermesUnavailable("checkpoints unavailable")
    directory = _checkpoint_workspace(manager)
    if safe:
        # Hermes falls back to a full restore when its write ledger is empty. Keep the
        # app's safe-mode promise: validate its plan inside the manager's own store lock.
        # This manager belongs to this call; no global patch or second lock is needed.
        planner = getattr(manager, "_safe_restore_plan", None)
        refusal = {"success": False, "error": (
            "Hermes can't safely distinguish your edits because its file-write history is unavailable. "
            "Nothing was restored. To overwrite your edits too, turn on "
            "'Also revert files I edited myself' and confirm again.")}
        if not callable(planner):
            return refusal

        def guarded_plan(*args, **kwargs):
            plan = planner(*args, **kwargs)
            if isinstance(plan, dict) and plan.get("success") is False:
                return plan
            if (not isinstance(plan, dict) or plan.get("success") is not True
                    or plan.get("ledger_empty")
                    or not isinstance(plan.get("restore"), list)
                    or not isinstance(plan.get("skipped"), list)):
                return dict(refusal)
            return plan

        manager._safe_restore_plan = guarded_plan
    result = manager.restore(directory, commit_hash, safe=bool(safe))
    return dict(result) if isinstance(result, dict) else {"success": False, "error": "The restore failed."}


# -- abilities: skills, toolsets, MCP servers ------------------------------------------------
#
# The same functions behind the Skills, Tools and MCP pages of Hermes's dashboard. Toolsets are
# Winglet's own (``platform_toolsets.winglet``), so turning one off here doesn't touch the terminal.

PLATFORM = "winglet"
# The override for a member limited to nothing: an override must name something, and this names no
# toolset and keeps MCP servers out. It isn't a deny-all on its own (Hermes still adds default-on plugin
# toolsets, and x_search when xAI keys exist); limit_turn_toolsets enforces the limit on the result.
NO_TOOLS = ["no_mcp"]
APPROVAL_MODES = ("manual", "smart", "off")
MAX_SKILL_BYTES = 200_000


def _router(name: str):
    import importlib
    try:
        return importlib.import_module(f"hermes_cli.web_routers.{name}")
    except Exception as exc:
        raise HermesUnavailable(f"{name} unavailable") from exc


def _models():
    try:
        import hermes_cli.web_models as models
    except Exception as exc:
        raise HermesUnavailable("dashboard models unavailable") from exc
    return models


def _takes_profile(fn) -> bool:
    import inspect
    try:
        return "profile" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


async def _route(fn, *args):
    """Await one of the dashboard's route functions as this profile. A route that takes a ``profile``
    gets the current bot's, so actions it spawns (skill installs) run as that profile too. Its HTTP
    errors carry a message meant for a person; they become refusals."""
    kwargs = {"profile": _BOT.get()} if _BOT.get() and _takes_profile(fn) else {}
    try:
        with _profile_scope():
            return await fn(*args, **kwargs)
    except (HermesUnavailable, HermesRefused):
        raise
    except Exception as exc:
        if isinstance(getattr(exc, "status_code", None), int):
            raise HermesRefused(_detail(exc)) from exc
        raise


def _skills_changed() -> None:
    """New skill commands for the command palette, and a fresh skills index for new sessions."""
    try:
        from agent.skill_commands import reload_skills
        reload_skills()
    except Exception:
        logger.debug("[winglet] skill reload unavailable", exc_info=True)
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        logger.debug("[winglet] skills prompt cache unavailable", exc_info=True)


def _skill_source_url(*values) -> Optional[str]:
    """Only expose an explicit browser URL, never infer one or expose URL credentials."""
    from urllib.parse import urlsplit
    for value in values:
        if not isinstance(value, str) or not value or any(c.isspace() for c in value):
            continue
        try:
            parsed = urlsplit(value)
            if parsed.scheme in ("http", "https") and parsed.hostname and parsed.username is None and parsed.password is None and not parsed.query and not parsed.fragment:
                return value
        except ValueError:
            continue
    return None


def _skill_identifier(value) -> Optional[str]:
    """Strip URL credentials and parameters from display identifiers."""
    from urllib.parse import urlsplit, urlunsplit
    if not isinstance(value, str):
        return None
    if "://" not in value:
        return value
    try:
        if any(c.isspace() or c == "\\" for c in value):
            return None
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return None
        _ = parsed.port
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, "", ""))
    except ValueError:
        return None


OFFICIAL_SKILLS_REPO = "NousResearch/hermes-agent"


def _official_skill_url(identifier) -> Optional[str]:
    """Official skills live in Hermes's GitHub repo at optional-skills/<category>/<skill>, the path their
    identifier (official/<category>/<skill>) names; Hermes's own live-repo fallback reads the same path."""
    import re
    if not isinstance(identifier, str) or not identifier.startswith("official/"):
        return None
    rel = identifier.removeprefix("official/")
    if not re.fullmatch(r"[\w.-]+(?:/[\w.-]+)+", rel) or any(part in (".", "..") for part in rel.split("/")):
        return None
    return f"https://github.com/{OFFICIAL_SKILLS_REPO}/tree/main/optional-skills/{rel}"


async def list_skills() -> List[dict]:
    """Installed skills and source metadata recorded in this profile's hub lock."""
    rows = await _route(_router("skills").get_skills)
    keys = ("name", "description", "category", "enabled", "provenance", "usage")
    installed = {}
    if any(row.get("provenance") == "hub" for row in rows):
        try:
            from tools.skills_hub import HubLockFile
            with _profile_scope():
                installed = {entry.get("name"): entry for entry in HubLockFile().list_installed()}
        except (ImportError, OSError, ValueError, TypeError, KeyError):
            logger.debug("[winglet] skill source metadata unavailable", exc_info=True)
    result = []
    for row in rows:
        item = {k: row.get(k) for k in keys}
        entry = installed.get(row.get("name"), {}) if row.get("provenance") == "hub" else {}
        metadata = entry.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        identifier = entry.get("identifier")
        item["identifier"] = _skill_identifier(identifier)
        item["source_url"] = (_skill_source_url(metadata.get("source_url"), metadata.get("url"), entry.get("identifier"))
                              or _official_skill_url(entry.get("identifier")))
        result.append(item)
    return result


async def set_skill_enabled(name: str, enabled: bool) -> None:
    if name not in {s["name"] for s in await list_skills()}:
        raise HermesRefused(f"There's no skill called {name}.")
    await _route(_router("skills").toggle_skill, _models().SkillToggle(name=name, enabled=enabled))
    _skills_changed()


async def skill_content(name: str) -> dict:
    data = await _route(_router("skills").get_skill_content, name)
    content = str(data.get("content") or "")
    return {"name": name, "content": content[:MAX_SKILL_BYTES], "truncated": len(content) > MAX_SKILL_BYTES}


async def skill_catalog() -> List[dict]:
    """Hermes's official optional skills, which ship with Hermes and install without the network."""
    data = await _route(_router("skills").list_official_skills)
    import re
    keys = ("name", "description", "identifier", "category", "tags", "installed")
    result = []
    for row in data.get("skills") or []:
        repo = row.get("repo")
        # Hermes's official metadata uses an owner/repo slug, not a browser URL.
        safe_repo = repo if isinstance(repo, str) and re.fullmatch(r"[\w.-]+/[\w.-]+", repo) else _skill_source_url(repo)
        url = _skill_source_url(row.get("source_url"), repo)
        if url is None and row.get("source") == "official" and safe_repo == OFFICIAL_SKILLS_REPO:
            url = _official_skill_url(row.get("identifier"))
        result.append({**{k: row.get(k) for k in keys}, "source_repo": safe_repo,
                       "source_path": row.get("path"), "source_url": url})
    return result


async def start_skill_install(identifier: str) -> str:
    """Start `hermes skills install` for an official skill. Returns the action to follow."""
    if identifier not in {s["identifier"] for s in await skill_catalog()}:
        raise HermesRefused("Only Hermes's official skills can be installed from the app.")
    started = await _route(_router("skills").install_skill_hub, _models().SkillInstallRequest(identifier=identifier))
    return str(started["name"])


async def start_skill_uninstall(name: str) -> str:
    skill = next((s for s in await list_skills() if s["name"] == name), None)
    if skill is None or skill["provenance"] != "hub":
        raise HermesRefused("Only skills installed from a hub can be removed. Turn this one off instead.")
    started = await _route(_router("skills").uninstall_skill_hub, _models().SkillUninstallRequest(name=name))
    return str(started["name"])


async def action_status(action: str) -> dict:
    """{running, exit_code, lines} for a background `hermes` action this process started."""
    return dict(await _route(_router("actions").get_action_status, action, 40))


def finish_skill_action() -> None:
    _skills_changed()


def _toolset_rows(config: dict) -> list:
    from hermes_cli.tools_config import (
        _CONFIG_ONLY_TOOLSETS, _get_effective_configurable_toolsets, _toolset_allowed_for_platform)
    return [(name, label, desc) for name, label, desc in _get_effective_configurable_toolsets()
            if name not in _CONFIG_ONLY_TOOLSETS and _toolset_allowed_for_platform(name, PLATFORM)]


def _enabled_toolsets(config: dict) -> set:
    from hermes_cli.tools_config import _get_platform_tools
    enabled = set(_get_platform_tools(config, PLATFORM, include_default_mcp_servers=False))
    # Until a list is saved, Hermes reports a plugin platform's whole default bundle as one entry. Saved,
    # it would bring back every toolset the owner turns off.
    enabled.discard(f"hermes-{PLATFORM}")
    return enabled


@_scoped
def toolsets() -> List[dict]:
    """The toolsets the agent has when it works for Winglet: {name, label, description, enabled, configured}.
    configured is False when a toolset still needs a key or a provider set up on the server."""
    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _toolset_has_keys, get_nous_subscription_features, gui_toolset_label
    except Exception as exc:
        raise HermesUnavailable("toolsets unavailable") from exc
    config = load_config()
    enabled = _enabled_toolsets(config)
    features = get_nous_subscription_features(config)
    out = []
    for name, label, desc in _toolset_rows(config):
        try:
            configured = bool(_toolset_has_keys(name, config, features=features))
        except Exception:
            configured = True
        out.append({"name": name, "label": gui_toolset_label(label), "description": desc,
                    "enabled": name in enabled, "configured": configured})
    return out


@_scoped
def set_toolset(name: str, enabled: bool) -> None:
    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _save_platform_tools
        from hermes_cli.web_routers._common import config_write_scope
    except Exception as exc:
        raise HermesUnavailable("toolsets unavailable") from exc
    with config_write_scope(None):
        config = load_config()
        if name not in {row[0] for row in _toolset_rows(config)}:
            raise HermesRefused(f"There's no toolset called {name}.")
        current = _enabled_toolsets(config)
        if enabled:
            current.add(name)
        else:
            current.discard(name)
        _save_platform_tools(config, PLATFORM, current)


@_scoped
def member_toolsets(allowed: List[str], mcp: bool) -> List[str]:
    """The toolset override for a member whose tools are limited: what they're allowed, if the owner
    has it on too. MCP servers only when allowed and on for the owner."""
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names
    config = load_config()
    mine = _enabled_toolsets(config)
    keep = sorted(set(allowed) & mine & {row[0] for row in _toolset_rows(config)})
    if mcp:
        # The owner's MCP servers by name, so the member's list can't widen them.
        servers = sorted(set(_get_platform_tools(config, PLATFORM)) & enabled_mcp_server_names(config))
        keep += servers if servers else ["no_mcp"]
    else:
        keep.append("no_mcp")
    return keep or list(NO_TOOLS)


def limit_turn_toolsets(runner, platform: str) -> bool:
    """Cap the toolsets of every turn from ``platform`` at what that turn's own adapter allows. Each call
    asks the adapter Hermes routes the source to (each profile has its own, and a reconnect replaces it)
    through ``adapter.toolset_limit(source)``: None leaves the turn as Hermes resolved it, a set is the
    most it may end with. The cap applies after Hermes has added anything of its own, so nothing reaches
    a limited turn implicitly, and a turn whose limit can't be worked out gets no tools. Other platforms
    are untouched. False when this Hermes lacks either step, and limits can't be enforced."""
    resolve = getattr(runner, "_resolve_enabled_toolsets_for_source", None)
    route = getattr(runner, "_delivery_adapter_for", None)
    if resolve is None or route is None:
        return False
    if getattr(resolve, "winglet_limited", False):
        return True

    @functools.wraps(resolve)
    def limited(user_config, source, platform_key):
        enabled = resolve(user_config, source, platform_key)
        kind = getattr(source, "platform", None)
        if getattr(kind, "value", kind) != platform:
            return enabled
        try:
            allowed = route(source).toolset_limit(source)
        except Exception:
            logger.warning("[winglet] couldn't work out a turn's tool limit; giving it none", exc_info=True)
            allowed = set()
        return enabled if allowed is None else [name for name in enabled if name in allowed]

    limited.winglet_limited = True
    runner._resolve_enabled_toolsets_for_source = limited
    return True


@_scoped
def approval_mode() -> str:
    from hermes_cli.config import load_config
    mode = (load_config().get("approvals") or {}).get("mode", "manual")
    if mode is False:
        return "off"
    mode = str(mode).strip().lower()
    return mode if mode in APPROVAL_MODES else "manual"


@_scoped
def set_approval_mode(mode: str) -> None:
    if mode not in APPROVAL_MODES:
        raise HermesRefused("mode must be manual, smart or off")
    try:
        from hermes_cli.config import load_config, save_config
        from hermes_cli.web_routers._common import config_write_scope
    except Exception as exc:
        raise HermesUnavailable("approval settings unavailable") from exc
    with config_write_scope(None):
        config = load_config()
        section = config.get("approvals")
        if not isinstance(section, dict):
            section = config["approvals"] = {}
        section["mode"] = mode
        save_config(config)


async def mcp_servers() -> List[dict]:
    """Configured MCP servers, without their arguments or environment (they can carry keys)."""
    data = await _route(_router("mcp").list_mcp_servers)
    keys = ("name", "transport", "url", "command", "auth", "enabled", "source", "plugin")
    @_scoped
    def custom_names():
        from hermes_cli.mcp_config import _get_mcp_servers
        return {name: ("oauth" if cfg.get("auth") == "oauth" else "header" if cfg.get("headers") else None)
                for name, cfg in _get_mcp_servers().items() if isinstance(cfg, dict) and cfg.get("winglet_custom") is True}
    custom = custom_names()
    return [{**{k: s.get(k) for k in keys},
             "auth": custom.get(s.get("name")) if s.get("name") in custom and s.get("source") != "plugin" else s.get("auth"),
             "custom": s.get("name") in custom and s.get("source") != "plugin"}
            for s in data.get("servers") or []]


async def save_custom_mcp(name: str, config: dict, secrets: dict, edit: bool) -> None:
    """Persist only Winglet-created entries, without executing their command."""
    import asyncio as _asyncio
    if config.get("auth") == "oauth":
        raise HermesRefused("Configure custom OAuth servers through Hermes instead.")
    catalog = await mcp_catalog()
    if not edit and any(e.get("name", "").casefold() == name.casefold() for e in catalog["entries"]):
        raise HermesRefused("That name belongs to a catalog server.")

    @_scoped
    def save():
        try:
            from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server
            from hermes_cli.web_routers._common import config_write_scope
            from tui_gateway.mcp_rpc_helpers import server_configs_with_sources
        except Exception as exc:
            raise HermesUnavailable("Custom MCP configuration unavailable") from exc
        with config_write_scope(_BOT.get() or None):
            # Do not reuse a name while an earlier Winglet sign-in can still write
            # its configuration or credentials back. Conservatively span profiles.
            if any(flow.server_name == name and not flow.worker_done for flow in _sign_ins.values()):
                raise HermesRefused("A sign-in for this name is still running. Wait for it to finish or use a different name.")
            configured = _get_mcp_servers()
            servers, plugins = server_configs_with_sources(configured)
            matches = [n for n in servers if n.casefold() == name.casefold()]
            current = configured.get(name)
            if edit:
                if plugins.get(name) or not isinstance(current, dict) or current.get("winglet_custom") is not True:
                    raise HermesRefused("Only custom servers can be edited.")
                if current.get("auth") == "oauth":
                    raise HermesRefused("Manage this custom OAuth server through Hermes instead.")
                # Until the OAuth token store can be invalidated safely, don't let an
                # existing server name be repointed or change its transport.
                if bool(current.get("url")) != (config["transport"] == "http") or (
                        current.get("url") and current["url"] != config.get("url")):
                    raise HermesRefused("The server address cannot be changed; use a new server name.")
            elif matches:
                raise HermesRefused("A server with that name already exists.")
            elif config["transport"] == "http":
                # Hermes keeps OAuth tokens by server name and removing a server leaves them behind, so a new
                # server reusing the name would be sent the old server's sign-in.
                try:
                    from hermes_cli.mcp_config import _oauth_tokens_present
                    stale = _oauth_tokens_present(name)
                except Exception as exc:
                    raise HermesUnavailable("Couldn't check for an earlier sign-in under this name") from exc
                if stale:
                    raise HermesRefused("An earlier server with this name is still signed in. Use a different name.")
            result = {"winglet_custom": True, "enabled": current.get("enabled", True) if edit else True}
            if config["transport"] == "http":
                result.update(url=config["url"], strict_redirect_headers=True)
                if config["auth"] == "header":
                    headers = secrets.get("headers")
                    if headers is None and edit and current.get("url"):
                        headers = current.get("headers")
                    if not headers:
                        raise HermesRefused("Enter a header key and value.")
                    result["headers"] = headers
            else:
                result.update(command=config["command"], args=config["args"])
                env = secrets.get("env")
                if env is None and edit and current.get("command"):
                    env = current.get("env")
                if env:
                    result["env"] = env
            if not _save_mcp_server(name, result):
                raise HermesRefused("That server configuration was rejected.")
    await _asyncio.to_thread(save)


async def set_mcp_enabled(name: str, enabled: bool) -> None:
    await _route(_router("mcp").set_mcp_server_enabled, name, _models().MCPEnabledToggle(enabled=enabled))


async def test_mcp(name: str) -> dict:
    """Connect, list the tools, disconnect: {ok, error, tools: [{name, description}]}."""
    data = await _route(_router("mcp").test_mcp_server, name)
    tools = [{"name": t.get("name"), "description": str(t.get("description") or "")[:300]} for t in data.get("tools") or []]
    return {"ok": bool(data.get("ok")), "error": data.get("error"), "tools": tools}


async def remove_mcp(name: str) -> None:
    await _route(_router("mcp").remove_mcp_server, name)


async def mcp_catalog() -> dict:
    """Hermes's approved MCP servers. Each entry shows what it runs or connects to, so the owner can
    check before adding it."""
    data = await _route(_router("mcp").list_mcp_catalog)
    keys = ("name", "description", "transport", "auth_type", "required_env", "command", "args", "url",
            "install_url", "needs_install", "post_install", "installed", "enabled")
    return {"entries": [{k: e.get(k) for k in keys} for e in data.get("entries") or []],
            "diagnostics": list(data.get("diagnostics") or [])}


async def install_mcp(name: str, env: dict) -> Optional[str]:
    """Add a catalog server, with the keys it asks for. Returns the action to follow when it has to
    download and build first, else None."""
    started = await _route(_router("mcp").install_mcp_catalog_entry,
                           _models().MCPCatalogInstall(name=name, env=env, enable=True))
    return str(started["action"]) if started.get("background") else None


async def reload_mcp(runner, event) -> str:
    """Hermes's /reload-mcp: reconnect every server and tell running chats their tools changed."""
    reload = getattr(runner, "_execute_mcp_reload", None)
    if reload is None:
        raise HermesUnavailable("MCP reload unavailable")
    return str(await reload(event))


# MCP sign-in: the server's OAuth page opens on the phone and comes back to Winglet, which hands the
# result to the same flow Hermes's dashboard uses.
_SIGN_IN_TTL = 15 * 60
_MAX_SIGN_INS = 4
_sign_ins: dict = {}


def _sign_in_view(flow) -> dict:
    view = flow.snapshot()
    return {"id": view["flow_id"], "server": view["server_name"], "status": view["status"],
            "authorization_url": view["authorization_url"], "error": view["error"],
            "tools": [t.get("name") for t in flow.tools] if view["status"] == "approved" else []}


def _forget_old_sign_ins() -> None:
    import time as _time
    cutoff = _time.time() - _SIGN_IN_TTL
    for flow_id, flow in list(_sign_ins.items()):
        if flow.created_at < cutoff:
            flow.mark_error("Timed out", cancelled=True)
            _sign_ins.pop(flow_id, None)


async def start_mcp_sign_in(name: str, callback_url: str) -> dict:
    import asyncio as _asyncio
    import secrets
    import threading
    try:
        from hermes_cli.mcp_config import _get_mcp_servers
        from hermes_cli.web_server_mcp import _run_dashboard_mcp_oauth
        from hermes_constants import get_hermes_home
        from tools.mcp_dashboard_oauth import DashboardOAuthFlow, exception_message
        from tui_gateway.mcp_rpc_helpers import server_configs_with_sources
    except Exception as exc:
        raise HermesUnavailable("MCP sign-in unavailable") from exc

    @_scoped
    def read():
        servers, plugins = server_configs_with_sources(_get_mcp_servers())
        return servers, plugins, str(get_hermes_home().expanduser().resolve(strict=False))

    servers, plugins, home = await _asyncio.to_thread(read)
    if name not in servers:
        raise HermesRefused(f"There's no MCP server called {name}.")
    if plugins.get(name):
        raise HermesRefused(f"{name} comes with the {plugins[name]} plugin and signs in there.")
    cfg = dict(servers[name])
    if cfg.get("winglet_custom") is True:
        raise HermesRefused("Configure custom OAuth sign-in through Hermes instead.")
    if not cfg.get("url"):
        raise HermesRefused("This server runs on the server itself and uses keys, not a sign-in.")
    if cfg.get("headers") and cfg.get("auth") != "oauth":
        raise HermesRefused("This server uses an API key, not a sign-in.")
    cfg["auth"] = "oauth"
    _forget_old_sign_ins()
    for flow in list(_sign_ins.values()):
        if flow.server_name == name and not flow.worker_done:
            flow.mark_error("Started again", cancelled=True)
    if sum(not f.worker_done for f in _sign_ins.values()) >= _MAX_SIGN_INS:
        raise HermesRefused("Too many sign-ins are in progress. Try again in a few minutes.")
    flow = DashboardOAuthFlow(flow_id=secrets.token_urlsafe(24), server_name=name, profile=_BOT.get(), hermes_home=home,
                              redirect_uri=(cfg.get("oauth") or {}).get("redirect_uri") or callback_url,
                              reconnect_live=True)
    _sign_ins[flow.flow_id] = flow
    threading.Thread(target=_run_dashboard_mcp_oauth, args=(flow, cfg), daemon=True, name=f"winglet-mcp-{name}").start()
    try:
        await flow.wait_for_authorization_url(timeout=30)
    except Exception as exc:
        flow.mark_error(exception_message(exc))
    return _sign_in_view(flow)


def mcp_sign_in(flow_id: str) -> Optional[dict]:
    flow = _sign_ins.get(flow_id)
    return _sign_in_view(flow) if flow is not None else None


def cancel_mcp_sign_in(flow_id: str) -> None:
    flow = _sign_ins.get(flow_id)
    if flow is not None:
        flow.mark_error("Cancelled", cancelled=True)


def finish_mcp_sign_in(server: str, *, code: Optional[str], state: Optional[str], error: Optional[str],
                       iss: Optional[str]) -> str:
    """Hand the browser's return to the waiting sign-in: "ok", "denied", "expired" or "rejected"."""
    import secrets
    flow = next((f for f in _sign_ins.values()
                 if f.server_name == server and f.status == "authorization_required" and f.expected_state
                 and state and secrets.compare_digest(f.expected_state, state)), None)
    if flow is None:
        return "expired"
    try:
        flow.deliver_callback(code=code, state=state, error=error, iss=iss)
    except ValueError:
        return "rejected"
    return "denied" if error else "ok"


# -- sessions: every conversation Hermes has had, on any platform (read-only) ----------------------------

MAX_SESSION_TEXT = 20_000
MAX_TOOL_TEXT = 2_000


def sessions_available() -> bool:
    try:
        r = _router("sessions")
    except HermesUnavailable:
        return False
    # Every keyword the calls below pass. A Hermes that renamed one would otherwise 500 the Sessions screen on every
    # open; reporting it unavailable turns the screen off instead.
    needed = {
        "get_sessions": ("limit", "offset", "min_messages", "archived", "order", "source", "sources", "exclude_sources",
                         "cwd_prefix", "full", "profile"),
        "search_sessions": ("q", "limit", "profile", "source", "sources", "exclude_sources"),
        "get_session_detail": ("profile",),          # the session id goes in by position
        "get_session_messages": ("profile", "limit", "offset", "order", "include_compacted",
                                 "inline_images"),
    }
    return all(callable(getattr(r, name, None)) and _accepts(getattr(r, name), keywords)
               for name, keywords in needed.items())


def _accepts(fn, keywords) -> bool:
    """True when ``fn`` can be called with all of these keyword arguments (or cannot be inspected: then assume yes)."""
    import inspect
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return True
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return True
    return all(name in params and params[name].kind is not inspect.Parameter.POSITIONAL_ONLY for name in keywords)


def _session_row(row: dict) -> dict:
    preview = " ".join(str(row.get("preview") or "").split())
    return {"id": str(row.get("id") or ""), "title": row.get("title") or row.get("display_name") or None,
            "source": row.get("source") or "", "model": row.get("model") or "",
            "started_at": row.get("started_at"), "last_active": row.get("last_active") or row.get("started_at"),
            "message_count": int(row.get("message_count") or 0), "tool_call_count": int(row.get("tool_call_count") or 0),
            "preview": preview[:200], "active": bool(row.get("is_active")), "pinned": bool(row.get("pinned"))}


def list_sessions(limit: int, offset: int) -> dict:
    """The most recently active conversations first, across every platform and routine."""
    get_sessions = _router("sessions").get_sessions
    try:
        with _profile_scope():
            # Called directly, so every query parameter is passed: their defaults are FastAPI markers.
            page = get_sessions(limit=limit, offset=offset, min_messages=1, archived="exclude", order="recent",
                                source=None, sources=None, exclude_sources=None, cwd_prefix=None, full=False,
                                profile=_BOT.get())
    except Exception as exc:
        if isinstance(getattr(exc, "status_code", None), int):
            raise HermesRefused(_detail(exc)) from exc
        raise
    return {"sessions": [_session_row(s) for s in page.get("sessions") or []], "total": int(page.get("total") or 0)}


async def search_sessions(query: str, limit: int = 30) -> list:
    r = _router("sessions")
    found = await _route(lambda: r.search_sessions(q=query, limit=limit, profile=_BOT.get(), source=None, sources=None,
                                                   exclude_sources=None))
    return [{**_session_row(x), "snippet": str(x.get("snippet") or "")[:300], "role": x.get("role")}
            for x in found.get("results") or []]


def _message_text(message: dict) -> str:
    content = message.get("display_content")
    if content is None:
        content = message.get("content")
    if isinstance(content, list):
        content = " ".join(str(part.get("text") or "") if isinstance(part, dict) else str(part) for part in content)
    return str(content or "")


def _tool_names(calls) -> list:
    if isinstance(calls, str):
        try:
            calls = json.loads(calls)
        except ValueError:
            return []
    names = []
    for call in calls or []:
        if isinstance(call, dict):
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = fn.get("name") or call.get("name")
            if name:
                names.append(str(name))
    return names


def _session_message(message: dict) -> Optional[dict]:
    role = message.get("role")
    if role not in ("user", "assistant", "tool") or message.get("display_kind") == "hidden":
        return None
    text = _message_text(message)
    limit = MAX_TOOL_TEXT if role == "tool" else MAX_SESSION_TEXT
    try:
        at = float(message.get("timestamp")) if message.get("timestamp") is not None else None
    except (TypeError, ValueError):
        at = None
    item = {"id": str(message.get("id") or message.get("message_uid") or ""), "role": role,
            "text": text if len(text) <= limit else text[:limit] + "…", "at": at,
            "failed": message.get("display_kind") == "failed_turn"}
    if role == "assistant":
        item["tools"] = _tool_names(message.get("tool_calls"))
    if role == "tool":
        item["tool"] = message.get("tool_name") or ""
    if not item["text"] and not item.get("tools"):
        return None
    return item


async def session_transcript(session_id: str) -> dict:
    """One conversation's latest 500 messages, as text: images are named, not sent."""
    r = _router("sessions")
    detail = await _route(lambda: r.get_session_detail(session_id, profile=_BOT.get()))
    page = await _route(lambda: r.get_session_messages(session_id, profile=_BOT.get(), limit=None, offset=0, order=None,
                                                       include_compacted=False, inline_images=False))
    messages = [m for m in (_session_message(x) for x in page.get("messages") or []) if m]
    return {"session": _session_row(detail), "messages": messages,
            "truncated": (page.get("pagination") or {}).get("returned", 0) >= 500}


# -- pets: the agent's animated face, from Hermes's own pet store (agent/pet) and petdex.dev --------

PET_CATALOG_PAGE = 30
_pet_sheets: dict = {}


def _pet_engine():
    try:
        from agent.pet import constants, manifest, store
        from hermes_cli import pets as pet_config
    except Exception as exc:
        raise HermesUnavailable("pets unavailable") from exc
    return constants, manifest, store, pet_config


def pets_available() -> bool:
    try:
        _pet_engine()
        return True
    except HermesUnavailable:
        return False


def _pet_settings() -> dict:
    """``display.pet`` from the config: slug, enabled and the desktop's own settings."""
    from hermes_cli.config import load_config
    display = load_config().get("display")
    pet = display.get("pet") if isinstance(display, dict) else None
    return pet if isinstance(pet, dict) else {}


def _truthy(value) -> bool:
    try:
        from utils import is_truthy_value
        return is_truthy_value(value, default=False)
    except ImportError:
        return str(value).strip().lower() in ("1", "true", "yes", "on")


def _active_pet():
    """The pet Hermes shows: the configured one when the display is on, else None. Like Hermes, a
    configured pet that's gone falls back to the first one installed."""
    _, _, store, _ = _pet_engine()
    settings = _pet_settings()
    if not _truthy(settings.get("enabled")):
        return None
    return store.resolve_active_pet(str(settings.get("slug") or ""))


def _pet_sheet(pet) -> dict:
    """How to cut a pet's spritesheet into frames, worked out once per version of the file."""
    constants, _, _, _ = _pet_engine()
    stat = pet.spritesheet.stat()
    key = (str(pet.spritesheet), stat.st_mtime_ns, stat.st_size)
    if key not in _pet_sheets:
        from PIL import Image
        from agent.pet import render
        from .petcolor import pet_palette
        with Image.open(pet.spritesheet) as image:
            width, height = image.size
            rows = max(1, height // constants.FRAME_H)
            state_rows = list(constants.state_rows_for_grid(rows))
            idle = state_rows.index("idle") if "idle" in state_rows else 0
            try:
                palette = pet_palette(image.crop((0, idle * constants.FRAME_H, constants.FRAME_W, (idle + 1) * constants.FRAME_H)))
            except Exception:  # a palette is a nicety; the sheet must still load
                palette = None
        try:
            frames = render.state_frame_counts(str(pet.spritesheet))
        except Exception:
            frames = {}
        while len(_pet_sheets) >= 8:
            _pet_sheets.pop(next(iter(_pet_sheets)))
        _pet_sheets[key] = {
            "revision": hashlib.sha256(repr(key).encode()).hexdigest()[:16],
            "mime": "image/png" if pet.spritesheet.suffix.lower() == ".png" else "image/webp",
            "frame_w": constants.FRAME_W, "frame_h": constants.FRAME_H,
            "columns": max(1, width // constants.FRAME_W), "rows": rows,
            "state_rows": state_rows, "frames_per_state": constants.FRAMES_PER_STATE,
            "frames": {str(k): int(v) for k, v in frames.items()}, "loop_ms": constants.LOOP_MS,
            **({"palette": palette} if palette else {}),
        }
    return {**_pet_sheets[key], "slug": pet.slug, "name": pet.display_name, "path": str(pet.spritesheet)}


@_scoped
def active_pet() -> Optional[dict]:
    """The agent's pet with its spritesheet's geometry, or None when it has none showing."""
    pet = _active_pet()
    return _pet_sheet(pet) if pet is not None and pet.exists else None


@_scoped
def pet_sheet(slug: str) -> Optional[dict]:
    """Any installed pet's spritesheet, for previews."""
    _, _, store, _ = _pet_engine()
    pet = store.load_pet(slug)
    return _pet_sheet(pet) if pet is not None and pet.exists else None


def _pet_author(store, pet) -> dict:
    """{"by": name} for a pet whose pet.json names its creator (pets from codex-pets.net do), else nothing."""
    by = store._read_pet_json(pet.directory).get("author")
    return {"by": by[:80]} if isinstance(by, str) and by.strip() else {}


@_scoped
def pets() -> dict:
    """Installed pets, and the one showing."""
    _, _, store, _ = _pet_engine()
    active = _active_pet()
    return {"enabled": active is not None, "active": active.slug if active else "",
            "pets": [{"slug": p.slug, "name": p.display_name, "description": p.description, "generated": p.generated,
                      **_pet_author(store, p)} for p in store.installed_pets()]}


def prefetch_pet_catalog() -> None:
    """Start fetching the petdex gallery in the background (Hermes caches it), so it's ready when asked."""
    _, manifest, _, _ = _pet_engine()
    manifest.prefetch()


@_scoped
def pet_catalog(query: str = "", offset: int = 0, limit: int = PET_CATALOG_PAGE) -> dict:
    """A page of the petdex gallery, hand-picked pets first, with what's installed here marked."""
    _, manifest, store, _ = _pet_engine()
    try:
        entries = manifest.fetch_manifest()
    except manifest.ManifestError as exc:
        raise HermesRefused("Couldn't reach the pet gallery at petdex.dev. Try again later.") from exc
    installed = {p.slug for p in store.installed_pets()}
    words = query.lower().split()
    found = [e for e in entries if all(w in f"{e.slug} {e.display_name} {e.submitted_by}".lower() for w in words)]
    found.sort(key=lambda e: "/curated/" not in e.spritesheet_url)
    return {"total": len(found), "pets": [
        {"slug": e.slug, "name": e.display_name, "kind": e.kind, "by": e.submitted_by,
         "curated": "/curated/" in e.spritesheet_url, "installed": e.slug in installed}
        for e in found[offset:offset + limit]]}


@_scoped
def pet_thumbnail(slug: str) -> Optional[bytes]:
    """A small PNG of a pet's first frame. Pets that aren't installed are fetched from petdex once and
    cached; Hermes only fetches from petdex's own hosts."""
    from . import petsource
    _, manifest, store, _ = _pet_engine()
    pet = store.load_pet(slug)
    if pet is not None and pet.exists:
        return store.thumbnail_png(pet.slug)
    if (codex := petsource.codex_id(slug)) is not None:  # from codex-pets.net, through Winglet's own downloader
        return petsource.thumbnail(codex, store._thumb_path(slug))
    try:
        entry = manifest.find_entry(slug)
    except manifest.ManifestError:
        return None
    return store.thumbnail_png(entry.slug, source_url=entry.spritesheet_url) if entry else None


@_scoped
def pet_catalog_from(source: str, query: str = "", offset: int = 0, limit: int = PET_CATALOG_PAGE) -> dict:
    """A page of another source's gallery (codex-pets.net), with what's installed here marked. Petdex is
    `pet_catalog`; this is only for the sources Winglet downloads from itself."""
    from . import petsource
    if source != "codex":
        raise HermesRefused("That pet source isn't offered.")
    _, _, store, _ = _pet_engine()
    try:
        page = petsource.catalog_page(query, offset)
    except petsource.PetSourceError as exc:
        raise HermesRefused("Couldn't reach the pet gallery at codex-pets.net. Try again later.") from exc
    installed = {p.slug for p in store.installed_pets()}
    return {"total": page["total"], "next_offset": page["next_offset"], "pets": [
        {"slug": e["slug"], "name": e["name"], "kind": e["kind"], "by": e["by"], "curated": False,
         "description": e["description"], "installed": e["slug"] in installed}
        for e in page["pets"][:limit]]}


@_scoped
def adopt_pet_from(source: str, slug: str) -> dict:
    """Install a pet from another source when it isn't here yet, and make it the one showing."""
    from . import petsource
    if source != "codex" or (pet_id := petsource.codex_id(slug)) is None:
        raise HermesRefused("That pet source isn't offered.")
    _, _, store, pet_config = _pet_engine()
    pet = store.load_pet(slug)
    if pet is None or not pet.exists:
        try:
            petsource.install(pet_id, store.pets_dir())
        except petsource.PetSourceError as exc:
            raise HermesRefused(f"Couldn't get that pet: {exc}") from exc
        pet = store.load_pet(slug)
        if pet is None or not pet.exists:
            raise HermesRefused("Couldn't get that pet: the install didn't produce a spritesheet.")
    pet_config._set_active(pet.slug)
    return {"slug": pet.slug, "name": pet.display_name}


@_scoped
def pet_installed(slug: str) -> bool:
    _, _, store, _ = _pet_engine()
    pet = store.load_pet(slug)
    return pet is not None and pet.exists


@_scoped
def adopt_pet(slug: str) -> dict:
    """Install a pet from petdex when it isn't here yet, and make it the one showing."""
    _, manifest, store, pet_config = _pet_engine()
    try:
        pet = store.install_pet(slug)
    except (store.PetStoreError, manifest.ManifestError) as exc:
        raise HermesRefused(f"Couldn't get that pet: {exc}") from exc
    pet_config._set_active(pet.slug)
    return {"slug": pet.slug, "name": pet.display_name}


@_scoped
def remove_pet(slug: str) -> bool:
    """Delete an installed pet. When it was the one showing, the display turns off, as in Hermes."""
    _, _, store, pet_config = _pet_engine()
    removed = store.remove_pet(slug)
    pet_config._clear_active_if(slug)
    return removed


@_scoped
def show_pet(on: bool) -> Optional[dict]:
    """Turn the pet display on (the configured pet, else the first installed) or off."""
    _, _, store, pet_config = _pet_engine()
    if not on:
        pet_config._set_enabled(False)
        return None
    pet = store.resolve_active_pet(str(_pet_settings().get("slug") or ""))
    if pet is None:
        raise HermesRefused("Adopt a pet first.")
    pet_config._set_active(pet.slug)
    return {"slug": pet.slug, "name": pet.display_name}



# -- bots: Hermes profiles served by this gateway, each its own agent (Hermes Desktop's Bots) -------

def _rpc(method: str, params: dict) -> dict:
    """Call one of Hermes's own profile handlers (the ones Hermes Desktop uses), so a bot made here is
    made exactly as Desktop makes it."""
    try:
        from tui_gateway import server
        handler = server._methods[method]
    except Exception as exc:
        raise HermesUnavailable(f"{method} unavailable") from exc
    reply = handler("winglet", params) or {}
    if reply.get("error"):
        raise HermesRefused(str((reply["error"] or {}).get("message") or "Hermes refused that."))
    return reply.get("result") or {}


def bots_available() -> bool:
    try:
        from hermes_cli.profiles import profiles_to_serve, read_profile_meta  # noqa: F401
        from tui_gateway import server
        return "profiles.create" in server._methods
    except Exception:
        return False


def _bot_row(name: str, home) -> dict:
    from hermes_cli.profiles import read_profile_meta
    meta = read_profile_meta(home)
    title = meta.get("bot_title") or meta.get("display_name") or name.replace("-", " ").replace("_", " ").title()
    return {"name": name, "title": title, "description": meta.get("description") or ""}


def _bot_queue_entry(sequence, identity, status, raw) -> dict:
    """One row of the owner's queue sheet from an admission. ``title`` is the first line of the request (the hub swaps in
    the title its sender gave ask_bot, when it can match the delivery id); ``preview`` is the older, longer text that
    apps without titles still show. Nothing else from the payload leaves this function."""
    import re
    from .handoffs import first_line_title
    sender, preview, title = "Unknown sender", "Details unavailable", "Details unavailable"
    try:
        payload = json.loads(raw)
        descriptor = payload.get("local_automation_v1") or (payload.get("native_text_v1") or {}).get("automation") or {}
        author = descriptor.get("turn_author") or {}
        if isinstance(author.get("name"), str):
            sender = " ".join(author["name"].split())[:60] or sender
        text = payload.get("text")
        if isinstance(text, str) and descriptor:
            text = text.split("\n\n(Answer in your reply", 1)[0]
            text = re.sub(r'^Message from 🤖 .*?\(@[^)]+\)(?:, sent from the chat ".*?")?:\s*', '', text, count=1)
            preview = " ".join(text.split())[:120] or "Details unavailable"
            title = first_line_title(text) or "Details unavailable"
    except (ValueError, TypeError, AttributeError):
        pass
    return {"id": identity, "sequence": sequence, "from": sender, "title": title, "preview": preview, "status": status}


BACKGROUND_FILE = "processes.json"  # Hermes's crash-recovery checkpoint, written atomically
BACKGROUND_FILE_MAX_BYTES = 2 * 1024 * 1024
BACKGROUND_MAX_ENTRIES = 500
def _started_before(ticks: int, recorded) -> bool:
    """For an entry with no ``host_start_time``: did this process start no later than the entry says it was spawned?
    A reused pid belongs to a process that started afterwards. With no usable ``started_at`` it cannot be shown."""
    import os
    if type(recorded) not in (int, float) or not 0 < recorded < 2**40:
        return False
    try:
        boot = next(int(line.split()[1]) for line in (_PROC_ROOT / "stat").read_text().splitlines()
                    if line.startswith("btime "))
        started = boot + ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, StopIteration, ValueError, IndexError):
        return False
    return started <= recorded + 2   # btime is whole seconds: allow for that


_PROC_ROOT = Path("/proc")  # Linux process table; absent elsewhere, where a recorded start time cannot be verified


def _background_prefix(profile) -> str:
    # gateway.session._session_key_namespace: default uses main; a profile literally named main uses main~.
    name = "main" if not profile or profile == "default" else "main~" if profile == "main" else profile
    return f"agent:{name}:"


def _background_count(home: Path, profile: str) -> int:
    """Read only Hermes's persisted checkpoint. Never import its live registry or expose commands.

    The registry is process-global, so a checkpoint can contain several profiles. Read both this
    profile's file and the gateway home's file, match session namespaces exactly, and deduplicate
    session IDs. Unsupported or unreadable entries contribute nothing, not an unknown activity state.
    """
    import os
    homes = {Path(home)}
    try:
        from hermes_cli.profiles import _get_default_hermes_home
        homes.add(Path(_get_default_hermes_home()))
    except Exception:
        pass
    seen = set()
    checked = 0
    prefix = _background_prefix(profile)
    for folder in sorted(homes, key=str):
        try:
            with (folder / BACKGROUND_FILE).open("rb") as source:
                raw = source.read(BACKGROUND_FILE_MAX_BYTES + 1)
            if len(raw) > BACKGROUND_FILE_MAX_BYTES:
                continue
            entries = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(entries, list):
                continue
        except (OSError, ValueError, UnicodeError):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            key, identity, pid = entry.get("session_key"), entry.get("session_id"), entry.get("pid")
            if not isinstance(key, str) or not key.startswith(prefix):
                continue  # another bot's: it must not use up this bot's budget
            if checked >= BACKGROUND_MAX_ENTRIES:
                return len(seen)
            checked += 1
            if not isinstance(identity, str) or not identity or identity in seen:
                continue
            if type(pid) is not int or not 0 < pid <= 2**31 - 1 or entry.get("pid_scope", "host") != "host":
                continue
            expected = entry.get("host_start_time")
            if expected is not None and (type(expected) is not int or expected < 0):
                continue
            try:
                os.kill(pid, 0)  # liveness only; never signal, reap, or change the registry
                if _PROC_ROOT.is_dir():
                    fields = (_PROC_ROOT / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
                    if fields[0] in ("Z", "X") or expected is not None and int(fields[19]) != expected:
                        continue
                    if expected is None and not _started_before(int(fields[19]), entry.get("started_at")):
                        continue  # no recorded start: a process that began after the entry was written is a reused pid
                elif expected is not None:
                    continue  # cannot prove this is still the recorded process on this platform
            except (OSError, ValueError, IndexError, OverflowError):
                continue
            seen.add(identity)
    return len(seen)


def bot_activity(home: Path, profile: str = "default", *, include_queue: bool = False) -> dict:
    """Read-only activity: live gateway work plus the canonical hand-off FIFO, never receipt mtimes.

    Run off the gateway loop: the control verb schedules its own loop callback. Missing Hermes
    APIs/schema mean unknown, not idle. Queue previews are optional, bounded, owner-only display
    data; raw admission envelopes, replies and credentials are never returned to the app.
    """
    import sqlite3
    queued = None
    queue = None
    truncated = False
    started = 0
    try:
        with contextlib.closing(sqlite3.connect((Path(home) / "state.db").resolve().as_uri() + "?mode=ro", uri=True,
                                               timeout=0.2)) as db:
            db.execute("BEGIN")  # counts and displayed entries share one read-only snapshot
            counts = dict(db.execute("SELECT status, COUNT(*) FROM session_admissions "
                                     "WHERE request_id LIKE 'bot:%' AND status IN ('queued', 'started') GROUP BY status"))
            queued = counts.get("queued", 0)
            started = counts.get("started", 0)
            if include_queue:
                try:
                    rows = list(db.execute("SELECT seq, request_id, status, substr(payload_json, 1, 65536) "
                                           "FROM session_admissions WHERE request_id LIKE 'bot:%' "
                                           "AND status IN ('queued', 'started') ORDER BY seq LIMIT 51"))
                    queue = [_bot_queue_entry(*row) for row in rows[:50]]
                    truncated = len(rows) > 50
                except sqlite3.Error:
                    pass  # Old schema: retain counts but do not invent queue details.
    except (OSError, sqlite3.Error):
        pass
    try:
        from gateway.control_socket import query_gateway_control
        # One gateway serves every bot and listens in the main Hermes home. A bot's own folder has no
        # socket, so asking there answers nothing and the bot would always read as "unknown".
        try:
            from hermes_cli.profiles import _get_default_hermes_home
            host = _get_default_hermes_home()
        except Exception:
            host = Path(home)
        work = query_gateway_control(host, "active-work", params={"profile": profile}, timeout=1.0)
        count = (work or {}).get("active_agents")
        known = type(count) is int and count >= 0
    except Exception:
        known, count = False, None
    # The profile-scoped control verb intentionally excludes delegations. This plugin runs in
    # the gateway process, so its thread-safe live registry supplies their origin session keys.
    delegating = False
    delegation_known = True
    try:
        from tools.async_delegation import list_async_delegations, _LIVE_STATES
        from gateway.session import _session_key_namespace
        prefix = _session_key_namespace(profile) + ":"
        for record in list_async_delegations():
            if record.get("status") not in _LIVE_STATES:
                continue
            key = str(record.get("session_key") or "")
            if key.startswith(prefix):
                delegating = True
            elif not key.startswith("agent:"):
                delegation_known = False  # no trustworthy profile attribution
    except Exception:
        delegation_known = False
    background = _background_count(home, profile)
    state = ("working" if background or known and (count or started or delegating) else
             "idle" if known and queued is not None and delegation_known else "unknown")
    extra = {"background": background, "reason": "Running a background task" if background == 1 else f"Running {background} background tasks"} if background else {}
    return {"state": state, "queued": queued, **({"queue": queue, "queue_truncated": truncated} if include_queue else {}), **extra}


def bot_activities() -> dict:
    from hermes_cli.profiles import profiles_to_serve
    return {name: bot_activity(home, name, include_queue=True) for name, home in profiles_to_serve(multiplex=True)}


def list_bots() -> List[dict]:
    """Every profile this install has, other than the main one, as a bot. Made in Hermes Desktop, the CLI
    or here: they're all the same."""
    from hermes_cli.profiles import profiles_to_serve
    return [_bot_row(name, home) for name, home in profiles_to_serve(multiplex=True) if name != "default"]


def create_bot(name: str, title: str, persona: str, description: str = "") -> dict:
    """A new profile set up the way Hermes Desktop's Create bot does: the main profile's provider keys and
    model (never its chat-platform tokens), the bundled skills, the persona as SOUL.md, and the Bot Mode
    title that makes it a teammate of the other bots."""
    from hermes_cli.profiles import normalize_profile_name, validate_profile_name
    try:
        name = normalize_profile_name(name)
        validate_profile_name(name)
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc
    _rpc("profiles.create", {"name": name, "soul": persona, "description": description})
    _rpc("profiles.configure", {"name": name, "ui_meta": {"hermes-bots": {"title": title, "created": int(time.time() * 1000)}}})
    from hermes_cli.profiles import get_profile_dir
    try:
        _enable_winglet_for(name)
    except Exception:
        # The bot exists and works in Hermes; it just isn't reachable from this app until Winglet is enabled in
        # its profile (`hermes -p <name> plugins enable winglet`, then `config set platforms.winglet.enabled true`).
        logger.warning("[winglet] couldn't enable Winglet in the %s profile", name, exc_info=True)
    else:
        _ask_gateway_to_rescan_plugins(name)
    return _bot_row(name, get_profile_dir(name))


# Tries (about half a second apart) while the gateway is still taking a new profile in.
GATEWAY_RESCAN_TRIES = 8


def _ask_gateway_to_rescan_plugins(name: str) -> bool:
    """Make the running gateway look at the new bot's plugins again, now that Winglet is set up in it.

    `profiles.create` publishes the profile and tells the gateway about it before it returns, so the gateway reads
    the profile's plugins while Winglet's symlink and config don't exist yet. It reads them once per profile
    (`discover_plugins()` is a no-op after the first scan, and its retry loop only re-arms plugins that scan saw), so
    without this the bot's Winglet adapter never starts until the gateway restarts. Hermes's own `plugins enable`
    sends the same `reload-plugins` request to the gateway for the same reason. Best effort: the bot is made either way.
    """
    try:
        from gateway.control_socket import reload_gateway_plugins
        from hermes_cli.profiles import get_profile_dir
        from hermes_constants import get_default_hermes_root
        root, home = get_default_hermes_root(), get_profile_dir(name)
    except Exception:
        logger.debug("[winglet] this Hermes can't be asked to reload plugins", exc_info=True)
        return False
    answer = None
    for attempt in range(GATEWAY_RESCAN_TRIES):
        try:
            answer = reload_gateway_plugins(root, profile_home=home)
        except Exception:
            logger.debug("[winglet] asking the gateway to reload plugins failed", exc_info=True)
            return False
        if answer is None:  # no gateway answered (none running, or one too old for the request): asking again won't help
            break
        if answer.get("reloaded"):
            return True
        if attempt + 1 < GATEWAY_RESCAN_TRIES:  # "not served" yet: the gateway is still taking the new profile in
            time.sleep(0.5)
    logger.warning("[winglet] the gateway wasn't told to load Winglet for the %s bot%s; if it shows as not running, "
                   "restart the gateway", name, f" ({answer.get('error')})" if answer and answer.get("error") else "")
    return False


def _enable_winglet_for(name: str) -> None:
    """Hermes serves a profile in this app only through a Winglet adapter of its own, and builds one only for a
    profile that has the plugin and the platform enabled. Do what `hermes -p <name> plugins enable winglet` and
    `config set platforms.winglet.enabled true` do; Hermes's running gateway notices the change and starts it."""
    from pathlib import Path
    from hermes_cli.config import read_raw_config, save_config
    from hermes_cli.profiles import get_profile_dir
    plugin_dir = Path(__file__).resolve().parent
    link = get_profile_dir(name) / "plugins" / "winglet"
    if not link.exists():
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(plugin_dir, target_is_directory=True)  # the one installed copy, so updates reach every bot
    with _bot_scope(name):
        cfg = read_raw_config()
        plugins = cfg.setdefault("plugins", {})
        enabled = [p for p in (plugins.get("enabled") or []) if isinstance(p, str)]
        if "winglet" not in enabled:
            enabled.append("winglet")
        plugins["enabled"] = enabled
        plugins["disabled"] = [p for p in (plugins.get("disabled") or []) if p != "winglet"]
        cfg.setdefault("platforms", {}).setdefault("winglet", {})["enabled"] = True
        save_config(cfg)


def multiplex_state(runner) -> dict:
    """Whether this gateway serves every profile (Hermes's multi-profile mode), which profiles it serves,
    and, when it serves only one, Hermes's own reason why."""
    served: List[str] = []
    with contextlib.suppress(Exception):
        served = [str(n) for n in runner.served_profile_names()]
    active = False
    with contextlib.suppress(Exception):
        from agent.secret_scope import is_multiplex_active
        active = bool(is_multiplex_active())
    reason = ""
    if not active:
        with contextlib.suppress(Exception):
            from gateway.status import read_runtime_status
            reason = str((read_runtime_status() or {}).get("multiplex_standalone_reason") or "")
    return {"multiplex": active or len(served) > 1, "served": served, "reason": reason}


def _bot_meta(name: str) -> dict:
    """The bot's Bot Mode settings (title, color…) as Hermes Desktop stores them in profile.yaml."""
    import yaml
    from hermes_cli.profiles import get_profile_dir
    path = get_profile_dir(name) / "profile.yaml"
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        data = {}
    meta = (data.get("ui_meta") or {}).get("hermes-bots") if isinstance(data, dict) else None
    return dict(meta) if isinstance(meta, dict) else {}


def rename_bot(name: str, title: str) -> dict:
    """Change the name a bot goes by, as Hermes Desktop does. Its profile id (what other bots and the
    CLI call it) stays, so nothing that refers to it breaks."""
    if name not in {b["name"] for b in list_bots()}:
        raise HermesRefused("That bot isn't on this server any more.")
    _rpc("profiles.configure", {"name": name, "ui_meta": {"hermes-bots": {**_bot_meta(name), "title": title}}})
    from hermes_cli.profiles import get_profile_dir
    return _bot_row(name, get_profile_dir(name))


def delete_bot(name: str) -> None:
    """Delete a bot's profile, with its memory, skills and sessions, as `hermes profile delete` does."""
    if name not in {b["name"] for b in list_bots()}:
        raise HermesRefused("That bot isn't on this server any more.")
    from hermes_cli.profiles import delete_profile
    try:
        delete_profile(name, yes=True)
    except (ValueError, FileNotFoundError) as exc:
        raise HermesRefused(str(exc)) from exc


def config_available() -> bool:
    from .advanced_config import available
    return available()


@_scoped
def advanced_config(body=None, *, apply=False, authorize=lambda: None):
    from .advanced_config import ConfigRefused, operate
    try:
        return operate(body, apply=apply, authorize=authorize)
    except ConfigRefused:
        raise
    except Exception:
        raise ConfigRefused("Hermes could not safely read or save these settings. Check the configuration on the server.", status=503) from None
