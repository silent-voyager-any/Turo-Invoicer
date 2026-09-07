# E-ZPass Complete Collection and Matching Fix

Target release: **0.4.7**

## Summary

Live inspection showed that the E-ZPass transaction view can contain dozens of pages. Version 0.4.1 captures only the currently rendered page, so recent tolls can be compared with older Turo trips while the relevant E-ZPass pages are never loaded. Identifier mapping can therefore be correct while every toll still reports that no trip is in range.

Version 0.4.7 collects Turo first, derives the completed-trip coverage range, and reads the existing E-ZPass result pages without touching date filters. It uses the visible `nav[aria-label="pagination navigation"]`, the unique `aria-current` page button, and exact Previous/Next labels. It selects `View: 100` when available. A transient “No transactions found” placeholder during navigation is ignored until the requested page number and stable rows appear.

## Collection contract

The worker sends E-ZPass a bounded request:

```js
{
  type: "COLLECT_NOW",
  range: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" }
}
```

The content script returns normalized records plus proof metadata:

```js
{
  ok: true,
  source: "ezpass",
  records: [],
  complete: true,
  pageCount: 12,
  rawCount: 117,
  completeForRange: true,
  requestedRange: { startDate, endDate },
  observedRange: { startDate, endDate },
  ordering: "descending",
  terminalReason: "older_than_required_range"
}
```

The response also records `lastPage`. The dashboard reports requested and observed ranges, in-range toll count, pages visited, and terminal reason separately.

The collector first rewinds to page 1, optionally changes View to 100, then reads settled pages sequentially. `Lane Txn ID` is the preferred deduplication key. Completion requires disabled Next on the genuine final page or a chronology-proven page older than the requested range. Repeated pages, a missing/nonadvancing pager, active portal filters, route changes, timeouts, or safety-cap exhaustion fail the complete run. A failure never merges partial records into or replaces the previous snapshot.

The collector drives only Previous and Next pagination controls. It checks whether filter fields are nonempty but never retains their values. It does not read or retain passwords, cookies, request headers, account data, or raw responses.

## Matching and review behavior

A toll is attached to a trip only when its timestamp is inside exactly one completed trip interval (plus configured grace) and its complete tag/plate identifier resolves through a confirmed dated vehicle assignment.

Review states are kept separate:

- `identifier_not_mapped`: the complete identifier has no active fleet assignment.
- `conflicting_vehicle_mapping`: active assignments resolve the identifier to multiple vehicles.
- `mapped_vehicle_no_trip`: the vehicle is known but has no completed trip at the toll time; display as **Personal/unassigned**.
- `overlapping_trips`: more than one trip for the resolved vehicle contains the toll time.
- `invalid_timestamp` and `invalid_or_nonpositive_amount`: malformed source data.

The dashboard distinguishes full coverage with records, full coverage with no in-range tolls, and collection that stopped before the trip dates. It may show confirmed tolls under trips while separate eligibility blockers keep batching disabled. Active and future trips remain hidden, and nearest-trip, suffix, partial, or fuzzy matching is never used.

## Verification

- Cover one-page, multi-page, empty, rewind, early-stop, repeated-page, stalled-navigation, missing-control, route-change, timeout, duplicate-ID, and safety-cap cases.
- Verify page 1 has disabled Previous and the final page has disabled Next.
- Verify E-ZPass credits are excluded and toll debits normalize to positive charge magnitudes.
- Verify unmapped, conflicting, personal/unassigned, overlapping, and unique matches remain distinct.
- Verify an incomplete E-ZPass run preserves the prior complete state.
- Run the full automated suite, manifest/static checks, and an authenticated two-tab acceptance sync before release.
