import time

import aiohttp
import pytest

from plugin import uploads
from plugin.hub import Hub, _wants_push
from plugin.store import Store

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    return Hub(store, web_root=tmp_path / "web", media_dir=tmp_path / "media")


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def pair(client, hub, name="Pixel"):
    code = hub.store.create_pair_code()
    resp = await client.post("/api/pair", json={"code": code, "device_name": name, "platform": "android"})
    return {"Authorization": f"Bearer {(await resp.json())['token']}"}


async def upload(client, auth, data, name, chat="general", kind=None):
    form = aiohttp.FormData()
    if kind:
        form.add_field("kind", kind)
    form.add_field("file", data, filename=name, content_type="application/octet-stream")
    return await client.post(f"/api/chats/{chat}/uploads", data=form, headers=auth)


def test_sniffing_trusts_bytes_not_names():
    assert uploads.sniff_mime(PNG, "photo.jpg") == "image/png"
    assert uploads.sniff_mime(b"\xff\xd8\xff\xe0" + b"\x00" * 20, "x") == "image/jpeg"
    assert uploads.sniff_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "x") == "image/webp"
    assert uploads.sniff_mime(b"\x00\x00\x00\x18ftypheic", "x") == "image/heic"
    assert uploads.sniff_mime(b"\x00\x00\x00\x18ftypisom", "x") == "video/mp4"
    assert uploads.sniff_mime(b"OggS\x00", "x") == "audio/ogg"
    assert uploads.sniff_mime(b"%PDF-1.7", "a.pdf") == "application/pdf"
    assert uploads.sniff_mime(b"PK\x03\x04", "report.docx").endswith("wordprocessingml.document")
    # Script-capable formats are never served as themselves.
    assert uploads.sniff_mime(b"<html><script>alert(1)</script>", "evil.png") == "text/plain"
    assert uploads.sniff_mime(b"<svg onload=alert(1)>", "x.svg") == "text/plain"
    assert uploads.sniff_mime(b"\x00\x01\x02binary", "x.bin") == "application/octet-stream"
    assert uploads.kind_of("audio/ogg", voice=True) == "voice"
    assert uploads.voice_mime("video/webm") == "audio/webm"
    assert uploads.voice_mime("video/mp4") == "audio/mp4"
    assert uploads.voice_mime("image/png") == "image/png"
    assert uploads.kind_of("image/heic") == "file"


def test_safe_names():
    assert uploads.safe_name("../../etc/passwd") == "passwd"
    assert uploads.safe_name("C:\\\\Users\\\\me\\\\a.txt") == "a.txt"
    assert uploads.safe_name("con.txt") == "file"
    assert uploads.safe_name("") == "file"
    assert uploads.safe_name("a\x00b<>.txt") == "a_b__.txt"
    assert len(uploads.safe_name("x" * 300 + ".png")) <= 120 and uploads.safe_name("x" * 300 + ".png").endswith(".png")


async def test_upload_attach_and_hand_to_hermes(client, hub):
    received = []

    async def on_user_message(chat, text, device, message, **extra):
        received.append((text, extra))

    hub.on_user_message = on_user_message
    auth = await pair(client, hub)
    resp = await upload(client, auth, PNG, "../photo.jpg")
    assert resp.status == 200
    up = (await resp.json())["upload"]
    assert up["mime"] == "image/png" and up["kind"] == "image" and up["name"] == "photo.jpg" and "sig=" in up["url"]
    assert "path" not in up
    served = await client.get(up["url"])
    assert served.status == 200 and served.headers["Content-Type"] == "image/png"
    sent = await client.post("/api/chats/general/messages", json={"text": "", "attachments": [up["id"]], "client_id": "c1"},
                             headers=auth)
    assert sent.status == 200
    message = (await sent.json())["message"]
    assert message["meta"]["attachments"][0]["id"] == up["id"]
    text, extra = received[0]
    assert text == "" and extra["files"][0]["mime"] == "image/png" and extra["files"][0]["path"].endswith("photo.jpg")
    # A retry of the same send is de-duplicated, not rejected for re-using its upload.
    again = await client.post("/api/chats/general/messages", json={"text": "", "attachments": [up["id"]], "client_id": "c1"},
                              headers=auth)
    assert again.status == 200 and len(received) == 1
    # But the same upload can't be attached to a second message.
    other = await client.post("/api/chats/general/messages", json={"text": "x", "attachments": [up["id"]], "client_id": "c2"},
                              headers=auth)
    assert other.status == 400


async def test_uploads_belong_to_their_device_and_chat(client, hub):
    a = await pair(client, hub, "A")
    b = await pair(client, hub, "B")
    hub.store.ensure_chat("side", "Side")
    up = (await (await upload(client, a, PNG, "p.png")).json())["upload"]
    assert (await client.post("/api/chats/general/messages", json={"attachments": [up["id"]]}, headers=b)).status == 400
    assert (await client.post("/api/chats/side/messages", json={"attachments": [up["id"]]}, headers=a)).status == 400
    assert hub.store.get_upload(up["id"])["message_id"] is None


async def test_active_content_is_downloaded_never_rendered(client, hub):
    auth = await pair(client, hub)
    up = (await (await upload(client, auth, b"<html><script>alert(1)</script></html>", "evil.png")).json())["upload"]
    assert up["kind"] == "file" and up["mime"] == "text/plain"
    served = await client.get(up["url"])
    assert served.headers["Content-Type"] == "application/octet-stream"
    assert served.headers["Content-Disposition"].startswith("attachment")
    assert "sandbox" in served.headers["Content-Security-Policy"] and served.headers["X-Content-Type-Options"] == "nosniff"


async def test_limits_per_file_per_day_and_storage(client, hub):
    auth = await pair(client, hub)
    hub.max_upload_bytes = 100
    resp = await upload(client, auth, PNG + b"\x00" * 200, "big.png")
    assert resp.status == 413
    assert not any(p.is_dir() for p in (hub.media_dir.iterdir() if hub.media_dir.exists() else []))
    hub.max_upload_bytes = 10_000
    hub.device_daily_upload_bytes = len(PNG) + 10
    assert (await upload(client, auth, PNG, "a.png")).status == 200
    assert (await upload(client, auth, PNG, "b.png")).status == 413  # more than today's remaining 10 bytes
    hub.device_daily_upload_bytes = len(PNG)
    assert (await upload(client, auth, PNG, "c.png")).status == 429  # nothing left today
    hub.device_daily_upload_bytes = 10_000
    hub.total_upload_bytes = 1
    assert (await upload(client, auth, PNG, "d.png")).status == 507


async def test_voice_notes_are_marked(client, hub):
    auth = await pair(client, hub)
    up = (await (await upload(client, auth, b"OggS" + b"\x00" * 40, "note.ogg", kind="voice")).json())["upload"]
    assert up["kind"] == "voice"
    # A browser recording is WebM, which sniffs as video; as a voice note it's stored as audio.
    up = (await (await upload(client, auth, b"\x1a\x45\xdf\xa3" + b"\x00" * 40, "note.webm", kind="voice")).json())["upload"]
    assert (up["kind"], up["mime"]) == ("voice", "audio/webm")


async def test_abandoned_uploads_and_deleted_chats_free_their_files(client, hub):
    auth = await pair(client, hub)
    hub.store.ensure_chat("side", "Side")
    stale = (await (await upload(client, auth, PNG, "old.png")).json())["upload"]
    kept = (await (await upload(client, auth, PNG, "kept.png", chat="side")).json())["upload"]
    await client.post("/api/chats/side/messages", json={"attachments": [kept["id"]]}, headers=auth)
    assert hub.sweep_uploads(now=time.time() + 25 * 3600) == 1
    assert hub.store.get_upload(stale["id"]) is None and not (hub.media_dir / stale["id"]).exists()
    assert (hub.media_dir / kept["id"]).exists()
    assert (await client.delete("/api/chats/side", headers=auth)).status == 200
    assert not (hub.media_dir / kept["id"]).exists() and hub.store.get_upload(kept["id"]) is None


async def test_replies_carry_the_quoted_message(client, hub):
    received = []

    async def on_user_message(chat, text, device, message, **extra):
        received.append(extra)

    hub.on_user_message = on_user_message
    auth = await pair(client, hub)
    quoted = await hub.post_message("general", "Here are three options:\n1. A\n2. B\n3. C" + "x" * 500, push=False)
    resp = await client.post("/api/chats/general/messages", json={"text": "the second", "reply_to": quoted["id"]}, headers=auth)
    meta = (await resp.json())["message"]["meta"]
    assert meta["reply_to"]["id"] == quoted["id"] and len(meta["reply_to"]["text"]) <= 280
    assert received[0]["reply"]["role"] == "bot" and received[0]["reply"]["text"].startswith("Here are three")
    missing = await client.post("/api/chats/general/messages", json={"text": "x", "reply_to": "nope"}, headers=auth)
    assert missing.status == 400


async def test_export_and_commands(client, hub):
    auth = await pair(client, hub)
    await hub.post_message("general", "**hello** there", push=False)
    resp = await client.get("/api/chats/general/export", headers=auth)
    body = await resp.text()
    assert resp.status == 200 and body.startswith("# General") and "**hello** there" in body
    assert "attachment" in resp.headers["Content-Disposition"]
    commands = (await (await client.get("/api/commands", headers=auth)).json())["commands"]
    assert any(c["cmd"] == "/stop" for c in commands)
    hub.commands_provider = lambda: [{"cmd": "/goal", "hint": "Set a goal"}]
    commands = (await (await client.get("/api/commands", headers=auth)).json())["commands"]
    assert commands == [{"cmd": "/goal", "hint": "Set a goal"}]


async def test_notification_preferences(client, hub):
    auth = await pair(client, hub)
    now = time.time()
    bad = await client.put("/api/push/prefs", json={"prefs": {"quiet": {"start": "25:00", "end": "07:00"}}}, headers=auth)
    assert bad.status == 400
    resp = await client.put("/api/push/prefs", json={"prefs": {"muted": {"general": 0, "old": now - 5},
                                                                        "*": now + 3600}}, headers=auth)
    prefs = (await resp.json())["prefs"]
    assert set(prefs["muted"]) == {"general"}  # expired mutes are dropped; stray keys outside muted ignored
    assert not _wants_push(prefs, {"kind": "message", "chat_id": "general"})
    assert _wants_push(prefs, {"kind": "message", "chat_id": "side"})
    assert _wants_push(prefs, {"kind": "approval", "chat_id": "general"})  # a mute never hides approvals
    quiet = {"quiet": {"start": "22:00", "end": "07:00", "utc_offset_min": 0, "allow_urgent": True}}
    midnight = (now // 86400) * 86400 + 23 * 3600
    noon = (now // 86400) * 86400 + 12 * 3600
    assert not _wants_push(quiet, {"kind": "message"}, now=midnight)
    assert _wants_push(quiet, {"kind": "message"}, now=noon)
    assert _wants_push(quiet, {"kind": "approval"}, now=midnight)
    quiet["quiet"]["allow_urgent"] = False
    assert not _wants_push(quiet, {"kind": "approval"}, now=midnight)


async def test_muted_devices_get_no_reply_pushes(client, hub):
    auth = await pair(client, hub)
    device = (await (await client.get("/api/me", headers=auth)).json())["device"]
    hub.store.add_push_sub(device["id"], "ntfy", "https://ntfy.sh/t", {"server": "https://ntfy.sh", "topic": "t"})

    class HTTP:
        posts = []

        async def post(self, url, **kw):
            self.posts.append(kw["json"])
            return type("R", (), {"status_code": 200})()

    hub._http = HTTP()
    hub.store.set_push_prefs(device["id"], {"muted": {"*": 0}})
    await hub.push_now({"title": "t", "body": "b", "kind": "message", "chat_id": "general"}, tag="x")
    assert HTTP.posts == []
    await hub.push_now({"title": "t", "body": "b", "kind": "approval", "chat_id": "general"}, tag="y")
    assert len(HTTP.posts) == 1


async def test_export_streams_pages_and_stops_at_the_documented_cap(client, hub, monkeypatch):
    from plugin import hub as hub_module
    auth = await pair(client, hub)
    for i in range(20):
        await hub.post_message("general", f"line {i} " + "x" * 80, push=False)

    def no_full_history(_chat_id):
        raise AssertionError("export must not materialise all_messages")

    monkeypatch.setattr(hub.store, "all_messages", no_full_history)
    monkeypatch.setattr(hub_module, "EXPORT_MAX_BYTES", 300)
    resp = await client.get("/api/chats/general/export", headers=auth)
    body = await resp.text()
    assert resp.status == 200 and body.startswith("# General")
    assert "Export truncated at the" in body
    assert len(body.encode()) < 500
