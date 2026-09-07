# Security and privacy

[Documentation index](README.md)

## Scope and credentials

The extension uses portal tabs the host has already signed into. It does not present a credential form, call the cookies API, copy authorization headers, inspect request bodies, or replay authenticated requests from a server.

It observes response bodies and DOM content on permitted pages. Endpoint filtering is heuristic, not a guarantee that a response contains no sensitive fields. Parsed response payloads cross the page-to-content-script bridge before adapters reduce them. Only allowlisted toll/trip fields are sent to the worker and stored.

Explicit sync also derives read-only reservation-detail JSON GETs from numeric `/us/en/reservation/<id>` links discovered in history cards. The request origin and path are fixed to `https://turo.com/api/reservation/detail`; the extension supplies only `oppTermsAware=true` and the discovered numeric reservation ID. Link queries/fragments cannot flow into the request, embedded credentials are rejected, and redirects or unexpected response URLs are refused. Chrome attaches same-origin session credentials; the extension never inspects them. This follows Chrome's [content-script network request model](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests). No arbitrary URL command is exposed through page messaging or the worker.

Detail bodies must have a JSON content type and remain within the two-million-byte limit. The adapter considers only the response root and a short list of explicit envelopes; it returns only reservation ID, vehicle ID, and trip boundaries. The fetched payload can transiently contain personal information in tab memory, but unrelated fields are not sent to the worker or persisted. Detail jobs/results are discarded after collection, clear, or navigation. Reads stop on unsupported, malformed, signed-out, or challenge responses instead of attempting a bypass.

## Permissions

| Declaration | Purpose |
| --- | --- |
| `storage` | Persist local snapshots and settings |
| `https://turo.com/*` | Inject collectors and query/message the Turo tab |
| `https://www.e-zpassny.com/*` | Inject collectors and query/message the NY portal tab |
| `https://e-zpassny.com/*` | Support the portal's apex hostname |

No `cookies`, `webRequest`, `tabs`, `scripting`, `activeTab`, `offscreen`, `declarativeNetRequest`, `unlimitedStorage`, or all-sites permission is declared. Static script injection and matching tab access use the declared host permissions. The passive page observer makes no API requests. Its body capture is restricted to the exact history and transactions page paths; origin-wide startup registration supports SPA navigation. The separate history detail reader performs only the bounded same-origin JSON GETs described above, without additional permissions. Version 0.4.7 also reuses one temporary inactive Turo tab for exact reservation invoice/status routes; it closes the tab in `finally` and stores only reduced eligibility metadata.

## Trust boundaries

- **MAIN world:** runs alongside portal JavaScript. A portal can detect, modify, disable, or spoof observation. This is not an anti-tampering boundary.
- **ISOLATED world:** validates bridge origin/source/type, bounds traversal, and reduces records. The bridge is a data channel, never a fetch/command API.
- **Worker:** accepts privileged operations only from its own popup or dashboard sender; revalidates records and settings before storage.
- **Storage:** access is restricted to `TRUSTED_CONTEXTS`, so content scripts cannot read it directly.
- **Popup:** portal-derived text is rendered with `textContent`, not HTML injection.

Identity/permission checks reduce exposure; they do not prove that portal records are authentic, complete, or chargeable.

## Data lifecycle

Tab memory contains captured toll/trip fields. Network records can accumulate while the supported route remains open, including across filter changes. Leaving the route clears captures. Clear/reload before beginning a new filter workflow. A successful explicit sync persists normalized records, derived suggestions, settings, and refresh timestamps. Tags, plates, travel times, and vehicle IDs should be treated as personal information.

The code has no telemetry, analytics service, backend upload, cloud-sync storage, or remote executable dependencies. It does not implement application-level encryption, automatic expiry, account binding, or secure erasure of disk remnants. Protect the OS and Chrome profile and clear data when no longer needed.

**Clear local data** removes the extension storage key and asks reachable collectors to clear/pause. It does not remove portal records, clear login cookies, or erase browser/OS backups. Reload unreachable tabs; a subsequent sync can capture visible records again.

## Safe diagnostics and contributions

Never commit raw account exports, HAR files, cookies, tokens, passwords, guest names, payment details, screenshots with personal data, or unredacted request URLs. A HAR may contain credentials even if its response body looks harmless.

Prefer synthetic fixtures preserving the relevant key names and date formats. If a real fixture is necessary, remove sensitive fields and replace IDs consistently before it leaves the device. Inspect files and diffs before committing.

For a suspected security issue, avoid publishing an exploit containing personal data or credentials. This repository does not declare a private reporting address or response SLA; use an available private maintainer channel if one has been established. Do not assume a public issue is confidential.

## Commercial deployment requirements

Before distribution, validate supported portal terms/access requirements, privacy disclosures, consent, retention behavior, data accuracy, and the intended Chrome Web Store submission requirements. These are release tasks, not guarantees supplied by the current code or this document.

There is no challenge bypass, stealth browser, automated claim submission, or guarantee of undetected access. The tool is not affiliated with or endorsed by Turo or E-ZPass.
