# Security Policy

Winglet connects your phone to an AI agent that can act on your behalf, so we take
security seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Instead, report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](../../security/advisories/new)).

Include what you found, how to reproduce it, and what an attacker could do with it.
We'll acknowledge the report as soon as we can and keep you updated on the fix.

## Supported versions

Winglet is pre-alpha. Only the latest code on `main` is supported.

## Pairing and browser approval

A full pairing link carries an out-of-band server fingerprint. A manual code alone does not
justify trusting a fingerprint fetched over that same network; code-only connections remain
unpinned and cannot claim verified owner access. Existing pinned identities reject a conflicting link.

The browser-linking flow shipped in v0.10.7 and requires the matching server API. Publication
does not establish physical-phone/camera verification; see APP_PLAN for those gates. A browser generates its own
Ed25519 key in memory and shows only a public request id and fingerprint in the QR. A verified
owner on that same, already-pinned server must compare the six-digit code, explicitly choose
a role (Member by default), confirm and approve. Requester-supplied browser name/platform are
not trusted identities. Never approve a QR for a browser you are not signing into. Scanning an
unknown server's request sends no saved credential to it. Approval preview is signed and uses
the parent pairing; the approval binds the exact preview key and code.

Create/claim data is sealed using separate purposes. The claim signs
`winglet-device-link-claim-v1\n<id>\n<poll_token>` with the browser's own key. The phone never
receives the browser token or private key. An approved one-use claim is retained in memory on
local storage failure so Retry saving cannot mint another device; reloading loses that recovery
state. Do not start another identity while a save is unresolved. A lost one-use response is
ambiguous; Devices can remove an orphan before a deliberate new sign-in.

See [the flow and limitations](docs/DEVICE_LINKING.md). App tests use isolated fake HTTP, not a
phone or live gateway. Backend enforcement and integrated browser testing are separate gates.

## Update authorization and installation boundaries

The published v0.10.7 updater accepts only signed owner requests for a trusted, exact release;
the server resolves its full commit SHA, checks Hermes compatibility and rejects a downgrade.
The owner authorizes the release and its declared Python dependencies, not arbitrary packages.
Local phone authentication is a UI gate, not server-verifiable biometric proof.

The new unified app Update action is local work, not a standing auto-install permission. Its
contract binds the matching app/plugin release and original pairing, keeps failure/unknown
outcomes visible, and does not silently select another release or server. Android retains its
package-install confirmation. Opening that installer is not evidence the APK was installed;
APK and running-plugin versions must be verified separately. No update is made merely because
a release appears. See [update trust and rollback limits](docs/SERVER_PLUGIN_UPDATE.md) and
[implementation, test and deployment status](docs/APP_PLAN.md).

## Automatic remote access

Automatic setup publishes the Winglet HTTP/WebSocket service through a Cloudflare Quick Tunnel.
Pairing codes and device tokens still protect the API. Cloudflare terminates HTTPS and can read
traffic and tokens; the tunnel is not end-to-end encrypted against Cloudflare. Use direct mode
with a connection you control if that trust model is unsuitable.

Android address discovery uses a separate random AES-GCM key and random ntfy topic per device.
Encrypted announcements bind the server, device and increasing address revision. The app
validates an HTTPS Quick Tunnel hostname and the server identity before forwarding its saved
token, then verifies the paired device. Revocation removes the device's discovery enrollment.
ntfy learns topic/timing/IP metadata and can interfere with availability, but receives neither
discovery keys nor plaintext addresses/tokens. All downloaded tunnel binaries are version-pinned
and checked against official release SHA-256 digests before execution.

Optional built-in Android delivery (off unless the owner picks it) registers with Google Play services and
receives the same sealed Web Push messages through Google's Web Push host. The message itself stays
encrypted end to end, so Google cannot read titles, bodies, links or approval details. Google can see this
phone's push address, the sender's IP address, timing, message size and urgency, in the same way ntfy
sees them when it is the distributor. It relies on an internal Google Play services interface that is not
a documented public API, so it may need updating when Google changes it, and it is unavailable on phones
without Google Play services. The ntfy/UnifiedPush path is unchanged and remains the default.
In Quick Tunnel mode, Android address recovery still publishes encrypted announcements through ntfy, so the
built-in option removes the need for the ntfy app, not for ntfy.sh. It was only tested with a permanent
connection (direct mode), not Quick Tunnel.
