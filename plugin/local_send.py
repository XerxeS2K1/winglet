"""Post one bot message into a chosen chat from another process (a cron script, ``hermes send``).

A separate process cannot reach the running gateway's sockets or push, and writing the database from
outside would show the message only after a phone reconnects. So the running hub accepts one
loopback-only POST, and this module holds both halves:

* the hub side: the on/off switch, the token file, the checks the request must pass, and the text clean-up;
* the sender side: ``standalone_sender_fn``, which Hermes calls for ``hermes send --to winglet:<chat id>``.

It is OFF unless ``WINGLET_LOCAL_SEND`` (or ``local_send`` in the platform's ``extra``) is true. When on, the
gateway writes ``<plugin data>/local-send.json`` (mode 0600: the loopback URL and a fresh random token) at
start and removes it on stop. Only a process that can read that file can post. It never creates a chat:
a chat that does not exist, or was deleted, is refused.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

PATH = "/api/local/send"
FILE_NAME = "local-send.json"
MAX_TEXT = 16_000                      # same ceiling as a typed message; over it is refused, not cut
LOOPBACK = ("127.0.0.1", "::1")
# A tunnel (cloudflared and friends) connects from loopback too, so traffic that came through a proxy is refused.
PROXY_HEADERS = ("X-Forwarded-For", "Forwarded", "X-Real-IP", "CF-Connecting-IP", "Cf-Ray", "X-Forwarded-Host")
NOTIFY_ENV = "WINGLET_SEND_NOTIFY"
FILE_ENV = "WINGLET_LOCAL_SEND_FILE"
TIMEOUT = 10
_TRUTHY = ("1", "true", "yes", "on")
_FALSY = ("0", "false", "no", "off")


class Refused(ValueError):
    """The text or request can't be posted; the message is safe to show to the caller."""


def clean_text(text: Any) -> str:
    """Printable text: line breaks and tabs kept, other control and direction-changing characters dropped."""
    if not isinstance(text, str):
        raise Refused("text must be a string")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    kept = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch) not in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"))
    kept = kept.strip()
    if not kept:
        raise Refused("text is empty")
    if len(kept) > MAX_TEXT:
        raise Refused(f"text is {len(kept):,} characters; the limit is {MAX_TEXT:,}")
    return kept


def enabled(extra: Optional[Dict[str, Any]], secret: Any) -> bool:
    value = (extra or {}).get("local_send", secret)
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in _TRUTHY


def _write_private(path: Path, data: Dict[str, Any]) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def publish(directory: Path, port: int) -> str:
    """Make a fresh token, write the token file, and return the token."""
    token = secrets.token_urlsafe(32)
    _write_private(Path(directory) / FILE_NAME, {"url": f"http://127.0.0.1:{int(port)}", "token": token})
    return token


def withdraw(directory: Path) -> None:
    try:
        (Path(directory) / FILE_NAME).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("[winglet] couldn't remove the local-send token file")


def request_problem(remote: Optional[str], headers, bearer: str, token: Optional[str]) -> Optional[str]:
    """Why this request may not post, or None. Off, wrong origin and wrong token all look the same to the caller."""
    if not token:
        return "off"
    if remote not in LOOPBACK or any(headers.get(h) for h in PROXY_HEADERS):
        return "not local"
    if not bearer or not hmac.compare_digest(bearer.encode(), token.encode()):
        return "bad token"
    return None


# -- the sender side ------------------------------------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # the token must never follow a redirect
        return None


def _post(url: str, token: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    # No proxy: the token is for the loopback address only.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
    request = urllib.request.Request(
        url + PATH, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            return json.loads(response.read(65536) or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            said = json.loads(exc.read(4096)).get("error")
        except Exception:
            said = None
        raise Refused(str(said or f"Winglet answered HTTP {exc.code}")[:200]) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Refused("Winglet isn't reachable on this machine (is the gateway running?)") from None


def _data_dir(pconfig: Any) -> Path:
    from .adapter import data_dir
    return data_dir()


def token_file(pconfig: Any) -> Path:
    """Where the gateway left the token. WINGLET_LOCAL_SEND_FILE overrides it for a script run under another
    Hermes profile than the gateway's (the data directory follows the profile)."""
    override = str(os.environ.get(FILE_ENV, "")).strip()
    return Path(override) if override else _data_dir(pconfig) / FILE_NAME


def _notify(default: bool = True) -> bool:
    value = str(os.environ.get(NOTIFY_ENV, "")).strip().lower()
    return False if value in _FALSY else True if value in _TRUTHY else default


async def standalone_sender(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
    """Hermes's out-of-process sender: ``hermes send --to winglet:<chat id> "text"``. Text only."""
    if media_files:
        return {"error": "Winglet's out-of-process send is text only"}
    try:
        text = clean_text(message)
        chat = str(chat_id or "").strip()
        if not chat:
            raise Refused("no chat id")
        try:
            info = json.loads(token_file(pconfig).read_text())
            url, token = str(info["url"]), str(info["token"])
        except (OSError, ValueError, KeyError, TypeError):
            raise Refused("Winglet's local send is off or the gateway isn't running "
                          "(set WINGLET_LOCAL_SEND=true and restart the gateway)") from None
        answer = await asyncio.to_thread(_post, url, token, {"chat_id": chat, "text": text, "notify": _notify()})
    except Refused as exc:
        return {"error": str(exc)}
    return {"success": True, "message_id": answer.get("message_id")}
