"""A second pet source, codex-pets.net: what may be downloaded, and how it reaches the gallery.

No test here touches the network. `petsource._hop`, the one function that opens a connection, is replaced by a
fake that serves what the test says codex-pets.net answered.
"""

import io
import json
from pathlib import Path

import pytest

from plugin import petsource
from plugin.hub import Hub
from plugin.store import Store
from test_pets import FakeHermes, Refused, finished, needs_hermes
from test_trust import pair_phone, post_signed

ASSET = "https://codex-pets.net/assets/pets/v/1793864353020"


def png(size=(1536, 1872), fmt="WEBP", colour=(200, 80, 40, 255)):
    from PIL import Image
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    image.paste(colour, (40, 40, 150, 170))
    out = io.BytesIO()
    image.save(out, format=fmt, **({"lossless": True} if fmt == "WEBP" else {}))
    return out.getvalue()


def sheet_png(size=(1536, 1872), fmt="WEBP"):
    """A real-looking sheet: six frames drawn in every row, as Hermes counts frames."""
    from PIL import Image
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    for row in range(size[1] // 208):
        for col in range(6):
            image.paste((200, 80, 40, 255), (col * 192 + 40, row * 208 + 40, col * 192 + 150, row * 208 + 170))
    out = io.BytesIO()
    image.save(out, format=fmt, **({"lossless": True} if fmt == "WEBP" else {}))
    return out.getvalue()


def strip(frames=73):
    """A preview like codex-pets.net's: frames of 96x104 side by side, the first one drawn in red."""
    from PIL import Image
    image = Image.new("RGBA", (96 * frames, 104), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (10, 10, 80, 90))
    image.paste((0, 0, 255, 255), (96 + 10, 10, 96 + 80, 90))
    out = io.BytesIO()
    image.save(out, format="WEBP", lossless=True)
    return out.getvalue()


def raw(pet_id, *, banned=False, **over):
    base = {"id": pet_id, "displayName": pet_id.title(), "description": f"About {pet_id}.", "kind": "creature",
            "ownerHandle": "handle", "ownerName": "Owner Name", "ownerShadowbanned": banned, "spriteVersionNumber": 2,
            "spritesheetUrl": f"{ASSET}/{pet_id}/spritesheet.webp", "posterUrl": f"{ASSET}/{pet_id}/poster.webp",
            "previewUrl": f"{ASSET}/{pet_id}/preview.webp", "downloadUrl": f"/api/pets/{pet_id}/download?v=1"}
    base.update(over)
    return base


def listing(*pets, page=1, total=None):
    return {"pets": list(pets), "page": page, "pageSize": 30, "total": total if total is not None else len(pets),
            "totalPages": 1}


class FakeNet:
    """Stands in for petsource._hop: serves routes, remembers every URL it was asked for."""

    def __init__(self):
        self.routes = {}
        self.calls = []

    def json(self, url, data, status=200):
        self.routes[url] = (status, {"content-type": "application/json"}, json.dumps(data).encode())

    def file(self, url, body, status=200, **headers):
        self.routes[url] = (status, headers, body)

    def __call__(self, url, timeout, limit):
        self.calls.append(url)
        status, headers, body = self.routes.get(url, (404, {}, b"not found"))
        return status, {k.lower(): v for k, v in headers.items()}, body[: limit + 1]  # as the real one caps reads


@pytest.fixture
def net(monkeypatch):
    fake = FakeNet()
    monkeypatch.setattr(petsource, "_hop", fake)
    petsource.clear_cache()
    yield fake
    petsource.clear_cache()


def serve_pet(net, pet_id="kanegon", sheet=None, **over):
    """Detail page, sheet and preview for one pet."""
    entry = raw(pet_id, **over)
    net.json(f"{petsource.CODEX_API}/{pet_id}", {"pet": entry})
    net.file(entry["spritesheetUrl"], sheet_png() if sheet is None else sheet)
    net.file(entry["previewUrl"], strip())
    return entry


# -- what may be fetched ---------------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://evil.example/assets/pets/v/1/x/spritesheet.webp",
    "http://codex-pets.net/assets/pets/v/1/x/spritesheet.webp",
    "https://codex-pets.net.evil.example/assets/pets/v/1/x/spritesheet.webp",
    "https://evil.codex-pets.net/assets/pets/v/1/x/spritesheet.webp",
    "https://codex-pets.net@evil.example/assets/pets/v/1/x/spritesheet.webp",
    "https://codex-pets.net:8443/assets/pets/v/1/x/spritesheet.webp",
    "ftp://codex-pets.net/x",
    "//evil.example/x",
])
def test_a_wrong_host_is_refused_before_any_request(net, url):
    with pytest.raises(petsource.PetSourceError):
        petsource.fetch(url, limit=1000)
    assert net.calls == []


def test_the_source_cannot_point_a_pet_at_another_host(net):
    """A pet whose data names a sheet or preview elsewhere is not offered at all."""
    net.json(f"{petsource.CODEX_API}/evil", {"pet": raw("evil", spritesheetUrl="https://evil.example/s.webp")})
    with pytest.raises(petsource.PetSourceError):
        petsource.entry_for("evil")
    net.json(f"{petsource.CODEX_API}/wrongpath", {"pet": raw("wrongpath", spritesheetUrl="https://codex-pets.net/api/x")})
    with pytest.raises(petsource.PetSourceError):
        petsource.entry_for("wrongpath")
    # A bad preview only costs the thumbnail, not the pet.
    net.json(f"{petsource.CODEX_API}/nopreview", {"pet": raw("nopreview", previewUrl="https://evil.example/p.webp", posterUrl="")})
    assert petsource.entry_for("nopreview")["preview"] == ""
    assert all("evil.example" not in c for c in net.calls)


def test_a_redirect_to_another_host_is_refused(net):
    url = f"{ASSET}/x/spritesheet.webp"
    net.file(url, b"", status=302, location="https://evil.example/steal")
    net.file("https://evil.example/steal", png())
    with pytest.raises(petsource.PetSourceError, match="outside"):
        petsource.fetch(url, limit=10_000_000)
    assert net.calls == [url]  # the second host was never contacted


def test_a_redirect_on_the_same_host_is_followed_but_not_forever(net):
    url = f"{ASSET}/x/spritesheet.webp"
    net.file(url, b"", status=301, location="/assets/pets/v/2/x/spritesheet.webp")
    net.file("https://codex-pets.net/assets/pets/v/2/x/spritesheet.webp", b"abc")
    assert petsource.fetch(url, limit=100)[1] == b"abc"
    net.file("https://codex-pets.net/loop", b"", status=302, location="/loop")
    with pytest.raises(petsource.PetSourceError, match="too many"):
        petsource.fetch("https://codex-pets.net/loop", limit=100)


def test_an_oversize_download_is_refused_and_nothing_is_kept(net, tmp_path):
    serve_pet(net, sheet=b"x" * (petsource.SHEET_LIMIT + 1))
    with pytest.raises(petsource.PetSourceError, match="bigger"):
        petsource.install("kanegon", tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_reads_stop_at_the_cap():
    class Body:
        def __init__(self):
            self.served = 0

        def read(self, n):
            self.served += n
            return b"y" * n
    body = Body()
    assert len(petsource._read_capped(body, 1000)) == 1001
    assert body.served == 1001  # not an endless stream


# -- what an install must be -------------------------------------------------------------------------------

@pytest.mark.parametrize("body", [b"<html>not a picture</html>", b"", b"RIFF\x00\x00\x00\x00WEBPVP8 garbage" + b"\0" * 40,
                                  sheet_png(fmt="PNG")[:-30]])
def test_something_that_is_not_an_image_is_refused(net, tmp_path, body):
    serve_pet(net, sheet=body)
    with pytest.raises(petsource.PetSourceError):
        petsource.install("kanegon", tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_only_pet_sheet_geometry_is_accepted(net, tmp_path):
    for size in [(1536, 1664), (1728, 1664), (96, 104), (1536, 1872 + 208)]:
        serve_pet(net, sheet=png(size))
        with pytest.raises(petsource.PetSourceError, match="not a pet sheet"):
            petsource.install("kanegon", tmp_path)
    serve_pet(net, sheet=b"\xff\xd8\xff\xe0" + b"\0" * 50)  # a JPEG header: a real picture format, but not ours
    with pytest.raises(petsource.PetSourceError):
        petsource.install("kanegon", tmp_path)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("size,rows", [((1536, 1872), 9), ((1536, 2288), 11)])
def test_installs_are_written_the_way_hermes_stores_pets(net, tmp_path, size, rows):
    serve_pet(net, "kanegon", sheet=sheet_png(size), displayName="Kanegon", description="A sleepy gold Kanegon.")
    assert petsource.install("kanegon", tmp_path) == {"slug": "kanegon-codexpets", "name": "Kanegon"}
    folder = tmp_path / "kanegon-codexpets"
    assert sorted(p.name for p in folder.iterdir()) == ["pet.json", "spritesheet.webp"]
    meta = json.loads((folder / "pet.json").read_text())
    assert meta == {"id": "kanegon-codexpets", "displayName": "Kanegon", "description": "A sleepy gold Kanegon.",
                    "spritesheetPath": "spritesheet.webp", "source": "codex-pets.net", "sourceId": "kanegon",
                    "author": "Owner Name"}
    assert (folder / "spritesheet.webp").read_bytes() == sheet_png(size)
    from PIL import Image
    assert Image.open(folder / "spritesheet.webp").size == (1536, 208 * rows)


def test_a_png_sheet_is_kept_as_png(net, tmp_path):
    serve_pet(net, sheet=sheet_png(fmt="PNG"))
    petsource.install("kanegon", tmp_path)
    folder = tmp_path / "kanegon-codexpets"
    assert (folder / "spritesheet.png").is_file()
    assert json.loads((folder / "pet.json").read_text())["spritesheetPath"] == "spritesheet.png"


def test_shadow_banned_owners_are_skipped(net, tmp_path):
    net.json(f"{petsource.CODEX_API}?page=1&pageSize=30",
             listing(raw("good"), raw("banned", banned=True), raw("also-good"), total=3))
    page = petsource.catalog_page()
    assert [p["id"] for p in page["pets"]] == ["good", "also-good"]
    assert page["next_offset"] == 3  # the skipped one still took its place in the source's own list
    # Asked for by name anyway (an old link, a guess), it is refused and nothing is downloaded.
    serve_pet(net, "banned", banned=True)
    with pytest.raises(petsource.PetSourceError):
        petsource.install("banned", tmp_path)
    assert list(tmp_path.iterdir()) == [] and not any("spritesheet" in c for c in net.calls)


def test_a_slug_that_is_taken_is_never_overwritten(net, tmp_path):
    taken = tmp_path / "kanegon-codexpets"
    taken.mkdir()
    (taken / "pet.json").write_text(json.dumps({"id": "kanegon-codexpets", "displayName": "Mine"}))
    (taken / "spritesheet.webp").write_bytes(b"MY OWN SHEET")
    serve_pet(net)
    with pytest.raises(petsource.PetSourceError, match="already on this server"):
        petsource.install("kanegon", tmp_path)
    assert (taken / "spritesheet.webp").read_bytes() == b"MY OWN SHEET"
    assert json.loads((taken / "pet.json").read_text())["displayName"] == "Mine"
    assert [p.name for p in taken.iterdir()].count("spritesheet.webp.part") == 0


def test_a_failed_install_leaves_no_half_made_pet(net, tmp_path, monkeypatch):
    serve_pet(net)
    original = Path.write_text

    def boom(self, *a, **k):
        if self.name == "pet.json":
            raise OSError("disk full")
        return original(self, *a, **k)
    monkeypatch.setattr(Path, "write_text", boom)
    with pytest.raises(petsource.PetSourceError, match="saved"):
        petsource.install("kanegon", tmp_path)
    assert list(tmp_path.iterdir()) == []
    monkeypatch.setattr(Path, "write_text", original)
    petsource.install("kanegon", tmp_path)  # and the same pet can be tried again
    assert (tmp_path / "kanegon-codexpets" / "spritesheet.webp").is_file()


def test_our_own_earlier_install_can_be_redone(net, tmp_path):
    serve_pet(net)
    petsource.install("kanegon", tmp_path)
    (tmp_path / "kanegon-codexpets" / "spritesheet.webp").unlink()  # a sheet lost, the folder kept
    petsource.install("kanegon", tmp_path)
    assert (tmp_path / "kanegon-codexpets" / "spritesheet.webp").is_file()


# -- the gallery ---------------------------------------------------------------------------------------------

def test_the_gallery_pages_and_searches_the_source(net):
    net.json(f"{petsource.CODEX_API}?page=1&pageSize=30", listing(raw("a"), raw("b"), total=3663))
    net.json(f"{petsource.CODEX_API}?page=3&pageSize=30&q=Cat%20Girl", listing(raw("c"), page=3, total=70))
    first = petsource.catalog_page("", 0)
    assert first["total"] == 3663 and first["next_offset"] == 2
    assert first["pets"][0]["slug"] == "a-codexpets" and first["pets"][0]["by"] == "Owner Name"
    found = petsource.catalog_page("Cat Girl", 60)
    assert [p["id"] for p in found["pets"]] == ["c"] and found["next_offset"] == 61
    calls = len(net.calls)
    petsource.catalog_page("", 0)
    assert len(net.calls) == calls  # cached for a few minutes


def test_the_gallery_survives_odd_data(net):
    net.json(f"{petsource.CODEX_API}?page=1&pageSize=30", listing(
        raw("fine"), raw("../escape"), raw(""), "nonsense", raw("no-sheet", spritesheetUrl=None), raw("x" * 80)))
    assert [p["id"] for p in petsource.catalog_page()["pets"]] == ["fine"]
    net.json(f"{petsource.CODEX_API}?page=2&pageSize=30", {"unexpected": True})
    with pytest.raises(petsource.PetSourceError):
        petsource.catalog_page("", 30)


def test_a_thumbnail_is_a_png_of_the_first_frame_and_is_cached(net, tmp_path):
    serve_pet(net)
    cache = tmp_path / "kanegon-codexpets.png"
    data = petsource.thumbnail("kanegon", cache)
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    from PIL import Image
    image = Image.open(io.BytesIO(data))
    assert image.format == "PNG" and image.size == (96, 104)  # as Hermes's own: 96 wide
    assert image.getpixel((40, 40))[:3] == (255, 0, 0)  # the first frame, not the second (blue)
    assert cache.read_bytes() == data
    calls = len(net.calls)
    assert petsource.thumbnail("kanegon", cache) == data and len(net.calls) == calls


def test_a_thumbnail_fetch_that_goes_wrong_is_just_missing(net, tmp_path):
    serve_pet(net)
    net.file(f"{ASSET}/kanegon/preview.webp", b"<html>")
    assert petsource.thumbnail("kanegon", tmp_path / "t.png") is None
    assert not (tmp_path / "t.png").exists()
    assert petsource.thumbnail("../x", tmp_path / "u.png") is None


# -- through the server --------------------------------------------------------------------------------------

class SourcesHermes(FakeHermes):
    """FakeHermes plus the source-aware functions plugin/hermes_api.py offers."""

    def __init__(self, tmp_path):
        super().__init__(tmp_path)
        self.catalog_calls = []
        self.adopt_calls = []

    def pet_catalog_from(self, source, query="", offset=0, limit=30):
        self.catalog_calls.append((source, query, offset))
        return {"total": 1, "next_offset": offset + 30, "pets": [
            {"slug": "kanegon-codexpets", "name": "Kanegon", "kind": "creature", "by": "Owner Name", "curated": False,
             "description": "A sleepy gold Kanegon.", "installed": "kanegon-codexpets" in self.installed}]}

    def adopt_pet_from(self, source, slug):
        self.adopt_calls.append((source, slug))
        if not slug.endswith("-codexpets"):
            raise Refused("That pet source isn't offered.")
        self.installed[slug] = "Kanegon"
        self.active = slug
        return {"slug": slug, "name": "Kanegon"}


@pytest.fixture
def hub(tmp_path):
    s = Store(tmp_path / "data.db")
    h = Hub(s, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = SourcesHermes(tmp_path)
    h.events = []

    async def broadcast(event):
        h.events.append(event)
    h.broadcast = broadcast
    yield h
    s.close()


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def test_a_request_without_a_source_still_means_petdex(client, hub):
    owner = await pair_phone(client, hub)
    data = await (await client.get("/api/pets/catalog?q=pixel", headers=owner.auth)).json()
    assert [p["slug"] for p in data["pets"]] == ["pixel"] and hub.hermes.catalog_calls == []
    resp = await post_signed(client, owner, "/api/pets/mochi/adopt", {})  # an old app sends no source
    job = await finished(client, owner, (await resp.json())["job"]["id"])
    assert job["state"] == "succeeded" and hub.hermes.downloads == ["mochi"] and hub.hermes.adopt_calls == []
    assert job["detail"]["pet"] == "mochi"
    assert (await client.get("/api/pets/catalog?source=petdex", headers=owner.auth)).status == 200
    assert hub.hermes.catalog_calls == []


async def test_the_codex_source_has_its_own_gallery_with_working_thumbnails(client, hub):
    owner = await pair_phone(client, hub)
    data = await (await client.get("/api/pets/catalog?source=codex&q=kane&offset=30", headers=owner.auth)).json()
    assert hub.hermes.catalog_calls == [("codex", "kane", 30)]
    pet = data["pets"][0]
    assert pet["slug"] == "kanegon-codexpets" and pet["description"] and data["next_offset"] == 60
    assert pet["thumb_url"].startswith("/api/pets/kanegon-codexpets/thumb?sig=")
    hub.hermes.gallery["kanegon-codexpets"] = "Kanegon"
    thumb = await client.get(pet["thumb_url"])  # signed link: the phone never calls codex-pets.net
    assert thumb.status == 200 and thumb.headers["Content-Type"] == "image/png"
    assert (await client.get("/api/pets/catalog?source=nonsense", headers=owner.auth)).status == 400
    assert (await client.get("/api/pets/catalog?source=codex", headers={})).status in (401, 403)


async def test_adopting_from_codex_is_an_owner_only_signed_job(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    path = "/api/pets/kanegon-codexpets/adopt"
    assert (await client.post(path, json={"source": "codex"}, headers=owner.auth)).status == 403  # unsigned
    assert (await post_signed(client, member, path, {"source": "codex"})).status == 403  # not an owner
    assert hub.hermes.adopt_calls == []
    resp = await post_signed(client, owner, path, {"source": "codex", "idempotency_key": "c1"})
    assert resp.status == 202
    job = await finished(client, owner, (await resp.json())["job"]["id"])
    assert job["state"] == "succeeded" and job["detail"]["pet"] == "kanegon-codexpets"
    assert hub.hermes.adopt_calls == [("codex", "kanegon-codexpets")] and hub.hermes.downloads == []
    assert [a["summary"] for a in hub.store.list_audit(limit=5) if a["action"] == "pet"] == [
        "adopted kanegon-codexpets from codex-pets.net"]
    # It is installed now, so choosing it again is instant.
    hub.hermes.gallery["kanegon-codexpets"] = "Kanegon"
    again = await post_signed(client, owner, path, {"source": "codex"})
    assert again.status == 200 and (await again.json())["pet"]["slug"] == "kanegon-codexpets"
    assert (await post_signed(client, owner, path, {"source": "bogus"})).status == 400


async def test_a_codex_install_that_is_refused_fails_the_job_with_its_reason(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/pets/boba2/adopt", {"source": "codex"})  # not one of ours
    job = await finished(client, owner, (await resp.json())["job"]["id"])
    assert job["state"] == "failed" and "isn't offered" in job["detail"]["message"]


async def test_the_app_is_told_when_a_second_source_exists(client, hub):
    assert hub.features()["pet_sources"] is True
    hub.hermes.pet_catalog_from = None
    assert hub.features()["pet_sources"] is False  # an older Hermes side: the app keeps to petdex


# -- all the way through Hermes's own pet store ---------------------------------------------------------------

@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "config.yaml").write_text("display:\n  pet:\n    enabled: false\n")
    from plugin import hermes_api
    return hermes_api


@needs_hermes
@pytest.mark.parametrize("size,rows", [((1536, 1872), 9), ((1536, 2288), 11)])
def test_hermes_shows_a_codex_pet_v1_or_the_taller_v2(hermes_home, net, size, rows):
    h = hermes_home
    from agent.pet import store
    net.json(f"{petsource.CODEX_API}?page=1&pageSize=30", listing(raw("kanegon"), total=1))
    serve_pet(net, "kanegon", sheet=sheet_png(size), displayName="Kanegon")
    found = h.pet_catalog_from("codex", "", 0)
    assert found["pets"] == [{"slug": "kanegon-codexpets", "name": "Kanegon", "kind": "creature", "by": "Owner Name",
                              "curated": False, "description": "About kanegon.", "installed": False}]
    assert h.pet_thumbnail("kanegon-codexpets").startswith(b"\x89PNG")  # not installed yet: from the preview
    assert not h.pet_installed("kanegon-codexpets")
    assert h.adopt_pet_from("codex", "kanegon-codexpets") == {"slug": "kanegon-codexpets", "name": "Kanegon"}
    assert h.pet_installed("kanegon-codexpets") and h.pets()["active"] == "kanegon-codexpets"
    pet = h.active_pet()
    assert pet["columns"] == 8 and pet["rows"] == rows and pet["mime"] == "image/webp"
    assert pet["state_rows"][3] == "waving" and pet["frames"]["idle"] == 6 and pet["palette"]["base"] == "#c85028"
    assert h.pet_catalog_from("codex", "", 0)["pets"][0]["installed"] is True
    assert h.pets()["pets"] == [{"slug": "kanegon-codexpets", "name": "Kanegon", "description": "About kanegon.",
                                 "generated": False, "by": "Owner Name"}]  # the sheet can say who made it
    assert h.pet_thumbnail("kanegon-codexpets").startswith(b"\x89PNG")
    assert h.remove_pet("kanegon-codexpets") and store.load_pet("kanegon-codexpets") is None


@needs_hermes
def test_hermes_wont_install_over_a_pet_that_has_the_same_name(hermes_home, net, tmp_path):
    h = hermes_home
    from agent.pet import store
    from test_pets import make_sheet
    # Another pet already has this slug: choosing it picks that pet, and its files stay as they were.
    make_sheet(tmp_path / "mine.webp")
    store.register_local_pet(str(tmp_path / "mine.webp"), slug="kanegon-codexpets", display_name="Mine")
    before = (store.pets_dir() / "kanegon-codexpets" / "spritesheet.webp").read_bytes()
    serve_pet(net)
    assert h.adopt_pet_from("codex", "kanegon-codexpets") == {"slug": "kanegon-codexpets", "name": "Mine"}
    assert (store.pets_dir() / "kanegon-codexpets" / "spritesheet.webp").read_bytes() == before
    assert not any("spritesheet" in c for c in net.calls)
    # A folder with that name but no sheet (so nothing to pick) is refused rather than filled in.
    (store.pets_dir() / "taken-codexpets").mkdir()
    (store.pets_dir() / "taken-codexpets" / "pet.json").write_text(json.dumps({"displayName": "Someone's"}))
    serve_pet(net, "taken")
    with pytest.raises(h.HermesRefused, match="already on this server"):
        h.adopt_pet_from("codex", "taken-codexpets")
    assert sorted(p.name for p in (store.pets_dir() / "taken-codexpets").iterdir()) == ["pet.json"]
    with pytest.raises(h.HermesRefused, match="isn't offered"):
        h.adopt_pet_from("codex", "boba")
    with pytest.raises(h.HermesRefused, match="isn't offered"):
        h.pet_catalog_from("elsewhere")


@needs_hermes
def test_an_unreachable_codex_gallery_is_a_plain_refusal(hermes_home, net):
    with pytest.raises(hermes_home.HermesRefused, match="codex-pets.net"):
        hermes_home.pet_catalog_from("codex", "", 0)
