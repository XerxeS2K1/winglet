"""Live browser screen + takeover, behind the ``screen_watch`` switch.

This module deliberately imports Hermes only inside methods.  Winglet is loaded by
older Hermes builds too, and a missing browser stack must not stop the plugin
from registering the chat platform.

The screen is captured through Hermes's supported in-process CDP seam:
``tools.browser_supervisor.SUPERVISOR_REGISTRY.capture(task_id)``.  It never
starts, reconnects or focuses a supervisor; the agent's own browser tool does
that.  Every public method turns a failure into ``None`` (or ``False``) and a
short reason, so a dead browser cannot raise into the adapter or a hub route.
"""

from __future__ import annotations

import base64
import math
import time
from typing import Any, Dict, FrozenSet, Optional, Tuple

VALID_DIALOG_POLICIES: FrozenSet[str] = frozenset({"auto_accept", "auto_dismiss", "must_respond"})
DEFAULT_DIALOG_POLICY = "auto_dismiss"
_TARGET_TIMEOUT = 3.0
_SCREENSHOT_TIMEOUT = 8.0
_MAX_TEXT = 4000
_MAX_SCROLL = 10_000.0
_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in _TRUTHY


def _config_get(config: Any, path: str, default: Any = None) -> Any:
    node = config
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def screen_watch_enabled(config: Optional[Dict[str, Any]] = None) -> bool:
    """Read the ``screen_watch`` switch from Hermes's config, defaulting to off.

    The same key is accepted at the top level (where the plugin's advanced
    settings live), under ``browser`` for a browser-shaped setting, and in the
    Winglet platform's ``extra`` block for parity with its environment layout.
    """
    if config is None:
        try:
            from hermes_cli.config import load_config
            config = load_config()
        except Exception:
            return False
    if not isinstance(config, dict):
        return False
    for path in ("screen_watch", "browser.screen_watch", "plugins.winglet.screen_watch",
                 "platforms.winglet.extra.screen_watch"):
        value = _config_get(config, path)
        if value is not None and _truthy(value):
            return True
    return False


def _configured_dialog_policy() -> str:
    """Hermes's browser dialog policy, normalised to the three supervisor values."""
    try:
        from tools.browser_session_cdp import get_dialog_policy_config
        policy, _timeout = get_dialog_policy_config()
        policy = str(policy or "").strip().lower()
        if policy in VALID_DIALOG_POLICIES:
            return policy
    except Exception:
        pass
    return DEFAULT_DIALOG_POLICY


def _reason(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    return f"{type(exc).__name__}: {text[:180]}" if text else type(exc).__name__


class ScreenCapture:
    """A tiny, failure-tolerant wrapper around the agent's browser CDP handle."""

    def __init__(self, task_id: Optional[str] = None, *, dialog_policy: Optional[str] = None,
                 registry: Any = None, invalid_exception: Any = None) -> None:
        self.task_id = str(task_id or "").strip() or None
        self._registry = registry
        self._invalid_exception = invalid_exception
        policy = str(dialog_policy or "").strip().lower()
        self.dialog_policy = policy if policy in VALID_DIALOG_POLICIES else (
            _configured_dialog_policy() if not policy else DEFAULT_DIALOG_POLICY)
        self._target_id: Optional[str] = None
        self._session_id: Optional[str] = None
        self.last_error: Optional[str] = None

    # -- lifecycle -------------------------------------------------------------------------

    def note_browser_task(self, task_id: Any) -> None:
        """Remember the task a browser_* tool registered under (from pre_tool_call)."""
        text = str(task_id or "").strip()
        if not text:
            return
        if text != self.task_id:
            self.task_id = text
            self.clear_attachment()

    def clear(self) -> None:
        self.task_id = None
        self.clear_attachment()

    def clear_attachment(self) -> None:
        self._target_id = None
        self._session_id = None

    # -- capture ---------------------------------------------------------------------------

    def capture_frame(self, scale: float = 1.0) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """Capture one JPEG frame; return ``(frame, None)`` or ``(None, reason)``.

        Blocking CDP work happens here.  Async callers should use
        ``await asyncio.to_thread(screen.capture_frame, scale)``.
        """
        started = time.monotonic()
        try:
            scale = float(scale)
            if not math.isfinite(scale):
                scale = 1.0
            scale = min(2.0, max(0.25, scale))
        except (TypeError, ValueError):
            scale = 1.0
        cdp, error = self._capture_handle()
        if cdp is None:
            return self._failed(error)
        try:
            session = self._ensure_attached(cdp)
            width, height, x, y = self._viewport(cdp, session)
            result = cdp.call("Page.captureScreenshot", {
                "format": "jpeg",
                "quality": 55,
                "optimizeForSpeed": True,
                "clip": {"x": x, "y": y, "width": width, "height": height, "scale": scale},
            }, session_id=session, timeout=_SCREENSHOT_TIMEOUT)
            data = result.get("result", {}).get("data")
            if not data:
                raise RuntimeError("the browser returned no image")
            jpeg = base64.b64decode(data, validate=True)
            if not jpeg:
                raise RuntimeError("the browser returned an empty image")
            info = self._page_info(cdp, session)
            return {
                "jpeg": jpeg,
                "url": str(info.get("url") or ""),
                "title": str(info.get("title") or ""),
                "width": max(1, int(round(width * scale))),
                "height": max(1, int(round(height * scale))),
                "ms": int(round((time.monotonic() - started) * 1000)),
            }, None
        except Exception as exc:  # noqa: BLE001 - a screen failure must never reach the adapter
            if self._invalid(exc):
                self.clear_attachment()
            return self._failed(_reason(exc))

    # -- takeover --------------------------------------------------------------------------

    def dispatch_input(self, action: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """Apply one click/scroll/type/key action; return ``(ok, reason)``.

        Coordinates are viewport fractions (0..1) and are scaled to the page's
        CSS visual viewport here, not on the phone.
        """
        if not isinstance(action, dict):
            return False, "input must be an object"
        kind = str(action.get("action") or "").strip().lower()
        if kind not in ("click", "scroll", "type", "key"):
            return False, "unknown input action"
        text = str(action.get("text") or "")
        key = str(action.get("key") or "").strip()
        if kind == "type" and len(text) > _MAX_TEXT:
            return False, "text is too long"
        if kind == "key" and (not key or len(key) > 40):
            return False, "a key is required"
        cdp, error = self._capture_handle()
        if cdp is None:
            return False, error
        try:
            session = self._ensure_attached(cdp)
            px = py = 0.0
            if kind in ("click", "scroll"):
                width, height, _x, _y = self._viewport(cdp, session)
                px, py = self._point(action, width, height)
            if kind == "click":
                self._click(cdp, session, px, py)
            elif kind == "scroll":
                dy = self._number(action.get("dy"), 0.0)
                dy = min(_MAX_SCROLL, max(-_MAX_SCROLL, dy))
                cdp.call("Input.dispatchMouseEvent", {
                    "type": "mouseWheel", "x": px, "y": py, "deltaX": 0, "deltaY": dy,
                }, session_id=session, timeout=_TARGET_TIMEOUT)
            elif kind == "type":
                cdp.call("Input.insertText", {"text": text}, session_id=session, timeout=_TARGET_TIMEOUT)
            else:
                for event in ("keyDown", "keyUp"):
                    cdp.call("Input.dispatchKeyEvent", {
                        "type": event, "key": key, "code": key,
                    }, session_id=session, timeout=_TARGET_TIMEOUT)
            return True, None
        except Exception as exc:  # noqa: BLE001
            if self._invalid(exc):
                self.clear_attachment()
            return False, _reason(exc)

    # -- plumbing --------------------------------------------------------------------------

    def _capture_handle(self):
        if not self.task_id:
            return None, "No browser task has run yet."
        try:
            registry = self._registry
            if registry is None:
                from tools.browser_supervisor import SUPERVISOR_REGISTRY
                registry = SUPERVISOR_REGISTRY
            return registry.capture(self.task_id, timeout=_TARGET_TIMEOUT), None
        except Exception as exc:  # noqa: BLE001
            return None, _reason(exc)

    def _invalid(self, exc: BaseException) -> bool:
        if self._invalid_exception is not None and isinstance(exc, self._invalid_exception):
            return True
        if type(exc).__name__ == "CapturedCDPInvalid":
            return True
        try:
            from tools.browser_supervisor_capture import CapturedCDPInvalid
            return isinstance(exc, CapturedCDPInvalid)
        except Exception:
            return False

    def _failed(self, reason: Optional[str]) -> Tuple[None, str]:
        self.last_error = reason or "screen unavailable"
        return None, self.last_error

    def _ensure_attached(self, cdp: Any) -> str:
        result = cdp.call("Target.getTargets", timeout=_TARGET_TIMEOUT)
        targets = result.get("result", {}).get("targetInfos") or []
        pages = [t for t in targets if isinstance(t, dict) and t.get("type") == "page"
                 and not str(t.get("url") or "").startswith(("chrome://", "about:blank", "devtools://"))]
        if not pages:
            raise RuntimeError("the browser has no page open")
        target_id = str(pages[-1].get("targetId") or "")
        if not target_id:
            raise RuntimeError("the browser returned a page without an id")
        if target_id == self._target_id and self._session_id:
            return self._session_id
        attached = cdp.call("Target.attachToTarget", {"targetId": target_id, "flatten": True},
                            timeout=_TARGET_TIMEOUT)
        session = str(attached.get("result", {}).get("sessionId") or "")
        if not session:
            raise RuntimeError("the browser did not attach a page session")
        self._target_id, self._session_id = target_id, session
        return session

    def _viewport(self, cdp: Any, session: str) -> Tuple[float, float, float, float]:
        result = cdp.call("Page.getLayoutMetrics", session_id=session, timeout=_TARGET_TIMEOUT)
        metrics = result.get("result", {}) or {}
        view = metrics.get("cssVisualViewport") or metrics.get("layoutViewport") or {}
        width = self._dimension(view.get("clientWidth"), 1280.0)
        height = self._dimension(view.get("clientHeight"), 720.0)
        x = self._number(view.get("pageX"), 0.0)
        y = self._number(view.get("pageY"), 0.0)
        return width, height, x, y

    def _page_info(self, cdp: Any, session: str) -> Dict[str, Any]:
        result = cdp.call("Runtime.evaluate", {
            "expression": "({url: location.href, title: document.title})",
            "returnByValue": True,
        }, session_id=session, timeout=_TARGET_TIMEOUT)
        value = result.get("result", {}).get("result", {}).get("value")
        return value if isinstance(value, dict) else {}

    def _click(self, cdp: Any, session: str, x: float, y: float) -> None:
        button = {"x": x, "y": y, "button": "left", "clickCount": 1}
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y},
                 session_id=session, timeout=_TARGET_TIMEOUT)
        cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", **button},
                 session_id=session, timeout=_TARGET_TIMEOUT)
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", **button},
                 session_id=session, timeout=_TARGET_TIMEOUT)

    @staticmethod
    def _number(value: Any, default: float) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return default
        return number if math.isfinite(number) else default

    @classmethod
    def _dimension(cls, value: Any, default: float) -> float:
        return max(1.0, cls._number(value, default))

    @classmethod
    def _point(cls, action: Dict[str, Any], width: float, height: float) -> Tuple[float, float]:
        x = min(1.0, max(0.0, cls._number(action.get("x"), 0.5)))
        y = min(1.0, max(0.0, cls._number(action.get("y"), 0.5)))
        return x * width, y * height
