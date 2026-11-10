#!/usr/bin/env python3
"""Run the screen spike end to end against a real local Chromium.

This is a demo, not a test: it launches /root/.hermes/tools/chromium-1208,
starts a Hermes browser supervisor, captures a frame through
``plugin.screen.ScreenCapture``, then types into an input and clicks a button
through ``dispatch_input``.  It prints the saved JPEG and the page's answer.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, "/root/.hermes/hermes-agent")

CHROME = "/root/.hermes/tools/chromium-1208/chrome-linux64/chrome"
SCRATCH = pathlib.Path("/root/.hermes/cache/scratch")
TASK_ID = "winglet-screen-spike"
PAGE = """<!doctype html><meta name=viewport content="width=device-width">
<title>Winglet screen spike</title>
<style>body{font:16px system-ui;padding:24px}input{font-size:16px;padding:8px;width:280px}
button{font-size:16px;padding:8px 16px;margin-top:8px}</style>
<h1>Bank login</h1>
<label>Account number<br><input id="acct" autocomplete="off"></label><br>
<button id="go" onclick="document.getElementById('out').textContent='Submitted: '+document.getElementById('acct').value">Sign in</button>
<p id="out">-</p>
"""


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def launch(profile: pathlib.Path, port: int):
    args = [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
            f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
            "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "about:blank"]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as response:
                info = json.load(response)
            return proc, info["webSocketDebuggerUrl"]
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("Chrome never exposed a CDP endpoint")


def main() -> int:
    from plugin.screen import ScreenCapture
    from tools.browser_supervisor import SUPERVISOR_REGISTRY

    SCRATCH.mkdir(parents=True, exist_ok=True)
    profile = pathlib.Path(tempfile.mkdtemp(prefix="winglet-screen-profile-", dir=SCRATCH))
    out = pathlib.Path(tempfile.mkdtemp(prefix="winglet-screen-out-", dir=SCRATCH))
    page_path = out / "page.html"
    page_path.write_text(PAGE)
    chrome = None
    try:
        chrome, ws_url = launch(profile, free_port())
        SUPERVISOR_REGISTRY.get_or_start(task_id=TASK_ID, cdp_url=ws_url,
                                         dialog_policy="auto_dismiss", dialog_timeout_s=10.0)
        cdp = SUPERVISOR_REGISTRY.capture(TASK_ID, timeout=3)
        cdp.call("Page.navigate", {"url": page_path.as_uri()},
                 session_id=cdp.page_session_id, timeout=8)
        time.sleep(0.8)

        screen = ScreenCapture(TASK_ID, dialog_policy="auto_dismiss", registry=SUPERVISOR_REGISTRY)
        frame, reason = screen.capture_frame(scale=1.0)
        if frame is None:
            print("CAPTURE FAILED:", reason)
            return 1
        shot = out / "frame-1.jpg"
        shot.write_bytes(frame["jpeg"])
        print(f"JPEG: {shot}")
        print(f"BYTES: {len(frame['jpeg'])}  DIMENSIONS: {frame['width']}x{frame['height']}  MS: {frame['ms']}")
        print(f"PAGE: {frame['title']}  {frame['url']}")

        def box(selector: str):
            value = cdp.call("Runtime.evaluate", {
                "expression": (f"(()=>{{const r=document.querySelector({selector!r}).getBoundingClientRect();"
                               "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"),
                "returnByValue": True}, session_id=cdp.page_session_id, timeout=3)
            return value["result"]["result"]["value"]

        input_box, button_box = box("#acct"), box("#go")
        width, height = frame["width"], frame["height"]
        print("CLICK INPUT FRACTION:", round(input_box["x"] / width, 3), round(input_box["y"] / height, 3))
        ok, why = screen.dispatch_input({"action": "click", "x": input_box["x"] / width,
                                         "y": input_box["y"] / height})
        print("CLICK INPUT:", ok, why or "")
        ok, why = screen.dispatch_input({"action": "type", "text": "12345678"})
        print("TYPE:", ok, why or "")
        ok, why = screen.dispatch_input({"action": "click", "x": button_box["x"] / width,
                                         "y": button_box["y"] / height})
        print("CLICK BUTTON:", ok, why or "")
        time.sleep(0.3)

        answer = cdp.call("Runtime.evaluate", {"expression": "document.getElementById('out').textContent",
                                               "returnByValue": True},
                          session_id=cdp.page_session_id, timeout=3)
        print("PAGE SAYS:", answer["result"]["result"]["value"])
        return 0
    finally:
        try:
            from tools.browser_supervisor import SUPERVISOR_REGISTRY as registry
            registry.stop(TASK_ID)
        except Exception:
            pass
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except Exception:
                chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
