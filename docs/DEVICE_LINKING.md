# Pairing and browser sign-in

This describes the new app flow. It requires the matching device-linking server API; an older
server keeps pairing-link and address/code access, without the browser QR option. This local
app slice is not a released build and has not been checked on a phone or against a live gateway.
This text now describes the local branch merged with the updater-repair integration; source-level
documentation is not a deployment record. See [APP_PLAN.md](APP_PLAN.md) for current status.

Related: [setup](../docs/SETUP.md), [security](../SECURITY.md),
[Hermes compatibility](HERMES_COMPATIBILITY.md) and the
[server update path](SERVER_PLUGIN_UPDATE.md). This is integrated locally at the audited snapshot
and **unreleased**; it is not phone-verified.

## Connect the first phone

Open Winglet and choose Scan QR code or Paste pairing link. Use the whole link printed by
`hermes winglet pair`, or shared from Add a device on an already-verified owner device.
Its fingerprint verifies the server key while connecting: there is no second verification step.
The result states Owner or Member and explains that access. An owner can manage devices,
settings and approvals; a member has their own chats. Memory and tools remain shared.

A link for a server already connected to this phone verifies that existing device. It does not
silently mint another device, replace its access token, or change its role. The current trusted
address is used for credential-bearing requests, not an arbitrary address in a scanned link.
A conflicting pinned fingerprint is refused.

Use address and code remains available. A code alone does not establish trust in a fingerprint
fetched over the same network. The result is labelled Limited connection, with Complete
verification inside the flow. Paste a fresh full link to finish. An already-verified existing
connection keeps its verified access when reused.

## Sign in a web browser with a trusted phone

1. Open Winglet on the server in the unpaired browser. The sign-in panel shows a QR and a
   six-digit check code, grouped XXX XXX.
2. On an already-paired, verified owner phone for that same server, open Devices → Link a
   device → Scan browser QR. Scanning only opens a preview; it never approves automatically.
3. Check the trusted server address and compare the code with the browser you are actually
   signing into. Request name/platform are requester-supplied labels, not verified identities.
   Do not approve a QR someone sends you for their browser.
4. Member is selected initially. Choose Owner only deliberately, confirm that the code matches,
   and press Approve as member/owner. Decline sign-in rejects it instead.
5. The browser claims its own identity and shows its verified role. Continue opens Winglet.

The QR contains only the public request id and server fingerprint, never a poll secret,
access token or private key. Unknown servers, unverified devices and members cannot authorize
this flow. No saved token is sent to an unknown QR origin. Other bots use the parent server's
pairing/signing key as before.

The browser generates fresh signing keys locally. Its request and poll secret stay in memory;
a signed/sealed claim proves possession of the browser key. No phone private key or token is
copied. Final browser credentials use the existing signing-key and server storage paths.
If local saving fails after the one-use claim, Retry saving reuses the retained identity and key
without creating or claiming another device. Manual pairing is blocked after browser approval;
switching to manual before approval pauses the pending browser request and cannot interrupt
an in-flight claim. Keep that tab open until saving finishes.

Requests expire after three minutes. Expired/denied/error states offer New QR; older servers
explain the fallback. Transient claim failures retry only within the request lifetime. Polling
stops when the screen/tab is hidden, unmounted, denied, expired or complete. Requests are
cancelled by a gateway restart. Reloading loses the in-memory request and unsaved claim;
a lost one-use claim response cannot be recovered by this API. Remove any orphaned browser
identity in Devices before deliberately starting again.

## Add another phone and manage devices

Devices remains the place to inspect access, verification, last seen and removal. Under Link a
device, Add a device still displays a single-use pairing QR, Copy link and native Share. This is
different from Scan browser QR, which previews a waiting browser's request for approval.
