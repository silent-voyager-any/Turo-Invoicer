# E-ZPass Complete Collection and Matching Fix

Target release: **0.4.2**

## Summary

Live inspection showed that the E-ZPass transaction view can contain dozens of pages. Version 0.4.1 captures only the currently rendered page, so recent tolls can be compared with older Turo trips while the relevant E-ZPass pages are never loaded. Identifier mapping can therefore be correct while every toll still reports that no trip is in range.

Version 0.4.2 collects Turo first, derives the required Transaction Date range from completed trips, applies that range through the signed-in E-ZPass page, and walks every result page. Collection is complete only after the portal exposes a disabled Next control (or explicitly reports an empty range).

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
  chunkCount: 3,
  range: { startDate, endDate },
  terminalReason: "next_disabled"
}
```

Large ranges are divided into inclusive 14-day chunks. Each chunk starts at page 1, rows are collected only after the table settles, and `Lane Txn ID` is the preferred deduplication key. Repeated pages, a missing/nonadvancing pager, route changes, timeouts, or safety-cap exhaustion fail the complete run. A failure never merges partial records into or replaces the previous snapshot.

The collector drives only the visible Transaction Date, Start Date, End Date, Search, and pagination controls. It does not read or retain passwords, cookies, request headers, account data, or raw responses.

The portal also exposes unrelated header Search buttons. The transaction Search lookup therefore starts at the shared ancestor of the two visible date inputs and walks through the transaction main region without a fixed nesting-depth limit. It never crosses into the header. Because the portal can render field labels in sibling component trees, the lookup does not require label text on that shared ancestor. It requires exactly one visible, enabled Search button (including an input-based submit control) in the candidate region; missing or ambiguous controls fail before any navigation.

## Matching and review behavior

A toll is attached to a trip only when its timestamp is inside exactly one completed trip interval (plus configured grace) and its complete tag/plate identifier resolves through a confirmed dated vehicle assignment.

Review states are kept separate:

- `identifier_not_mapped`: the complete identifier has no active fleet assignment.
- `conflicting_vehicle_mapping`: active assignments resolve the identifier to multiple vehicles.
- `mapped_vehicle_no_trip`: the vehicle is known but has no completed trip at the toll time; display as **Personal/unassigned**.
- `overlapping_trips`: more than one trip for the resolved vehicle contains the toll time.
- `invalid_timestamp` and `invalid_or_nonpositive_amount`: malformed source data.

The dashboard displays both collection ranges and warns when they do not overlap. It may show confirmed tolls under trips while separate invoice-status or Turo-completeness blockers keep batching disabled. Active and future trips remain hidden, and nearest-trip, suffix, partial, or fuzzy matching is never used.

## Verification

- Cover one-page, multi-page, empty, chunked, repeated-page, stalled-navigation, missing-control, route-change, timeout, duplicate-ID, and safety-cap cases.
- Verify page 1 has disabled Previous and the final page has disabled Next.
- Verify E-ZPass credits are excluded and toll debits normalize to positive charge magnitudes.
- Verify unmapped, conflicting, personal/unassigned, overlapping, and unique matches remain distinct.
- Verify an incomplete E-ZPass run preserves the prior complete state.
- Run the full automated suite, manifest/static checks, and an authenticated two-tab acceptance sync before release.
