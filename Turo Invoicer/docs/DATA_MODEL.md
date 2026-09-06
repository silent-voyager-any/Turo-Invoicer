# Data model and reconciliation reference

[Documentation index](README.md)

## Canonical collector records

Examples are synthetic. A source adapter must translate its verified schema into these fields; arbitrary nested objects and extra private fields are discarded.

```json
{
  "id": "tx-1",
  "timestamp": "2026-09-04T12:30:00-04:00",
  "plaza": "Example plaza",
  "amount": "15.00",
  "tagId": "0012345678",
  "plate": "NY:EXAMPLE",
  "tagOrPlate": null,
  "vehicleId": null
}
```

Toll `amount` is USD major units, not cents. Convert a verified integer-cent API field in its adapter; do not guess units. E-ZPass displays toll postings as negative account debits; normalization converts verified toll postings to a positive charge magnitude after the adapter removes credits and other non-toll activity. The E-ZPass adapter deliberately emits no Turo `vehicleId`, because agency IDs use a different namespace. Optional `tagOrPlate` preserves a mixed-column identifier without guessing its type. Explicit mappings in either namespace can resolve it; conflicts require review.

```json
{
  "id": "trip-1",
  "vehicleId": "12345",
  "start": "2026-09-04T09:00:00-04:00",
  "end": "2026-09-04T18:00:00-04:00"
}
```

Stable source IDs are preferred. Content caches key records by source ID, or by serialized record when no ID exists. Repeated IDs update a cached record; cancellations remove captured Turo records only when a stable ID is available. Identical-looking transactions without source IDs can collapse. Distinct logical records must not reuse IDs.

## Settings

```json
{
  "timeZone": "America/New_York",
  "graceMinutes": 0,
  "vehicleByTag": { "0012345678": "12345" },
  "vehicleByPlate": { "NY:EXAMPLE": "12345" }
}
```

The popup JSON uses `tags` and `plates`; popup code maps these to `vehicleByTag` and `vehicleByPlate`. Settings are merged with existing settings by the worker. Mapping values are trimmed, but keys are not normalized. Matching is case-sensitive. The popup has no time-zone picker, though the worker contract validates an IANA zone setting.

## Pure API

From the extension directory:

```js
import { reconcileTolls } from "./reconciler.js";

const result = reconcileTolls(
  [{ id: "tx-1", timestamp: "2026-09-04 12:30",
     plaza: "Example plaza", amount: 15, tagId: "0012345678" }],
  [{ id: "trip-1", vehicleId: "12345",
     start: "2026-09-04 09:00", end: "2026-09-04 18:00" }],
  { timeZone: "America/New_York", graceMinutes: 0,
    vehicleByTag: { "0012345678": "12345" } }
);

console.log(result.stats.matchedCount); // 1
console.log(result.matched[0].vehicleConfirmed); // true
```

Exports: `DEFAULT_TIME_ZONE`, `toEpochMs`, `normalizeAmount`, `normalizeToll`, `normalizeTrip`, `selectCompletedTrips`, and `reconcileTolls`. The module has no Chrome dependencies and does not mutate inputs. Direct callers should supply arrays of validated canonical records; worker validation is not automatically applied to arbitrary library calls.

## Time normalization

- ISO date/time with `Z` or numeric offset preserves the instant.
- Zone-less numeric ISO-like and US date/time strings use the configured zone, not the machine zone. Seconds may include one to three fractional digits.
- Numeric epochs with absolute value below 100,000,000,000 are interpreted as seconds; larger values are milliseconds. Numeric strings must contain exactly 10 or 13 digits. Prefer explicit ISO offsets for adapters.
- US two-digit years use 1970–1999 for 70–99 and 2000–2069 for 00–69; four-digit years are preferable.
- Date-only values, unsupported month-name strings, invalid calendars, and invalid times return `null`.
- A local time in a repeated DST hour or nonexistent spring-forward hour returns `null`; an explicit offset can disambiguate the repeated hour.

The normalized toll adds `timestampMs`, numeric `amount`, and rounded `amountCents`. A normalized trip adds `startMs` and `endMs`. Missing IDs receive deterministic content-derived fallback IDs, not externally verified transaction identities.

## Completed-history filter

The worker first calls `selectCompletedTrips(trips, { timeZone, nowMs })`, returning `{ completed, excludedCount }`. Only valid intervals ending at or before `nowMs` qualify; the default is current time. Future, in-progress, and invalid trips are excluded. The standalone `reconcileTolls` remains general-purpose; external callers must apply this filter to adopt the history policy.

## Matching algorithm

For each toll:

1. Reject an invalid timestamp or nonpositive/invalid amount into review.
2. Resolve vehicle identity from direct canonical `vehicleId`, tag mapping, and plate mapping.
3. If multiple supplied identities disagree, report a mapping conflict.
4. Select valid loaded trips whose intervals contain the toll, including grace on both ends; if identity is known, require the same vehicle ID.
5. One candidate becomes a suggestion; multiple candidates are ambiguous; zero candidates are unmatched.

Trip intervals are inclusive:

```text
start - grace <= toll timestamp <= end + grace
```

At a shared endpoint, adjacent trips can both qualify. A unique time-only suggestion has `vehicleConfirmed: false`. `withinGrace: true` means the toll lies outside the unexpanded interval. Neither flag verifies charge eligibility.

## Result

| Field | Meaning |
| --- | --- |
| `matched` | Entries containing normalized `toll`, `trip`, `vehicleConfirmed`, `withinGrace` |
| `ambiguous` | `toll`, candidate trips, `reason: "overlapping_trips"` |
| `unmatchedTolls` | `toll` plus reason |
| `unmatchedTrips` | Valid trips without a uniquely assigned toll |
| `invalidTrips` | Trips excluded for invalid intervals or missing recognized vehicle identity |
| `stats` | Toll/trip totals and matched, ambiguous, unmatched-toll counts |
| `options` | Effective time zone and grace minutes |

Unmatched reason codes: `invalid_timestamp`, `invalid_or_nonpositive_amount`, `conflicting_vehicle_mapping`, and `no_trip_in_time_range`. The last also covers an interval that would match in time but fails vehicle filtering.

## Stored state

Storage area: `chrome.storage.local`. Key: `turoTollReconcilerState`.

```json
{
  "version": 2,
  "sources": {
    "turo": { "records": [], "updatedAt": null },
    "ezpass": { "records": [], "updatedAt": null }
  },
  "settings": {
    "timeZone": "America/New_York",
    "graceMinutes": 0,
    "vehicleByTag": {},
    "vehicleByPlate": {}
  },
  "reconciliation": null,
  "lastSync": null
}
```

Successful sync replaces the records/results and sets ISO refresh timestamps. Settings updates recalculate results but retain `lastSync`. Version-1 snapshots are retired rather than reused for history matching; valid manual mappings and supported grace settings are retained. Unknown versions fall back to an empty state. Clearing removes this key and resets settings as well as data.
