"""Short-lived browser linking, authorized by an existing verified owner's signature.

The QR identifies a request, not a credential. Only the requesting browser holds
both the polling secret and the private key whose public half the owner approves.
Outstanding requests deliberately do not survive a gateway restart.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from typing import Any

from aiohttp import web

from . import keys

TTL_SECONDS = 180
MAX_PENDING = 128
MAX_CREATES_PER_MINUTE = 60
MAX_PEER_CREATES_PER_MINUTE = 6
_ID = re.compile(r"[A-Za-z0-9_-]{32}\Z")


class DeviceLinks:
    def __init__(self, hub):
        self.hub = hub
        self.pending: dict[str, dict[str, Any]] = {}
        self._creates: list[tuple[float, str]] = []

    def register(self, app):
        app.router.add_post("/api/device-links", self.h_device_link_create)
        app.router.add_get("/api/device-links/{id}", self.h_device_link_preview)
        app.router.add_post("/api/device-links/{id}/approve", self.h_device_link_approve)
        app.router.add_post("/api/device-links/{id}/deny", self.h_device_link_deny)
        app.router.add_post("/api/device-links/{id}/claim", self.h_device_link_claim)

    def _prune(self):
        now = time.monotonic()
        self.pending = {k: v for k, v in self.pending.items() if v["deadline"] > now}
        self._creates = [(at, peer) for at, peer in self._creates if now - at < 60]

    def _lookup(self, request):
        self._prune()
        ident = request.match_info["id"]
        entry = self.pending.get(ident) if _ID.fullmatch(ident) else None
        if entry is None:
            raise web.HTTPNotFound(text='{"error":"This link expired. Show a new QR code."}',
                                   content_type="application/json")
        return entry

    @staticmethod
    def _preview(entry):
        return {key: entry[key] for key in ("id", "device_name", "platform", "sign_key",
                                            "verification_code", "expires_at", "status")}

    def _owner(self, request):
        # Middleware verified this request's signature; check current authority too, and that the key
        # which signed it is still the device's verified key (it can change while a body is being read).
        me = self.hub.store.get_device(self.hub._require(request)["id"])
        current = self.hub.store.device_sign_key(me["id"]) if me else ""
        if (not me or me["role"] != "owner" or not current
                or request.get("verified_sign_key") != current):
            raise web.HTTPForbidden(text='{"error":"A verified owner must approve this browser."}',
                                    content_type="application/json")
        return me

    async def _open(self, request, purpose, ident=""):
        body = await self.hub._body(request)
        blob = body.get("sealed")
        if not isinstance(blob, str) or len(blob) > 4096:
            raise ValueError("Use the app to create this link.")
        return self.hub.keys.unseal_json(blob, purpose, ident)

    def _limited(self, peer):
        return (len(self.pending) >= MAX_PENDING or len(self._creates) >= MAX_CREATES_PER_MINUTE
                or sum(p == peer for _, p in self._creates) >= MAX_PEER_CREATES_PER_MINUTE
                or self.hub._pair_throttled("link:" + peer))

    async def h_device_link_create(self, request):
        self._prune()
        peer = self.hub._pair_peer(request)
        if self._limited(peer):
            return web.json_response({"error": "Too many linking requests. Wait a minute and try again."}, status=429)
        try:
            data = await self._open(request, "device-link-create")
            public = data.get("sign_key")
            name = data.get("device_name")
            if (not isinstance(public, str) or len(public) != 43 or not keys.valid_public_key(public)
                    or keys.b64e(keys.b64d(public)) != public):
                raise ValueError("This browser needs its own signing key.")
            if data.get("platform") != "web":
                raise ValueError("This link is for a web browser.")
            if not isinstance(name, str) or not name.strip() or len(name) > 64 or any(ord(c) < 32 for c in name):
                raise ValueError("Enter a browser name of 1–64 characters.")
        except (ValueError, TypeError, keys.SealError):
            self.hub._pair_failed("link:" + peer)
            return web.json_response({"error": "This linking request is invalid. Show a new QR code."}, status=400)
        # Reading the body may yield; another create can fill the budget in between.
        self._prune()
        if self._limited(peer):
            return web.json_response({"error": "Too many linking requests. Wait a minute and try again."}, status=429)
        ident, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
        entry = {"id": ident, "device_name": name.strip(), "platform": "web", "sign_key": public,
                 "poll_hash": hashlib.sha256(token.encode()).digest(),
                 "verification_code": f"{secrets.randbelow(1000000):06d}",
                 "expires_at": time.time() + TTL_SECONDS, "deadline": time.monotonic() + TTL_SECONDS,
                 "status": "pending"}
        self.pending[ident] = entry
        self._creates.append((time.monotonic(), peer))
        return web.json_response({"id": ident, "poll_token": token,
                                  "verification_code": entry["verification_code"],
                                  "expires_at": entry["expires_at"], "fingerprint": self.hub.keys.fingerprint})

    async def h_device_link_preview(self, request):
        self._owner(request)
        return web.json_response(self._preview(self._lookup(request)))

    async def h_device_link_approve(self, request):
        data = await self.hub._body(request)
        me = self._owner(request)
        entry = self._lookup(request)
        if entry["status"] != "pending":
            return web.json_response({"error": "This link was already handled."}, status=409)
        role = data.get("role")
        if (role not in ("owner", "member") or data.get("sign_key") != entry["sign_key"]
                or data.get("verification_code") != entry["verification_code"]):
            return web.json_response({"error": "The browser details changed. Scan the QR code again."}, status=400)
        entry.update(status="approved", role=role, approver=me["id"],
                     approver_key=self.hub.store.device_sign_key(me["id"]))
        self.hub.audit("device.link_approved", me, f"Browser access approved as {role}")
        return web.json_response({"status": "approved"})

    async def h_device_link_deny(self, request):
        me = self._owner(request)
        entry = self._lookup(request)
        if entry["status"] != "pending":
            return web.json_response({"error": "This link was already handled."}, status=409)
        entry["status"] = "denied"
        self.hub.audit("device.link_denied", me, "Browser access denied")
        return web.json_response({"status": "denied"})

    async def h_device_link_claim(self, request):
        throttle = "link:" + self.hub._pair_peer(request)
        if self.hub._pair_throttled(throttle):
            return web.json_response({"error": "Too many attempts. Wait a minute and try again."}, status=429)
        entry = self._lookup(request)
        ident = entry["id"]
        try:
            data = await self._open(request, "device-link-claim", ident)
            token, signature = data.get("poll_token"), data.get("signature")
            if not isinstance(token, str) or not 32 <= len(token) <= 64 or not isinstance(signature, str):
                raise ValueError("Missing browser proof")
            payload = f"winglet-device-link-claim-v1\n{ident}\n{token}".encode()
            if (not hmac.compare_digest(hashlib.sha256(token.encode()).digest(), entry["poll_hash"])
                    or not keys.verify_device_signature(entry["sign_key"], payload, signature)):
                raise ValueError("Wrong browser proof")
        except (ValueError, TypeError, keys.SealError):
            self.hub._pair_failed(throttle)
            return web.json_response({"error": "This browser cannot claim that link."}, status=403)
        # Re-read after the body await: only one concurrent claim may create a device.
        entry = self._lookup(request)
        if entry["status"] != "approved":
            return web.json_response({"status": entry["status"], "expires_at": entry["expires_at"]})
        owner = self.hub.store.get_device(entry["approver"])
        if (not owner or owner["role"] != "owner"
                or self.hub.store.device_sign_key(owner["id"]) != entry["approver_key"]):
            del self.pending[ident]
            return web.json_response({"error": "The approving device no longer has access. Show a new QR code."}, status=403)
        device, token = self.hub.store.add_device(entry["device_name"], "web", role=entry["role"],
                                                 sign_key=entry["sign_key"], verified=True)
        del self.pending[ident]
        self.hub.audit("device.paired", device, f"Web browser linked as {device['role']}")
        return web.json_response({"status": "paired", "token": token, "device": device,
                                  "me": self.hub.me(device), "server_id": self.hub.server_id(),
                                  "bot": self.hub.bot()})
