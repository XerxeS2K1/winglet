"""A second place pets come from: codex-pets.net.

Hermes's own pet code only downloads from petdex hosts, so this module is Winglet's own downloader for
other named sources. It is deliberately narrow:

* https only, one host (codex-pets.net, which also serves its own images), no userinfo, no odd ports;
* a redirect is followed only to the same host, and at most a few times;
* every download has a size cap and a timeout, and what arrives must decode as a real image of the
  geometry Hermes draws (192x208 cells, 8 columns, 9 rows, or 11 on the newer taller sheets);
* the phone never talks to the source: thumbnails are fetched here and served as PNG through the signed
  /thumb route, like petdex's;
* what is installed is written the way Hermes stores a pet (pets/<slug>/pet.json + spritesheet), under a
  slug with a source suffix, so it can never replace a pet that is already there.

Nothing here touches the network at import time. The one function that does, `_hop`, is the single place
the tests replace.
"""

from __future__ import annotations

import contextvars
import http.client
import io
import json
import re
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urljoin, urlsplit

SOURCES = {"petdex": "petdex.dev", "codex": "codex-pets.net"}
DEFAULT_SOURCE = "petdex"

CODEX_HOST = "codex-pets.net"
CODEX_API = f"https://{CODEX_HOST}/api/pets"
# Added to a codex-pets.net id to make the slug it is installed under (and shown in the gallery under).
CODEX_SUFFIX = "-codexpets"
CODEX_MARK = "codex-pets.net"

PAGE_SIZE = 30
LIST_LIMIT = 1_000_000        # one list page of 30 pets is about 40 KB
DETAIL_LIMIT = 200_000
PREVIEW_LIMIT = 1_000_000     # a strip of animation frames, about 160 KB
# The brief said about 2 MB; real sheets here run up to 3.2 MB (14 of the 30 on the first page are over 2 MB).
SHEET_LIMIT = 4_000_000
TIMEOUT = 8.0
SHEET_TIMEOUT = 30.0
MAX_REDIRECTS = 3
CACHE_SECONDS = 300
MAX_PIXELS = 4_000_000        # an 11-row sheet is 3.5 million

FRAME_W, FRAME_H = 192, 208
SHEET_COLUMNS = 8
SHEET_ROWS = (9, 11)          # Codex atlas v1 and v2
THUMB_W = 96                  # as Hermes's own thumbnails
IMAGE_FORMATS = ("WEBP", "PNG")

_CODEX_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,59}")
_HOP_DEADLINE: contextvars.ContextVar[Optional[float]] = contextvars.ContextVar("pet_hop_deadline", default=None)
_USER_AGENT = "winglet-pets"


class PetSourceError(RuntimeError):
    """A pet couldn't be fetched, or isn't acceptable. The message is fit to show the owner."""


# -- slugs ------------------------------------------------------------------------------------------

def codex_slug(pet_id: str) -> str:
    return f"{pet_id}{CODEX_SUFFIX}"


def codex_id(slug: str) -> Optional[str]:
    """The codex-pets.net id behind an installed slug, or None when the slug isn't one of ours."""
    if not slug.endswith(CODEX_SUFFIX):
        return None
    pet_id = slug[: -len(CODEX_SUFFIX)]
    return pet_id if _CODEX_ID.fullmatch(pet_id) else None


# -- the network, one narrow door -------------------------------------------------------------------

def _check_url(url: str) -> str:
    """The URL when it is https on the one allowed host, else an error. Used for every request and redirect."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise PetSourceError("That address isn't valid.") from None
    if parts.scheme != "https" or (parts.hostname or "").lower() != CODEX_HOST or parts.username or parts.password \
            or port not in (None, 443):
        raise PetSourceError(f"Refusing an address outside {CODEX_HOST}.")
    return url


def _asset_url(url: Any) -> str:
    """An image address from the source's data: only on the allowed host, only under its asset path."""
    if not isinstance(url, str):
        return ""
    try:
        _check_url(url)
    except PetSourceError:
        return ""
    return url if urlsplit(url).path.startswith("/assets/pets/") else ""


def _read_capped(response, limit: int, deadline: Optional[float] = None) -> bytes:
    """Read at most limit + 1 bytes, so an oversize body is noticed without being held whole.

    ``deadline`` is a monotonic absolute time: a server that trickles bytes just under the socket
    timeout still cannot hold the download open indefinitely.
    """
    chunks, size = [], 0
    while size <= limit:
        if deadline is not None and time.monotonic() > deadline:
            raise PetSourceError("That download took too long, so it was stopped.")
        chunk = response.read(min(65536, limit + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks)


def _hop(url: str, timeout: float, limit: int) -> Tuple[int, Dict[str, str], bytes]:
    """One GET, no redirects followed: (status, lower-case headers, body of at most limit + 1 bytes)."""
    parts = urlsplit(url)
    conn = http.client.HTTPSConnection(parts.hostname or "", parts.port or 443, timeout=timeout)
    try:
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        conn.request("GET", target, headers={"User-Agent": _USER_AGENT, "Accept": "application/json, image/*"})
        response = conn.getresponse()
        headers = {k.lower(): v for k, v in response.getheaders()}
        declared = headers.get("content-length", "")
        if declared.isdigit() and int(declared) > limit:
            return response.status, headers, b"\0" * (limit + 1)  # too big: not read
        # The deadline belongs to the whole fetch, not this hop: a redirect chain gets no new budget.
        return response.status, headers, _read_capped(response, limit, _HOP_DEADLINE.get())
    finally:
        conn.close()


def fetch(url: str, *, limit: int, timeout: float = TIMEOUT) -> Tuple[Dict[str, str], bytes]:
    """GET an allowed URL. Redirects are followed only within the allowed host; the body is capped."""
    deadline = time.monotonic() + timeout * 2
    token = _HOP_DEADLINE.set(deadline)
    try:
        for _ in range(MAX_REDIRECTS + 1):
            if time.monotonic() > deadline:
                raise PetSourceError("That download took too long, so it was stopped.")
            _check_url(url)
            try:
                status, headers, body = _hop(url, timeout, limit)
            except PetSourceError:
                raise
            except Exception as exc:
                raise PetSourceError(f"Couldn't reach {CODEX_HOST}.") from exc
            if status in (301, 302, 303, 307, 308):
                where = headers.get("location", "")
                if not where:
                    raise PetSourceError("The download was redirected somewhere it can't be followed.")
                url = urljoin(url, where)  # _check_url at the top of the loop refuses any other host
                continue
            if status != 200:
                raise PetSourceError(f"{CODEX_HOST} answered {status}.")
            if len(body) > limit:
                raise PetSourceError("That file is bigger than a pet should be, so it was refused.")
            return headers, body
        raise PetSourceError("The download was redirected too many times.")
    finally:
        _HOP_DEADLINE.reset(token)


def _fetch_json(url: str, limit: int) -> Any:
    _, body = fetch(url, limit=limit)
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise PetSourceError(f"{CODEX_HOST} sent something that isn't pet data.") from None


# -- images -----------------------------------------------------------------------------------------

def decode_image(data: bytes):
    """Open and fully decode `data` as one WebP or PNG picture; refuses anything else. Returns the PIL image."""
    from PIL import Image
    try:
        image = Image.open(io.BytesIO(data))
        if image.format not in IMAGE_FORMATS:
            raise PetSourceError("That file isn't a WebP or PNG picture, so it was refused.")
        if image.width * image.height > MAX_PIXELS:
            raise PetSourceError("That picture is far larger than a pet sheet, so it was refused.")
        if getattr(image, "n_frames", 1) > 1:
            raise PetSourceError("That picture is animated; a pet sheet is a single image.")
        image.load()
        return image
    except PetSourceError:
        raise
    except Exception:
        raise PetSourceError("That file isn't a readable picture, so it was refused.") from None


def check_sheet(data: bytes) -> str:
    """Validate a downloaded spritesheet: a real image in Hermes's pet geometry. Returns its file extension."""
    image = decode_image(data)
    if image.width != FRAME_W * SHEET_COLUMNS or image.height not in tuple(FRAME_H * r for r in SHEET_ROWS):
        raise PetSourceError(f"That sheet is {image.width}x{image.height}, not a pet sheet "
                             f"({FRAME_W * SHEET_COLUMNS}x{FRAME_H * SHEET_ROWS[0]} or {FRAME_H * SHEET_ROWS[1]}).")
    return ".png" if image.format == "PNG" else ".webp"


def preview_png(data: bytes) -> bytes:
    """A small PNG of a pet's first frame, like Hermes's own thumbnails (96 wide, nearest-neighbour).

    The preview is a strip of 96x104 frames side by side (7008x104 for 73 frames), so the first frame is the
    leftmost cell; a picture that is already one frame is used whole.
    """
    from PIL import Image
    image = decode_image(data).convert("RGBA")
    cell = round(image.height * FRAME_W / FRAME_H)
    if image.width > cell * 1.3:
        image = image.crop((0, 0, cell, image.height))
    image = image.resize((THUMB_W, round(THUMB_W * FRAME_H / FRAME_W)), Image.NEAREST)
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


# -- the gallery ------------------------------------------------------------------------------------

_lock = threading.Lock()
_pages: "OrderedDict[Tuple[str, int], Tuple[float, dict]]" = OrderedDict()
_entries: "OrderedDict[str, Tuple[float, dict]]" = OrderedDict()


def clear_cache() -> None:
    with _lock:
        _pages.clear()
        _entries.clear()


def _entry(raw: Any) -> Optional[dict]:
    """One pet from the source's JSON as Winglet uses it, or None when it must not be offered."""
    if not isinstance(raw, dict) or raw.get("ownerShadowbanned"):
        return None
    pet_id = str(raw.get("id") or "")
    sheet = _asset_url(raw.get("spritesheetUrl"))
    if not _CODEX_ID.fullmatch(pet_id) or not sheet:
        return None
    name = str(raw.get("displayName") or "").strip() or pet_id
    return {"id": pet_id, "slug": codex_slug(pet_id), "name": name[:80], "kind": str(raw.get("kind") or "pet")[:30],
            "by": str(raw.get("ownerName") or raw.get("ownerHandle") or "")[:80],
            "description": str(raw.get("description") or "")[:300], "sheet": sheet,
            "preview": _asset_url(raw.get("previewUrl")) or _asset_url(raw.get("posterUrl"))}


def _remember(entries: List[dict]) -> None:
    now = time.monotonic()
    with _lock:
        for e in entries:
            _entries[e["id"]] = (now, e)
            _entries.move_to_end(e["id"])
        while len(_entries) > 600:
            _entries.popitem(last=False)


def catalog_page(query: str = "", offset: int = 0) -> dict:
    """A page of the gallery. `offset` counts the source's own list (a pet that is skipped still takes its
    place), and `next_offset` says where the next page starts."""
    page = offset // PAGE_SIZE + 1
    key = (query.lower(), page)
    now = time.monotonic()
    with _lock:
        hit = _pages.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        data = hit[1]
    else:
        url = f"{CODEX_API}?page={page}&pageSize={PAGE_SIZE}" + (f"&q={quote(query)}" if query else "")
        data = _fetch_json(url, LIST_LIMIT)
        if not isinstance(data, dict) or not isinstance(data.get("pets"), list):
            raise PetSourceError(f"{CODEX_HOST} sent something that isn't a pet list.")
        with _lock:
            _pages[key] = (now, data)
            while len(_pages) > 40:
                _pages.popitem(last=False)
    raw = data["pets"]
    reported = data.get("pageSize")
    size = reported if isinstance(reported, int) and reported > 0 else PAGE_SIZE
    total = data.get("total")
    if not isinstance(total, int):
        total = (data.get("pagination") or {}).get("totalItems") if isinstance(data.get("pagination"), dict) else None
    skip = offset % PAGE_SIZE
    entries = [e for e in (_entry(r) for r in raw[skip:]) if e]
    _remember(entries)
    next_offset = (page - 1) * size + len(raw)
    return {"total": total if isinstance(total, int) else next_offset, "next_offset": next_offset, "pets": entries}


def entry_for(pet_id: str) -> dict:
    """One pet's entry: from the gallery pages already seen, else from the source's detail page."""
    if not _CODEX_ID.fullmatch(pet_id):
        raise PetSourceError("That isn't a codex-pets.net pet.")
    with _lock:
        hit = _entries.get(pet_id)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    data = _fetch_json(f"{CODEX_API}/{quote(pet_id)}", DETAIL_LIMIT)
    raw = data.get("pet") if isinstance(data, dict) else None
    if isinstance(raw, dict) and raw.get("ownerShadowbanned"):
        raise PetSourceError("That pet isn't available.")
    entry = _entry(raw)
    if entry is None or entry["id"] != pet_id:
        raise PetSourceError("That pet isn't on codex-pets.net.")
    _remember([entry])
    return entry


# -- thumbnails and installs --------------------------------------------------------------------------

def thumbnail(pet_id: str, cache: Path) -> Optional[bytes]:
    """The PNG thumbnail of a pet that isn't installed, fetched once and kept at `cache` (as Hermes's are)."""
    try:
        return cache.read_bytes()
    except OSError:
        pass
    try:
        entry = entry_for(pet_id)
        if not entry["preview"]:
            return None
        _, data = fetch(entry["preview"], limit=PREVIEW_LIMIT)
        png = preview_png(data)
    except PetSourceError:
        return None
    try:
        part = cache.with_suffix(".part")
        part.write_bytes(png)
        part.replace(cache)
    except OSError:
        pass
    return png


def _marked(directory: Path, pet_id: str) -> bool:
    try:
        meta = json.loads((directory / "pet.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return False
    return isinstance(meta, dict) and meta.get("source") == CODEX_MARK and meta.get("sourceId") == pet_id


def install(pet_id: str, pets_dir: Path) -> dict:
    """Download one pet into Hermes's pet store. Returns {"slug", "name"}.

    The slug carries the source suffix; a folder already under that slug is only reused when this module
    made it for this very pet, so nothing else can ever be overwritten.
    """
    entry = entry_for(pet_id)  # refuses ids that aren't listed, and shadow-banned owners
    slug = entry["slug"]
    _, data = fetch(entry["sheet"], limit=SHEET_LIMIT, timeout=SHEET_TIMEOUT)
    extension = check_sheet(data)
    directory = pets_dir / slug
    created = False
    try:
        directory.mkdir(parents=True)
        created = True
    except FileExistsError:
        if not _marked(directory, pet_id):
            raise PetSourceError("A pet with that name is already on this server, so this one wasn't installed.") from None
    sheet = directory / f"spritesheet{extension}"
    part = directory / f"spritesheet{extension}.part"
    meta = {"id": slug, "displayName": entry["name"], "description": entry["description"],
            "spritesheetPath": sheet.name, "source": CODEX_MARK, "sourceId": pet_id, "author": entry["by"]}
    try:
        part.write_bytes(data)
        (directory / "pet.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        part.replace(sheet)  # the sheet appears last: a folder with a sheet always has its pet.json
    except OSError as exc:
        if created:
            shutil.rmtree(directory, ignore_errors=True)  # only a folder made just now, never an earlier one
        else:
            part.unlink(missing_ok=True)
        raise PetSourceError("The pet couldn't be saved on the server.") from exc
    return {"slug": slug, "name": entry["name"]}
