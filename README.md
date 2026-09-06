# Turo Invoicer

A local-first Chrome extension that helps Turo hosts reconcile NY E-ZPass toll activity with trip schedules.

The extension observes data loaded in your signed-in browser tabs, matches toll timestamps to trip intervals, and presents suggestions for review. It does not require a server, store portal passwords, or submit reimbursement claims.

> **Status: development scaffold, version 0.2.3.** Automated tests cover matching, extraction adapters, messaging, and SPA waiting. The current Turo and E-ZPass response shapes have been exercised in an authenticated two-tab sync, but portal completeness and future schema compatibility are not guaranteed. Do not treat suggestions as verified billing evidence.

## Features

- Manifest V3 service worker with narrowly scoped HTTPS host permissions.
- Local fetch/XHR response observation and defensive DOM fallbacks.
- History-only Turo collection excludes upcoming and in-progress trips.
- Both portal collectors wait up to 20 seconds for usable records.
- E-ZPass toll-posting capture, credit filtering, table/grid fallbacks, and manual per-vehicle tag entry.
- America/New_York time normalization, including daylight-saving ambiguity detection.
- Inclusive trip-window matching with optional grace periods.
- Tag/plate-to-Turo-vehicle mappings and explicit overlap/conflict review.
- Local snapshots, atomic two-source sync, and a clear-data control.
- No backend uploads, analytics, remote scripts, or automatic claim submission.

## Version 0.2.3 update

E-ZPass transaction responses can provide separate exit dates and 24-hour exit times containing milliseconds. Version 0.2.3 recognizes those fields, ignores credits and other non-toll account activity, and converts negative account debits to positive toll-charge amounts for reconciliation. The authenticated two-tab check captured five genuine toll postings from a visible ten-row mix without producing invalid-timestamp results. No private live values are included in the repository.

The version 0.2.2 Turo behavior remains in place:

History cards such as `baseTripCard` can show only month/day dates and a vehicle name. During explicit sync, the extension now converts those numeric reservation links into narrowly allowlisted, same-origin JSON detail requests. It reads the endpoint's epoch trip boundaries and stable vehicle ID, never guessing a year, time, or ID from the card label. Reads are bounded and cancelled on navigation; malformed, redirected, oversized, signed-out, and unsupported responses preserve prior results. No new permissions are needed.

Sync starts only from `https://turo.com/us/en/trips/history` and `https://www.e-zpassny.com/ezpass/dashboard/transactions`; only history-linked Turo details may be read additionally. Use the E-ZPass portal's date, plate, and tag filters yourself. The popup provides manual vehicle-ID/tag/plate entry; Turo is not assumed to expose transponder numbers. Old pre-history snapshots are retired while valid vehicle mappings are retained. Reload the extension and both tabs after updating.

## Quick start

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome 111 or newer.
3. Enable **Developer mode**, select **Load unpacked**, and choose the **`Turo Invoicer` subfolder** containing `manifest.json`—not the repository root.
4. Keep exactly one Turo tab and one NY E-ZPass tab open. Sign in through the portals normally.
5. Reload both portal tabs after installing or updating the extension. Open Turo's trip-history page and the E-ZPass dashboard transactions page.
6. Load the required date ranges/pages, open the extension, and select **Sync open tabs**.
7. Review suggestions, configure vehicle mappings, and manually verify timestamps, amounts, identity, and source completeness before any billing action.

See the [user guide](Turo%20Invoicer/docs/USER_GUIDE.md) for the full workflow.

## Development

No dependency installation or build is required for the current extension. Tests require Node.js 20+ and npm.

```sh
git clone https://github.com/silent-voyager-any/Turo-Invoicer.git
cd Turo-Invoicer
cd "Turo Invoicer"
npm test
npm run check
```

The current suite contains 70 tests. Checks cover manifest references, the intended permissions, and JavaScript syntax. Tests use synthetic data and mocked Chrome/DOM interfaces; the separate authenticated smoke check is intentionally not committed as account data.

## Documentation

| Guide | Contents |
| --- | --- |
| [Documentation index](Turo%20Invoicer/docs/README.md) | Reading paths and source map |
| [User guide](Turo%20Invoicer/docs/USER_GUIDE.md) | Installation, sync, mappings, results, clearing data |
| [Architecture](Turo%20Invoicer/docs/ARCHITECTURE.md) | Execution contexts, SPA waiting, messages, limits |
| [Data and matching reference](Turo%20Invoicer/docs/DATA_MODEL.md) | Schemas, settings, interval rules, time zones |
| [Security and privacy](Turo%20Invoicer/docs/SECURITY.md) | Permissions, trust boundaries, retention, limitations |
| [Development and release](Turo%20Invoicer/docs/DEVELOPMENT.md) | Adapter work, tests, manual QA, release checklist |
| [Troubleshooting](Turo%20Invoicer/docs/TROUBLESHOOTING.md) | Errors, diagnosis, safe issue reports |

## Repository layout

```text
README.md                   Project overview
LICENSE                     MIT license
Turo Invoicer/              Load this folder as the extension
  manifest.json
  background.js
  content_common.js
  content_turo.js
  turo_details.js
  content_ezpass.js
  network_hook.js
  reconciler.js
  popup.html / popup.js / popup.css
  package.json
  scripts/check.mjs
  tests/
  docs/
```

## Important limitations

Only loaded records are captured; pagination, statement totals, account ownership, and history completeness are not verified. Private portal schemas may change. Network capture takes precedence over DOM capture, and missing stable IDs can collapse identical-looking transactions. Clear captures and reload before switching accounts or date-range workflows.

A timestamp-only suggestion does not establish vehicle identity. Static mappings cannot safely represent a transponder moved between vehicles over time. The project is not an official integration with Turo or E-ZPass and makes no guarantee about portal access or anti-bot behavior.

## Contributing and license

Read the [development guide](Turo%20Invoicer/docs/DEVELOPMENT.md) before changing adapters or permissions. Use synthetic or thoroughly redacted fixtures; never commit credentials, account exports, or guest information.

Licensed under the [MIT License](LICENSE). Preserve the existing copyright and license notices.
