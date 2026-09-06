# Troubleshooting

[Documentation index](README.md)

## First checks

1. Confirm you loaded the directory containing `manifest.json`, not the repository root.
2. Reload the extension and both portal tabs after a source update.
3. Keep exactly one matching tab for each source open and signed in.
4. Open `/us/en/trips/history` and `/ezpass/dashboard/transactions`, not landing pages or upcoming trips.
5. Load the intended date range/pages before syncing.
6. Read the status and last-sync timestamp. Failed refreshes deliberately show prior results.

## Symptoms and remedies

| Message or symptom | Explanation and next step |
| --- | --- |
| Open a signed-in portal tab | No tab matched that source's permitted origins. Open the canonical portal and navigate to its data page. |
| Keep exactly one portal tab open | Multiple matching tabs were found. Close duplicates, including other pages on the same permitted origin. |
| No supported records captured | Collector returned no usable records. Let E-ZPass activity load, then retry. If data is visible, the adapter may not recognize its schema. |
| Timed out after 20 seconds waiting for complete Turo trips | No supported trip contained a vehicle ID and both time fields during the wait. Check login, history page, data range, and selectors. |
| Portal tab timed out | No reply arrived before the worker deadline. Keep the tab open; reload extension and tab, then retry. |
| Receiving end does not exist / connection error | Content script may not be installed in an old tab, or the page navigated. Reload that tab after loading the extension. |
| Portal navigated away | Pending collection was canceled. Wait on the intended page and sync again. |
| Not refreshed; displaying prior results | At least one source failed. Neither new source snapshot was committed. Resolve the named source error. |
| Invalid/ambiguous timestamp | Check the original format, date-only rows, and DST hour. Do not substitute posting date or invent an offset. |
| No trip in range | Check missing history, time zone, grace, and exact vehicle mapping. Time overlap alone does not establish identity. |
| Capture limit reached | Narrow the date range, clear captures, reload, and compare counts again. |
| Conflicting duplicate IDs | Worker saw the same identifier with different content. Clear/reload and verify stable IDs in the adapter. |
| Mappings conflict | Tag and plate resolve to different vehicles. Correct mappings and consider historical tag transfers. |
| Time matches, identifier is not mapped | Use **Map to this vehicle**, verify the prefilled tag/plate and effective dates, then save the assignment. |
| Storage quota or persistence error | Do not assume the sync saved. Narrow the range and consider clearing existing data after preserving anything needed. |

A genuine empty trip/activity range currently cannot be committed as a successful two-source sync: nonempty records are required. Do not interpret this safeguard as proof of scraper failure.

## Why the SPA fix may not solve every empty result

The original collector observed mutations but answered `COLLECT_NOW` immediately. It now keeps the response channel open, waits on DOM/network updates, and uses a 300 ms stable-record window. Both collectors now wait up to 20 seconds, with a 25-second worker allowance. Timeout diagnostics report DOM candidates and supported-path JSON response counts. Zero candidates can indicate an unrecognized container; candidates without records indicate missing or unsupported fields. These counts do not prove completeness.

Waiting cannot create unavailable fields. A visible skeleton is not a trip record; a vehicle display name is not a Turo vehicle ID. Unsupported natural-language timestamps, changed private JSON keys, generic GraphQL endpoints outside the URL filter, and unrecognized DOM containers still need adapter work.

### History cards found, but no complete records

Version 0.4.0 recognizes `baseTripCard` links such as `/us/en/reservation/900001`. A short date label (for example, `Aug 27 - Aug 30`) lacks the year and clocks. Sync derives a fixed same-origin reservation-detail JSON request from each numeric link to obtain these fields instead of extending the wait or guessing values.

- **No supported full timestamps and vehicle ID:** Turo's JSON schema did not contain the required reservation ID, trip boundaries, and vehicle ID. The response shape may need an adapter update; never share an unredacted response.
- **Malformed/non-JSON, blocked, redirected, or HTTP error:** open Turo and verify your session normally. No challenge bypass or automatic redirect following is attempted.
- **Details incomplete / more than 50 reservations:** reload history and load fewer cards, then retry. There are at most three simultaneous reads, each limited to six seconds, within the existing 20-second sync deadline.

Failure preserves the previous snapshot. Automated tests use a redacted synthetic copy of the authenticated response shape; continued live compatibility is not guaranteed by passing those tests.

Network records take precedence over DOM records. Stale partial network capture may therefore produce surprising counts. Clear captures and reload before a new account/range workflow. The extension does not verify completeness or load missing pages.

## E-ZPass filters and manual tags

Version 0.4.4 derives the E-ZPass Transaction Date range from completed Turo trips, enters `MM/DD/YY` dates through the portal's masked-input event flow, and walks every page until Next is disabled. Keep the E-ZPass transaction tab open and do not change its filters during sync. Exit times with fractional seconds are supported and negative toll-posting debits become positive charge amounts. Credits, payments, replenishments, deposits, refunds, balance adjustments, posting-only rows, and rows without a complete toll time are ignored.

If the collector reports that E-ZPass left the transactions page, confirm the tab was not navigated during sync. Version 0.4.4 finds Search by walking from the two visible date inputs through the transaction main region, with no fixed DOM nesting limit and no assumption that their field-label text shares the same wrapper. It supports button and input-based Search controls while excluding the portal header. If date validation keeps Search disabled, sanitized diagnostics report only control type, expected format, acceptance/validity flags, and the disabled mechanism. It also detects tabs that retained an older injected script and tells you to reload the E-ZPass tab.

### Trips are visible but disabled

E-ZPass is complete only when every requested chunk reaches an empty result or a disabled Next control. Turo history pagination and toll-invoice status remain unverified. Confirmed toll matches still appear beneath trips; those independent blockers prevent selection, not display.

The number after “Turo internal vehicle ID” is Turo's internal car reference, not an E-ZPass tag. Use the discovered vehicle card to confirm its plate and add its complete tag values. Identifier formatting is normalized safely, but leading zeros are not interchangeable.

If rows remain unsupported, provide only the page path, column headings, and numeric diagnostic counts—never account IDs, cookies, tokens, or raw exports. Open the **Fleet dashboard** and add a dated tag or plate assignment for each car; Turo is not assumed to provide E-ZPass tags.

## Local debugging

On `chrome://extensions`, inspect extension errors and open the service-worker inspector. Inspect the portal DOM locally to locate card boundaries, stable IDs, and full timestamp fields. Inspect the popup to diagnose rendering errors.

Separate the problem into: tab detection -> script presence -> raw capture -> adapter fields -> async reply -> normalization -> matching. Do not log or share complete response payloads to shortcut that process.

The worker's persisted state can contain private travel data. Avoid screenshots or console dumps of whole state objects in public reports.

## Useful issue report

Include extension version/commit, Chrome version, operating system, redacted page path (no query tokens), source, exact error text, reload steps, whether cards are visible, and expected versus actual record counts.

Attach synthetic or thoroughly redacted data only. For timing bugs, include whether records arrive by DOM mutation, attribute hydration, or delayed network response. For matching bugs, include synthetic timestamps with explicit offsets and consistent fake vehicle IDs.

For implementation changes, follow the [development guide](DEVELOPMENT.md).
