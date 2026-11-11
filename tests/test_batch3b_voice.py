"""Review findings #25 and #26 in plugin/live_voice.py."""
import asyncio
import pathlib
import threading

import aiohttp
import pytest

from test_live_voice import auth, client, hub, open_session, pair, speak, store, transcribe  # noqa: F401  (fixtures)


# -- #25 ---------------------------------------------------------------------------------------------------------------

def watch_writes(monkeypatch):
    """Record which thread writes each file; the speech file must not be written on the event loop's thread."""
    seen = {"loop": threading.get_ident(), "threads": [], "started": threading.Event(), "release": threading.Event()}
    real = pathlib.Path.write_bytes

    def write_bytes(self, data):
        if self.name.startswith("sp_"):
            seen["threads"].append(threading.get_ident())
            seen["started"].set()
            if seen.get("hold"):
                assert seen["release"].wait(5)
        return real(self, data)
    monkeypatch.setattr(pathlib.Path, "write_bytes", write_bytes)
    return seen


async def test_the_spoken_reply_is_written_off_the_event_loop(client, hub, monkeypatch):
    seen = watch_writes(monkeypatch)
    token = await pair(client, hub)
    session = await open_session(client, token)
    resp = await speak(client, token, session)
    assert resp.status == 200
    url = (await resp.json())["url"]
    assert seen["threads"] and seen["loop"] not in seen["threads"]
    assert (await client.get(url)).status == 200                      # and it still plays


async def test_a_stop_that_arrives_while_the_file_is_being_written_leaves_no_audio(client, hub, monkeypatch, tmp_path):
    seen = watch_writes(monkeypatch)
    seen["hold"] = True
    token = await pair(client, hub)
    session = await open_session(client, token)
    pending = asyncio.create_task(speak(client, token, session, turn_id="t9"))
    for _ in range(100):
        if seen["started"].is_set():
            break
        await asyncio.sleep(0.02)
    assert seen["started"].is_set()
    stop = await client.post(f"/api/voice/sessions/{session['session_id']}/stop",
                             json={"token": session["token"], "turn_id": "t9"}, headers=auth(token))
    assert stop.status == 200
    seen["release"].set()
    answer = await pending
    assert answer.status == 409
    assert list(hub.voice.sessions.directory.glob("sp_*")) == []


# -- #26 ---------------------------------------------------------------------------------------------------------------

async def test_a_cancelled_transcription_does_not_leave_the_session_busy(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    state = hub.voice.sessions._sessions[session["session_id"]]

    async def hung_up(path, mime):
        assert state["busy"] == "u1"                                  # claimed while it ran
        raise asyncio.CancelledError                                  # what aiohttp delivers when the phone goes away
    hub.speech.transcribe = hung_up
    with pytest.raises(aiohttp.ClientError):
        await transcribe(client, token, session, utterance_id="u1")
    assert state["busy"] is None

    del hub.speech.transcribe                                         # back to the working fake
    again = await transcribe(client, token, session, utterance_id="u2")
    assert again.status == 200                                        # not 429 "still transcribing"
