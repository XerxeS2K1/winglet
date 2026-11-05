"""Web Push (plugin/webpush.py): the VAPID signature a push service checks, the request we build, and the limits.

Encryption is cross-checked against an independent library in test_hub.py; this covers the rest, which until now
nothing proved: a push service rejects a request whose signature, audience or headers are wrong, and the failure
is silent on the phone.
"""

import asyncio
import json

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from plugin import webpush

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
SUBJECT = "mailto:owner@example.com"


@pytest.fixture
def vapid():
    return webpush.generate_vapid_private_key()


@pytest.fixture
def subscription():
    ua = ec.generate_private_key(ec.SECP256R1())
    keys = {"p256dh": webpush.b64url_encode(webpush._public_bytes(ua.public_key())),
            "auth": webpush.b64url_encode(b"0123456789abcdef")}
    return {"endpoint": ENDPOINT, "keys": keys}, ua


def _parse(authorization: str):
    scheme, rest = authorization.split(" ", 1)
    assert scheme == "vapid"
    fields = dict(part.strip().split("=", 1) for part in rest.split(","))
    header, claims, signature = fields["t"].split(".")
    return header, claims, signature, fields["k"]


def test_the_vapid_signature_verifies_with_the_published_key(vapid):
    header, claims, signature, key = _parse(webpush.vapid_authorization(ENDPOINT, vapid, SUBJECT, now=1_000_000))
    assert key == webpush.vapid_public_key(vapid)
    raw = webpush.b64url_decode(signature)
    assert len(raw) == 64  # r and s as 32 bytes each, as JWT ES256 requires (not DER)
    public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.b64url_decode(key))
    public.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                  f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    with pytest.raises(InvalidSignature):  # and not with a different message
        public.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                      f"{header}.{claims}x".encode(), ec.ECDSA(hashes.SHA256()))


def test_the_vapid_claims_name_the_push_service_and_expire_in_twelve_hours(vapid):
    header, claims, _, _ = _parse(webpush.vapid_authorization(ENDPOINT + "?x=1", vapid, SUBJECT, now=1_000_000))
    assert json.loads(webpush.b64url_decode(header)) == {"typ": "JWT", "alg": "ES256"}
    assert json.loads(webpush.b64url_decode(claims)) == {
        "aud": "https://fcm.googleapis.com", "exp": 1_000_000 + 12 * 3600, "sub": SUBJECT}  # origin only, no path


def test_a_built_request_carries_what_a_push_service_requires(vapid, subscription):
    sub, ua = subscription
    url, headers, body = webpush.build_request(sub, {"title": "Approve?"}, vapid, SUBJECT,
                                               ttl=60, urgency="high", topic="chat 1/approval!" + "x" * 40)
    assert url == ENDPOINT
    assert headers["Content-Encoding"] == "aes128gcm" and headers["Content-Type"] == "application/octet-stream"
    assert headers["TTL"] == "60" and headers["Urgency"] == "high"
    assert headers["Topic"] == "chat1approval" + "x" * 19 and len(headers["Topic"]) == 32  # base64url alphabet, max 32
    assert headers["Authorization"].startswith("vapid t=")
    assert json.loads(webpush.decrypt(body, ua, sub["keys"]["auth"])) == {"title": "Approve?"}


def test_defaults_are_a_day_and_normal_urgency_and_no_topic(vapid, subscription):
    sub, _ = subscription
    _, headers, _ = webpush.build_request(sub, {"a": 1}, vapid, SUBJECT)
    assert headers["TTL"] == str(24 * 3600) and headers["Urgency"] == "normal" and "Topic" not in headers


def test_bad_keys_and_oversize_payloads_are_refused(subscription):
    sub, _ = subscription
    keys = sub["keys"]
    with pytest.raises(ValueError):
        webpush.encrypt(b"x", webpush.b64url_encode(b"short"), keys["auth"])
    with pytest.raises(ValueError):
        webpush.encrypt(b"x", keys["p256dh"], webpush.b64url_encode(b"tiny"))
    limit = 4096 - 17 - 86
    assert webpush.encrypt(b"x" * limit, keys["p256dh"], keys["auth"])
    with pytest.raises(ValueError, match="too large"):
        webpush.encrypt(b"x" * (limit + 1), keys["p256dh"], keys["auth"])


def test_every_push_is_encrypted_differently(subscription):
    sub, _ = subscription
    one = webpush.encrypt(b"same", sub["keys"]["p256dh"], sub["keys"]["auth"])
    two = webpush.encrypt(b"same", sub["keys"]["p256dh"], sub["keys"]["auth"])
    assert one != two  # a fresh salt and key each time


def test_only_known_push_services_are_allowed():
    assert webpush.allowed_endpoint(ENDPOINT)
    assert webpush.allowed_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x")
    assert webpush.allowed_endpoint("https://db5p.notify.windows.com/?token=x")
    assert webpush.allowed_endpoint("https://web.push.apple.com/Q123")
    for bad in ("http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x",
                "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x",
                "https://fcm.googleapis.com/x#frag", "https://fcm.googleapis.com/a b", "https://127.0.0.1/x", ""):
        assert not webpush.allowed_endpoint(bad), bad


def test_send_posts_the_built_request_without_following_redirects(vapid, subscription):
    sub, ua = subscription
    calls = []

    class Client:
        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return type("R", (), {"status_code": 410})()  # 410: the subscription is gone

    status = asyncio.run(webpush.send(Client(), sub, {"n": 1}, vapid, SUBJECT, topic="t"))
    assert status == 410
    (url, kwargs), = calls
    assert url == ENDPOINT and kwargs["follow_redirects"] is False and kwargs["timeout"] == 15.0
    assert kwargs["headers"]["Topic"] == "t"
    assert json.loads(webpush.decrypt(kwargs["content"], ua, sub["keys"]["auth"])) == {"n": 1}
