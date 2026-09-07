# Architecture and message flow

[Documentation index](README.md)

## Execution contexts

```text
Portal's normal authenticated requests
  -> network_hook.js (MAIN world; observes responses)
  -> window.postMessage payload bridge
  -> content_common.js + portal adapter (ISOLATED world)
       ^ MutationObserver / DOM fallback
       |
Popup/dashboard -- RUN_SYNC --> service worker -- COLLECT_NOW --> Turo history
                                      |-- temporary inactive Turo status tab
                                      `-- COLLECT_NOW --> E-ZPass transactions
Popup/dashboard <-- results --- service worker <-- normalized records/status
                            |
                     reconciler.js
                            |
                     chrome.storage.local
```

The portal owns authentication. The worker does not recreate authenticated HTTP calls or move credentials across domains. Cross-domain orchestration asks tab-local collectors for reduced records. During explicit collection, the Turo reader can GET a narrowly allowlisted reservation-detail endpoint. The worker then reuses one inactive Turo tab for exact invoice-hub, invoice-detail, and toll-option pages before collecting E-ZPass.

## Manifest and loading

The worker is an ES module. Static content scripts start at `document_start`. The network hook runs in MAIN; the common collector, Turo detail helper (Turo only), and source adapter run in ISOLATED, in that order. The manifest targets top-level pages on the three declared origins for SPA lifecycle support. Passive data capture is restricted at runtime to `/us/en/trips/history` and `/ezpass/dashboard/transactions`. Other open pages are not collected; history-linked detail JSON is fetched separately without navigation.

DOM observation uses `document`, because `documentElement` may not exist at startup. No offscreen document is needed for these visible-tab reads. No declarative network rules are used because the extension does not redirect, block, or rewrite requests.

## Capture behavior

The network hook observes successful fetch/XHR responses whose HTTPS host is in the portal's domain family and whose path resembles trip, reservation, booking, calendar, transaction, toll, activity, or statement data. Authentication, password, token, payment, and profile paths are excluded.

Fetch responses are cloned; the original response remains available to the portal. Fetch capture checks content type and bounded stream size. XHR capture parses text/JSON at completion and handles instance reuse. Unsupported or malformed responses are ignored.

The bridge carries the parsed response payload plus the fixed supported-page path, not its request URL/query string. Requests started outside a supported page cannot contribute after navigation. The isolated collector walks supported objects, extracts allowlisted fields, and keeps normalized records in memory. Full response payloads are not sent to the worker or persisted.

DOM capture is a fallback. Turo requires a stable vehicle ID and both times; display names do not substitute for identity. E-ZPass requires transaction time, plaza, and amount. Network records take precedence over the current DOM snapshot to avoid double-counting two representations. This also means partial/stale network captures can mask additional DOM records.

### History-linked details

`turo_details.js` discovers `a[data-testid="baseTripCard"][href]` and reservation links inside semantic trip-ID containers. Only exact same-origin `/us/en/reservation/<numeric-id>` links qualify; link queries/fragments and embedded credentials are ignored or rejected. Complete captured records for those IDs avoid a GET. Otherwise a three-wide pool builds only `GET /api/reservation/detail?oppTermsAware=true&reservationId=<numeric-id>` requests. The final response URL, query keys, content type, size, JSON syntax, and matching reservation identity are validated. Redirects and arbitrary URLs are rejected.

The verified response adapter prefers `tripStart.epochMillis` and `tripEnd.epochMillis`, with complete `localDate` plus `localTime` pairs as a defensive fallback. `vehicle.id` supplies the Turo identity and `statusCode` participates in cancellation filtering. Only the reduced reservation ID, vehicle ID, start, and end survive parsing; unrelated response fields are not returned to the worker. Cancelled reservations are omitted, and missing or conflicting details fail the batch.

Each collection accumulates discovered IDs to tolerate virtualization. Once linked cards exist, only these reservations are returned; all must resolve before success. History is complete only after cards stabilize, no loader remains, and the terminal footer is visible. Detail jobs start only during `COLLECT_NOW` and are discarded after the last waiter ends. Clear/navigation abort outstanding reads and invalidate late results. Full timestamps and vehicle IDs are required; abbreviated labels and model names are insufficient.

### Turo invoice status

After history collection, the worker opens one temporary inactive Turo tab and closes it in `finally`. The status adapter accepts only exact numeric reservation routes. It deduplicates invoice-detail links rendered for multiple layouts and treats a `Tolls` item inside the verified invoice overview as `already_charged`, regardless of open/resolved/paid/disputed display state. When no toll invoice exists, the exact select-incidental page must expose an enabled `TOLLS` option. Trips within the standard 90-day window then become `eligible_uncharged`; older trips fail closed as `ineligible`; unknown layouts, challenges, and navigation failures become `status_unknown`. Only normalized status, reason, deadline, verification time, and adapter revision are stored.

## Portal SPA lifecycle

1. `COLLECT_NOW` resumes capture and performs an immediate DOM scan.
2. The listener returns literal `true` to keep Chrome's response channel open.
3. The existing observer reacts to inserted nodes, text, and selected hydration attributes.
4. Both collectors throttle scans to 100 ms. Supported network responses also notify pending requests.
5. A nonempty record batch unchanged for 300 ms completes the wait, provided all discovered Turo details have resolved. Route and link discovery are rechecked before replying.
6. At 20 seconds, available records are returned even if the batch never settled, unless Turo details remain unresolved or failed; those conditions return an error and preserve prior results. Otherwise an empty capture returns an actionable timeout error.
7. Deadline and settle timers are cleared when the request finishes. Clearing or navigating cancels pending requests. The observer disconnects on page hide and reattaches on page show, including back/forward restoration.

Skeletons alone do not satisfy the wait. Structural completeness does not imply valid dates; the reconciler performs timestamp validation later. Route changes clear captures and cancel pending waits.

Version 0.4.7 avoids E-ZPass filter controls. After Turo supplies the required coverage, the content script rewinds to page 1, selects 100 rows when available, and follows the visible accessible pager. It requires the unique current page number to advance and rows to stabilize; the portal's transient empty placeholder cannot terminate an in-progress navigation. It stops at disabled Next or a chronology-proven older page. `Lane Txn ID` deduplicates tolls, and any active filter, stalled/repeated page, missing pager, route change, timeout, or cap preserves the prior snapshot.

## Dashboard and fleet state

The popup is a compact launcher and sync status surface. `dashboard.html` is the persistent extension page for reconciliation and fleet configuration. It renders only stored normalized records and sends all writes through the service worker; it does not communicate directly with portal pages.

Fleet assignments associate a Turo internal vehicle ID with an E-ZPass tag or plate over an inclusive local-date interval. The worker retains raw identifiers, derives canonical comparison values, rejects canonically overlapping ranges, rebuilds vehicle cards from Turo labels/plates, and recalculates reconciliation in its serialized state queue. A discovered Turo plate is only a suggestion until the user confirms it. Review shortcuts store an unfinished `uiDrafts` value; they never create an assignment silently.

Schema 4 builds `invoiceDrafts` through the pure `workspace.js` module. Only unique vehicle-confirmed matches enter a trip draft; collection completeness, Turo invoice status, empty toll sets, and sent fingerprints become explicit blockers. Toll/trip selections and integer-cent summaries persist locally. `evidence` and `submissionLedger` remain reserved for later milestones; no capture or submission is available yet.

## Internal message reference

These are internal extension messages, not a public web API.

| Sender -> receiver | Type | Request fields | Response fields |
| --- | --- | --- | --- |
| Popup/dashboard -> worker | `GET_STATE` | None | `ok, state` |
| Popup/dashboard -> worker | `RUN_SYNC` | None | `ok, synced, state, collection` |
| Dashboard -> worker | `UPDATE_SETTINGS` | `settings` | `ok, state` |
| Dashboard -> worker | `SAVE_UI_DRAFT` | `draft` | `ok, state` |
| Dashboard -> worker | `UPSERT_ASSIGNMENT` | `assignment` | `ok, state` |
| Dashboard -> worker | `DELETE_ASSIGNMENT` | `assignmentId` | `ok, state` |
| Dashboard -> worker | `SET_TOLL_SELECTION` | `reservationId, tollId, selected` | `ok, state` |
| Dashboard -> worker | `SET_TRIP_SELECTION` | `reservationId, selected` | `ok, state` |
| Dashboard -> worker | `SELECT_ALL_READY` | `selected` | `ok, state` |
| Dashboard -> worker | `PREPARE_BATCH` | None | Error until evidence adapters are verified |
| Popup/dashboard -> worker | `CLEAR_LOCAL_DATA` | None | `ok, state, resetFailures` |
| Worker -> collector | `COLLECT_NOW` | optional `range` | `ok, source, records, complete, pageCount, terminalReason`, or error |
| Worker -> temporary Turo tab | `COLLECT_INVOICE_STATUS` | None; route supplies identity | Reduced hub/invoice/select-incidental status only |
| Worker -> collector | `CLEAR_CAPTURE` | None | `ok` |
| MAIN -> ISOLATED | `NETWORK_RESPONSE` | `source: "turo-toll-reconciler-page", payload` | No response |

Worker failures use `{ ok: false, error }`. A completed `RUN_SYNC` operation can have `ok: true` with `synced: false`: the operation ran, but source collection failed. Inspect both fields.

Privileged worker operations accept only the exact extension popup or dashboard sender URL, not content-script senders. The dashboard is expected to have `sender.tab` because it is a full extension tab; trust is derived from the Chrome-supplied extension ID and exact extension-page URL, not from the absence of a tab. Collector messages validate extension identity. The page bridge checks origin/source/type, but the host page can forge matching data messages; it is not an authenticated channel.

## State and concurrency

The worker queues popup/dashboard operations to serialize read-modify-write state updates. A sync is ordered: Turo history, Turo status verification, then E-ZPass for the derived range. Exactly one matching data-page tab must exist per source; the worker-managed inactive Turo status tab is temporary.

The worker uses bounded tab messages and a five-minute E-ZPass collection deadline. It rechecks source routes and filters Turo to valid completed intervals. Successful complete source batches are sanitized, reconciled, and saved together in one storage item. A source error preserves the previous snapshot.

Updates to settings or fleet assignments recalculate the current records without changing source refresh times and revalidate draft selections. Schema 4 preserves schema-3 sources and fleet assignments but does not upgrade their completeness or invoice status. Timeout diagnostics contain only DOM-candidate and JSON-response counts. On worker restart, persisted state and selections are rebuilt from canonical records. Pending work is not resumable across arbitrary worker/browser termination; retry sync if interrupted.

## Limits

| Limit | Current value |
| --- | --- |
| Content cache | 5,000 records per map; worker accepts at most 5,000 per batch |
| JSON traversal | 20,000 queued nodes, maximum depth 8 |
| Fetch stream | 2,000,000 bytes |
| History details | 50 discovered IDs per collection, 3 concurrent GETs, 6 seconds per GET, within 20 seconds overall |
| Detail response | 2,000,000-byte JSON limit; root plus explicit response-envelope candidates only |
| JSON text/published serialization | 2,000,000 JavaScript characters |
| Stored scalar strings | At most 250 characters |
| Fleet assignments | 1,000 dated assignments |
| Assignment identifier/value length | At most 100 characters |
| Worker grace validation | 0–120 finite minutes; popup offers 0/15/30/60 |

Oversized network responses are silently ignored. Record/node-cap warnings can be displayed; depth truncation and every other omission are not individually surfaced. XHR JSON is already materialized by the browser before its serialized-size check. These limits reduce workload; they do not establish an overall memory bound or complete ingestion.

Matching scans valid trips per toll: approximately O(tolls × trips). No interval index or background job queue is implemented.
