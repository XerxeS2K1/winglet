"""The live screen spike: exact CDP calls, takeover maths and the dark flag."""

from __future__ import annotations

import base64

import pytest

from plugin import execution, screen
from plugin.hub import Hub
from plugin.store import Store


class FakeInvalid(RuntimeError):
    pass


class FakeCDP:
    def __init__(self, targets=None, viewport=None):
        self.calls = []
        self.targets = targets or [
            {"targetId": "blank", "type": "page", "url": "about:blank"},
            {"targetId": "page-1", "type": "page", "url": "https://example.test/"},
        ]
        self.viewport = viewport or {"clientWidth": 800, "clientHeight": 600,
                                     "pageX": 10, "pageY": 20}
        self.session_number = 0
        self.values = {}

    def call(self, method, params=None, *, session_id=None, timeout=None):
        self.calls.append((method, params, session_id, timeout))
        if method == "Target.getTargets":
            return {"result": {"targetInfos": self.targets}}
        if method == "Target.attachToTarget":
            self.session_number += 1
            return {"result": {"sessionId": f"session-{self.session_number}"}}
        if method == "Page.getLayoutMetrics":
            return {"result": {"cssVisualViewport": self.viewport}}
        if method == "Page.captureScreenshot":
            return {"result": {"data": base64.b64encode(b"\xff\xd8\xffjpeg").decode()}}
        if method == "Runtime.evaluate":
            return {"result": {"result": {"value": {"url": "https://example.test/",
                                                     "title": "Example"}}}}
        return {"result": {}}


class FakeRegistry:
    def __init__(self, cdp):
        self.cdp = cdp
        self.captures = []

    def capture(self, task_id, *, timeout=None):
        self.captures.append((task_id, timeout))
        return self.cdp


def make_screen(cdp=None, **kwargs):
    cdp = cdp or FakeCDP()
    return screen.ScreenCapture("browser-task", dialog_policy="auto_accept",
                                registry=FakeRegistry(cdp), **kwargs), cdp


def methods(cdp):
    return [call[0] for call in cdp.calls]


def call_for(cdp, method, index=-1):
    matches = [call for call in cdp.calls if call[0] == method]
    return matches[index]


def test_capture_attaches_the_newest_real_page_and_uses_the_exact_cdp_shape():
    capture, cdp = make_screen()
    frame, reason = capture.capture_frame(scale=0.5)

    assert reason is None and frame["jpeg"] == b"\xff\xd8\xffjpeg"
    assert frame["url"] == "https://example.test/" and frame["title"] == "Example"
    assert (frame["width"], frame["height"]) == (400, 300)
    assert methods(cdp) == ["Target.getTargets", "Target.attachToTarget", "Page.getLayoutMetrics",
                            "Page.captureScreenshot", "Runtime.evaluate"]
    assert call_for(cdp, "Target.attachToTarget")[1] == {"targetId": "page-1", "flatten": True}
    shot = call_for(cdp, "Page.captureScreenshot")[1]
    assert shot["format"] == "jpeg" and shot["quality"] == 55 and shot["optimizeForSpeed"] is True
    assert shot["clip"] == {"x": 10, "y": 20, "width": 800, "height": 600, "scale": 0.5}
    assert call_for(cdp, "Page.captureScreenshot")[2] == "session-1"
    assert call_for(cdp, "Runtime.evaluate")[1] == {
        "expression": "({url: location.href, title: document.title})", "returnByValue": True}


def test_capture_reuses_the_session_until_the_page_target_changes():
    capture, cdp = make_screen()
    capture.capture_frame()
    capture.capture_frame()
    assert methods(cdp).count("Target.attachToTarget") == 1

    cdp.targets.append({"targetId": "page-2", "type": "page", "url": "https://second.test/"})
    capture.capture_frame()
    assert call_for(cdp, "Target.attachToTarget")[1]["targetId"] == "page-2"
    assert methods(cdp).count("Target.attachToTarget") == 2


def test_a_captured_cdp_invalid_degrades_to_none_and_a_reason():
    class Registry:
        def capture(self, task_id, *, timeout=None):
            raise FakeInvalid("supervisor stopped")

    capture = screen.ScreenCapture("browser-task", registry=Registry(), invalid_exception=FakeInvalid)
    frame, reason = capture.capture_frame()
    assert frame is None and reason and "supervisor stopped" in reason
    assert capture._target_id is None and capture._session_id is None


def test_input_actions_emit_exact_cdp_and_scale_fractions_to_the_css_viewport():
    capture, cdp = make_screen()

    assert capture.dispatch_input({"action": "click", "x": 1.5, "y": -1}) == (True, None)
    assert call_for(cdp, "Input.dispatchMouseEvent", 0)[1] == {"type": "mouseMoved", "x": 800.0, "y": 0.0}
    assert call_for(cdp, "Input.dispatchMouseEvent", 1)[1] == {
        "type": "mousePressed", "x": 800.0, "y": 0.0, "button": "left", "clickCount": 1}
    assert call_for(cdp, "Input.dispatchMouseEvent", 2)[1] == {
        "type": "mouseReleased", "x": 800.0, "y": 0.0, "button": "left", "clickCount": 1}

    assert capture.dispatch_input({"action": "scroll", "x": 0.5, "y": 0.25, "dy": 240}) == (True, None)
    assert call_for(cdp, "Input.dispatchMouseEvent")[1] == {
        "type": "mouseWheel", "x": 400.0, "y": 150.0, "deltaX": 0, "deltaY": 240.0}

    assert capture.dispatch_input({"action": "type", "text": "12345678"}) == (True, None)
    assert call_for(cdp, "Input.insertText")[1] == {"text": "12345678"}

    assert capture.dispatch_input({"action": "key", "key": "Enter"}) == (True, None)
    assert call_for(cdp, "Input.dispatchKeyEvent", 0)[1] == {"type": "keyDown", "key": "Enter", "code": "Enter"}
    assert call_for(cdp, "Input.dispatchKeyEvent", 1)[1] == {"type": "keyUp", "key": "Enter", "code": "Enter"}


def test_bad_input_is_refused_before_any_cdp_call():
    capture, cdp = make_screen()
    assert capture.dispatch_input({"action": "dance"}) == (False, "unknown input action")
    assert capture.dispatch_input({"action": "type", "text": "x" * 4001})[0] is False
    assert capture.dispatch_input({"action": "key", "key": ""})[0] is False
    assert cdp.calls == []


def test_no_browser_task_means_no_capture():
    capture = screen.ScreenCapture()
    frame, reason = capture.capture_frame()
    assert frame is None and "browser task" in reason


def test_dialog_policy_accepts_only_the_three_supervisor_values(monkeypatch):
    monkeypatch.setattr(screen, "_configured_dialog_policy", lambda: "must_respond")
    assert screen.ScreenCapture().dialog_policy == "must_respond"
    assert screen.ScreenCapture(dialog_policy="auto_accept").dialog_policy == "auto_accept"
    assert screen.ScreenCapture(dialog_policy="dismiss").dialog_policy == screen.DEFAULT_DIALOG_POLICY


def test_the_flag_defaults_off_and_reads_each_supported_config_location():
    assert screen.screen_watch_enabled({}) is False
    assert screen.screen_watch_enabled({"screen_watch": False}) is False
    assert screen.screen_watch_enabled({"screen_watch": True}) is True
    assert screen.screen_watch_enabled({"browser": {"screen_watch": "on"}}) is True
    assert screen.screen_watch_enabled({"plugins": {"winglet": {"screen_watch": True}}}) is True
    assert screen.screen_watch_enabled({"platforms": {"winglet": {"extra": {"screen_watch": True}}}}) is True


def test_the_browser_observer_is_only_wired_when_the_screen_capture_exists():
    class Ctx:
        def __init__(self):
            self.hooks = {}

        def register_hook(self, name, callback):
            self.hooks.setdefault(name, []).append(callback)

    class Tracker:
        def tool_started(self, *args, **kwargs):
            pass

    class Capture:
        def __init__(self):
            self.tasks = []

        def note_browser_task(self, task_id):
            self.tasks.append(task_id)

    tracker = Tracker()
    off = Ctx()
    execution.register_hooks(off, tracker)
    assert len(off.hooks["pre_tool_call"]) == 1
    off.hooks["pre_tool_call"][0](session_id="s", tool_name="browser_exec", task_id="task-1")

    on = Ctx()
    capture = Capture()
    execution.register_hooks(on, tracker, screen=capture)
    assert len(on.hooks["pre_tool_call"]) == 2
    on.hooks["pre_tool_call"][-1](session_id="s", tool_name="browser_exec", task_id="task-1")
    on.hooks["pre_tool_call"][-1](session_id="s", tool_name="terminal", task_id="task-2")
    assert capture.tasks == ["task-1"]


@pytest.fixture
def hub(tmp_path):
    store = Store(tmp_path / "data.db")
    store.ensure_chat("general", "General")
    instance = Hub(store, web_root=tmp_path / "web")
    yield instance
    store.close()


async def pair(client, hub):
    code = hub.store.create_pair_code()
    response = await client.post("/api/pair", json={"code": code, "device_name": "Pixel", "platform": "android"})
    assert response.status == 200
    return {"Authorization": f"Bearer {(await response.json())['token']}"}


async def test_flag_off_has_no_screen_routes(aiohttp_client, hub):
    client = await aiohttp_client(hub.build_app())
    assert (await client.get("/screen/frame")).status == 404
    assert (await client.post("/screen/input", json={"action": "click"})).status == 404
    auth = await pair(client, hub)
    assert (await client.get("/screen/frame", headers=auth)).status == 404
    assert (await client.post("/screen/input", json={"action": "click"}, headers=auth)).status == 404
    assert hub.features()["screen_watch"] is False


async def test_flag_on_serves_a_jpeg_and_applies_an_input(aiohttp_client, hub):
    cdp = FakeCDP()
    hub.screen = screen.ScreenCapture("browser-task", dialog_policy="auto_accept",
                                      registry=FakeRegistry(cdp))
    client = await aiohttp_client(hub.build_app())
    auth = await pair(client, hub)

    response = await client.get("/screen/frame", headers=auth)
    assert response.status == 200 and response.content_type == "image/jpeg"
    assert await response.read() == b"\xff\xd8\xffjpeg"

    response = await client.post("/screen/input", json={"action": "type", "text": "hello"}, headers=auth)
    assert response.status == 200 and await response.json() == {"ok": True}
    assert call_for(cdp, "Input.insertText")[1] == {"text": "hello"}
    assert hub.features()["screen_watch"] is True
