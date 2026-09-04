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
Popup -- RUN_SYNC --> service worker -- COLLECT_NOW --> each source tab
Popup <-- results --- service worker <-- records ------- each source tab
                            |
                     reconciler.js
                            |
                     chrome.storage.local
```

The portal owns authentication and requests. The worker does not recreate authenticated HTTP calls or move credentials across domains. Cross-domain orchestration here means asking the two tab-local collectors for records.

## Manifest and loading

The worker is an ES module. Static content scripts start at `document_start`. The network hook runs in MAIN; the common collector and the source adapter run in ISOLATED, in that order. The manifest targets top-level pages on the three declared origins for SPA lifecycle support. Data capture is restricted at runtime to `/us/en/trips/history` and `/ezpass/dashboard/transactions`; other pages do not contribute response bodies or DOM records.

DOM observation uses `document`, because `documentElement` may not exist at startup. No offscreen document is needed for these visible-tab reads. No declarative network rules are used because the extension does not redirect, block, or rewrite requests.

## Capture behavior

The network hook observes successful fetch/XHR responses whose HTTPS host is in the portal's domain family and whose path resembles trip, reservation, booking, calendar, transaction, toll, activity, or statement data. Authentication, password, token, payment, and profile paths are excluded.

Fetch responses are cloned; the original response remains available to the portal. Fetch capture checks content type and bounded stream size. XHR capture parses text/JSON at completion and handles instance reuse. Unsupported or malformed responses are ignored.

The bridge carries the parsed response payload plus the fixed supported-page path, not its request URL/query string. Requests started outside a supported page cannot contribute after navigation. The isolated collector walks supported objects, extracts allowlisted fields, and keeps normalized records in memory. Full response payloads are not sent to the worker or persisted.

DOM capture is a fallback. Turo requires a stable vehicle ID and both times; display names do not substitute for identity. E-ZPass requires transaction time, plaza, and amount. Network records take precedence over the current DOM snapshot to avoid double-counting two representations. This also means partial/stale network captures can mask additional DOM records.

## Portal SPA lifecycle

1. `COLLECT_NOW` resumes capture and performs an immediate DOM scan.
2. The listener returns literal `true` to keep Chrome's response channel open.
3. The existing observer reacts to inserted nodes, text, and selected hydration attributes.
4. Both collectors throttle scans to 100 ms. Supported network responses also notify pending requests.
5. A nonempty record batch unchanged for 300 ms completes the wait.
6. At 20 seconds, available records are returned even if the batch never settled; otherwise an actionable timeout error is returned.
7. Deadline and settle timers are cleared when the request finishes. Clearing or navigating cancels pending requests. The observer disconnects on page hide and reattaches on page show, including back/forward restoration.

Skeletons alone do not satisfy the wait. Structural completeness does not imply valid dates; the reconciler performs timestamp validation later. Settling does not prove complete pagination. E-ZPass uses the same delayed collection. Route changes clear captures and cancel pending waits.

## Internal message reference

These are internal extension messages, not a public web API.

| Sender -> receiver | Type | Request fields | Response fields |
| --- | --- | --- | --- |
| Popup -> worker | `GET_STATE` | None | `ok, state` |
| Popup -> worker | `RUN_SYNC` | None | `ok, synced, state, collection` |
| Popup -> worker | `UPDATE_SETTINGS` | `settings` | `ok, state` |
| Popup -> worker | `CLEAR_LOCAL_DATA` | None | `ok, state, resetFailures` |
| Worker -> collector | `COLLECT_NOW` | None | `ok, source, records, pagePath, warning`, or error |
| Worker -> collector | `CLEAR_CAPTURE` | None | `ok` |
| MAIN -> ISOLATED | `NETWORK_RESPONSE` | `source: "turo-toll-reconciler-page", payload` | No response |

Worker failures use `{ ok: false, error }`. A completed `RUN_SYNC` operation can have `ok: true` with `synced: false`: the operation ran, but source collection failed. Inspect both fields.

Privileged worker operations accept only the extension popup sender, not content-script senders. Collector messages validate extension identity. The page bridge checks origin/source/type, but the host page can forge matching data messages; it is not an authenticated channel.

## State and concurrency

The worker queues popup operations to serialize read-modify-write state updates. Within one sync, the two tab requests run concurrently. Exactly one matching data-page tab must exist per source; other pages are ignored.

The worker allows 25 seconds for either source collection; ordinary tab operations retain 5 seconds. It rechecks the page after collection and filters Turo to valid completed intervals. Both successful nonempty source batches are sanitized, reconciled, and saved together in one storage item. A source error preserves the previous snapshot. This is not a cross-portal transactional snapshot or a completeness guarantee.

Updates to settings recalculate the current records without changing the source refresh times. Schema 2 retires pre-history snapshots while retaining valid legacy vehicle mappings. Timeout diagnostics contain only DOM-candidate and JSON-response counts. On worker restart, persisted state is reloaded. Pending work is not resumable across arbitrary worker/browser termination; retry sync if interrupted.

## Limits

| Limit | Current value |
| --- | --- |
| Content cache | 5,000 records per map; worker accepts at most 5,000 per batch |
| JSON traversal | 20,000 queued nodes, maximum depth 8 |
| Fetch stream | 2,000,000 bytes |
| JSON text/published serialization | 2,000,000 JavaScript characters |
| Stored scalar strings | At most 250 characters |
| Mapping entries | 500 per tag map and per plate map |
| Mapping key/value length | At most 100 characters |
| Worker grace validation | 0–120 finite minutes; popup offers 0/15/30/60 |

Oversized network responses are silently ignored. Record/node-cap warnings can be displayed; depth truncation and every other omission are not individually surfaced. XHR JSON is already materialized by the browser before its serialized-size check. These limits reduce workload; they do not establish an overall memory bound or complete ingestion.

Matching scans valid trips per toll: approximately O(tolls × trips). No interval index or background job queue is implemented.
