# Turo-Invoicer
Eliminate manual toll entry for New York Turo hosts. This tool bridges the gap where Turo automatically processes every major US toll agency except NY E-ZPass. By matching E-ZPass statement timestamps to active Turo trip schedules locally in the browser, it automates the reimbursement workflow without relying on brittle server-side scrapers or risking bot detection flags.

[README.md](https://github.com/user-attachments/files/31804256/README.md)
# Turo Toll Reconciler

A Manifest V3 Chrome extension scaffold that locally correlates E-ZPass NY toll
activity with Turo host trip windows. It uses the user's already-authenticated
portal tabs and never asks for or stores portal credentials.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Keep exactly one Turo portal tab and one E-ZPass NY portal tab open. Sign in
   normally. Reload those tabs after installing/reloading the extension, then
   open your host trip schedules and E-ZPass transaction activity.
5. Choose the appropriate date range in each portal and load the relevant pages.
   The extension observes data the portals load; it does not paginate for you.
6. Open the extension and choose **Sync open tabs**. Optionally configure vehicle
   mappings using the exact Turo vehicle IDs shown in the suggestions.

No npm installation or build is required. Chrome 111+ is required. To run the
dependency-free development checks with Node 20+:

```sh
npm run check
npm test
```

## Modules

| File | Responsibility |
| --- | --- |
| `manifest.json` | MV3 declarations and narrowly scoped host access |
| `background.js` | Cross-tab collection, privileged-message validation, atomic local snapshots |
| `network_hook.js` | MAIN-world fetch/XHR response observation, bounded parsing |
| `content_common.js` | Isolated-world bridge, bounded capture cache, DOM observer |
| `content_turo.js` | Trip schema aliases and DOM fallbacks |
| `content_ezpass.js` | Toll schema aliases and DOM fallbacks |
| `reconciler.js` | Pure time normalization and inclusive interval matching |
| `popup.html`, `popup.js`, `popup.css` | Sync, suggestions, exceptions, mappings, clear controls |
| `tests/` | Core, portal-adapter, bridge, and mocked service-worker regression tests |

## Security and permissions

- `storage` persists normalized trips, tolls, settings, and match results locally.
- Host permissions cover only `https://turo.com/*`,
  `https://www.e-zpassny.com/*`, and `https://e-zpassny.com/*`. No wildcard
  subdomain access is requested. The official entry points are
  [Turo](https://turo.com/us/en) and [E-ZPass NY](https://www.e-zpassny.com/).
- There is no `cookies`, `webRequest`, `declarativeNetRequest`, or broad browsing
  permission. The page hook observes JSON responses on the same domain family
  (including API subdomains) for relevant URL paths; it excludes authentication,
  profile, and payment paths. It never inspects request headers or bodies, nor
  requests the cookies API. The portal itself continues to authenticate requests.
- Raw API responses are not sent to the service worker or stored. Content scripts
  retain only the fields required for reconciliation. The bridge carries only
  response payloads, not URLs/query strings. Bridge messages are untrusted input
  and cannot trigger extension operations. DOM strings are rendered using
  `textContent`, never injected as HTML.
- Captures remain in tab memory until the user explicitly syncs. Saved snapshots
  use `storage.local` (not cloud-synced storage), with access restricted to trusted
  extension contexts. Clearing data removes the saved snapshot/settings and
  pauses/clears reachable page captures. It cannot remove original portal data.
- Local storage is not application-level encrypted. Treat saved travel times,
  vehicle IDs, tags, and plates as personal information and protect the browser
  profile accordingly. There are no analytics, backend uploads, or remote scripts.

An offscreen document is intentionally not used: extraction occurs in visible,
authenticated tabs and reconciliation is short-lived worker-safe computation.
Likewise, declarative network rules are unnecessary because no requests are
blocked, redirected, or modified.

The worker orchestrates collection from each authenticated tab; it deliberately
does not replay undocumented endpoints, copy authentication headers, or bypass
Cloudflare/challenges. This architecture does not guarantee a portal will permit
automated observation. See Chrome's documentation on
[host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions),
[content-script isolation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
and [storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Matching contract

```js
import { reconcileTolls } from "./reconciler.js";

const result = reconcileTolls(
  [{ id: "tx-1", timestamp: "2026-07-01 12:30", plaza: "Lincoln Tunnel",
     amount: "15.00", tagId: "0012345678" }],
  [{ id: "trip-1", vehicleId: "12345", start: "2026-07-01T09:00:00-04:00",
     end: "2026-07-01T18:00:00-04:00" }],
  { timeZone: "America/New_York", graceMinutes: 0,
    vehicleByTag: { "0012345678": "12345" } }
);
```

- Toll amounts are USD **major units**, not cents; integer-cent API fields must
  be explicitly converted in the adapter after verifying the schema. Refunds,
  negative charges, zero charges, and invalid amounts require review.
- Explicit ISO timestamps with offsets and epoch seconds/milliseconds are
  absolute instants. Zone-less ISO-like or US numeric date/time strings use
  `America/New_York`, not the browser's local zone. Unsupported, date-only,
  invalid-calendar, repeated-DST-hour, and nonexistent-DST-hour values fail closed.
- Match intervals are inclusive: `start <= toll <= end`. Adjacent trips sharing
  an endpoint are ambiguous. Grace is optional and flagged separately.
- Vehicle identity is essential. A tag/plate mapping resolves it; E-ZPass internal
  vehicle IDs are not assumed to be Turo vehicle IDs. A unique timestamp-only
  candidate is a **suggestion**, visibly marked “Confirm vehicle.” Multiple
  candidates are never automatically assigned. Contradictory mappings fail closed.
- The result includes `matched`, `ambiguous`, `unmatchedTolls`, `unmatchedTrips`,
  `invalidTrips`, and counts. It does not invoice guests or submit reimbursements.

Mapping JSON in the popup:

```json
{
  "tags": { "0012345678": "12345" },
  "plates": { "NY:ABC1234": "12345" }
}
```

Identifiers are exact, case-sensitive strings. Include the plate's state when
the portal supplies it; do not reuse mappings after moving a tag between vehicles.
Historical tag transfers need dated mappings, which are not part of this scaffold.

## Production integration notes

Portal markup and private response schemas are not stable public APIs. The
extractors therefore combine response-shape detection, selector fallbacks, and
debounced mutation observers. Before release, capture redacted fixtures from the
current production portals, tighten the key/selector adapters against those
fixtures, and add regression tests. Review both portals' applicable terms and
Chrome Web Store disclosure requirements before commercial distribution.

This scaffold has **not** been validated against authenticated live accounts.
It does not claim completeness of a statement or reservation history. Important
release checks:

1. Verify the current transaction API response shape and amount units. Match the
   toll passage timestamp, not posting date. Extend the URL filter for actual
   endpoints if needed (generic GraphQL endpoints are not assumed).
2. Verify confirmed/reserved/completed/cancelled trip statuses, extensions, late
   returns, and stable vehicle IDs against redacted fixtures. Cancellation signals
   remove previously captured trips only when a stable ID is present.
3. Compare counts/totals to the portal for paginated and virtualized lists. Capture
   is capped at 5,000 records, 20,000 JSON nodes, depth 8, and 2 MB per observed
   response. Truncation warnings mean the result is incomplete.
4. Clear data and reload both tabs before switching accounts or date-range
   workflows. The scaffold deliberately does not fingerprint or persist account
   identities. One-tab-per-source does not prove both accounts belong together.
5. Observe that network captures take precedence over DOM captures to avoid
   double-counting the same transaction under different representations. Missing
   source transaction IDs can still collapse identical-looking tolls: stable IDs
   and verified completeness are release requirements.
6. Exercise popup/reload/worker-suspension flows in Chrome with the unpacked
   extension. The automated tests mock Chrome APIs; they are not a live Chrome or
   authenticated portal end-to-end test.
7. Establish consent/privacy disclosures, retention policy, historical vehicle
   mapping rules, statement reconciliation totals, and a human approval workflow
   before making billing or production-readiness claims.
