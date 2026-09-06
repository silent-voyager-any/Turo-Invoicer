# User guide

[Documentation index](README.md)

## Installation and updates

Requirements: Chrome 111+ on a desktop, access to your own Turo host account and E-ZPass NY account, and the extension source. Node.js is needed only for developer checks.

1. Download and extract the repository, or clone it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `Turo Invoicer` directory containing `manifest.json`.
4. Sign into the portals normally. The extension has no password form.
5. Reload portal tabs after installation so the early network hook and isolated content scripts are present.

For an update, replace/update the source, click **Reload** on the extension card, then reload both portal tabs. Reloading only the extension does not install new content scripts into already-loaded pages.

## Prepare a reconciliation

Keep exactly one matching tab per source open:

- Turo: `https://turo.com/us/en/trips/history`.
- E-ZPass NY: `https://www.e-zpassny.com/ezpass/dashboard/transactions`.

Do not leave duplicate matching history/transactions tabs open. Other Turo pages are ignored. Select the intended date range and load the necessary pages within each portal. The extension does not navigate, scroll, paginate, solve challenges, or sign in for you.

Use toll passage/transaction time, not posting date. Check which vehicles and reservations are actually represented. Clear data and reload before changing accounts or beginning a different date-range capture workflow: tab-memory network records can accumulate during navigation.

## Sync

Open the extension, choose **Open fleet dashboard**, and click **Sync portal tabs**. The dashboard is a persistent extension tab, so it remains open while you switch to Turo or E-ZPass.

Turo waits for records containing a vehicle ID and both trip times, up to 20 seconds. A brief settling window groups nearby render updates. An incoming supported network response can also complete collection. E-ZPass also waits up to 20 seconds for supported activity rows or responses. Use its date, plate, and tag filters before syncing.

During sync, history cards with numeric reservation links can trigger read-only requests to Turo's same-origin reservation-detail JSON endpoint. Your history tab stays in place. Up to 50 discovered reservations are supported, with three requests at once and a six-second limit per read, inside the total 20-second collection deadline. Every discovered reservation must resolve; failed or incomplete reads do not replace prior results. Keep history open and avoid changing its range during sync. If the range is too large, reload and load fewer cards before retrying.

Short labels such as `Aug 27 - Aug 30` do not supply a year or exact clocks. The extension only uses full detail timestamps and stable vehicle IDs. It prefers the endpoint's absolute epoch boundaries and uses complete local date/time pairs only as a fallback. Invalid JSON or an unsupported schema produces an actionable error instead of guessed dates. The extension does not inspect credentials or bypass sign-in/challenge pages.

Both sources must return nonempty supported data. On success, the worker replaces the saved two-source snapshot and recalculates suggestions. On failure, it leaves the prior saved snapshot unchanged. Check the status message and last-sync timestamp; old results are not evidence of a successful refresh.

A successful sync means supported loaded records were collected—not that every relevant transaction or reservation was captured.

## Fleet assignments

In the dashboard, enter a Turo vehicle ID, optional host-facing label, identifier type, and exact E-ZPass tag or plate. Add inclusive effective dates when a tag or plate changes vehicles; leave a boundary empty for an open-ended range. Leading zeros are preserved. Overlapping date ranges for the same identifier are rejected.

Turo is not assumed to provide E-ZPass tag numbers. Copy them from your own E-ZPass records. The vehicle value must be the exact Turo vehicle ID, not a vehicle name or E-ZPass internal vehicle ID. The identifier must match the captured tag or plate exactly, including leading zeros, case, and state formatting when supplied.

Click **Save assignment** to persist it and recalculate the existing snapshot without reloading the portals. A combined Tag/Plate value is resolved through dated assignments only when the resulting vehicle is unique.

Create separate non-overlapping dated assignments when a tag belonged to different vehicles. Conflicting tag and plate identities are sent for review rather than prioritized silently.

## Interpret results

| Dashboard result | Meaning | Your next action |
| --- | --- | --- |
| Match suggestion | Exactly one loaded trip qualifies | Verify toll, trip, and completeness manually |
| Confirm vehicle | Match used time only, without resolved vehicle identity | Establish the correct tag/plate mapping |
| Grace period | Toll is outside the exact trip but inside the expanded interval | Verify why it should belong to this trip |
| Overlaps multiple trips | Several trips qualify | Resolve identity or inspect trip boundaries |
| No trip in range | No loaded trip qualifies, possibly after vehicle filtering | Check missing trips, times, mapping, and date range |
| Timestamp/amount review | Data could not be safely used | Inspect original source fields |
| Mappings conflict | Tag, plate, or supplied identity disagree | Correct the mappings |

The grace selector offers 0, 15, 30, or 60 minutes. It expands both ends of each trip; it is a matching convenience, not a statement of reimbursement policy.

Invalid trip timestamps are excluded from matching. The sync status can report their count. Invalid trips and trips without an assigned toll are available in the stored result but do not have dedicated popup lists.

## Clear local data

**Clear local data** removes the saved records, results, settings, and mappings. It also requests that reachable portal captures clear memory and pause. If some tabs cannot be reached, reload them.

This action does not delete portal records or browser cookies. A later explicit sync may recapture visible data. There is no automatic retention expiry or undo for cleared extension data; source portal data remains available.

## History-only policy and upgrade

Version 0.3.1 fixes dashboard communication when the dashboard is open as a normal Chrome tab and retains the schema-3 migration introduced in 0.3.0. Turo collection remains history-only and excludes future, in-progress, and invalid intervals. E-ZPass toll postings accept fractional-second exit times, while credits and other non-toll activity are ignored. Reload the extension and both tabs after upgrading.

## Before relying on a suggestion

Compare counts, amounts, passage times, and trip boundaries with the original portals. Confirm vehicle identity and inspect overlapping/end-point trips. Keep your own appropriate records outside this extension. Nothing in the popup submits a claim or proves eligibility.

See [troubleshooting](TROUBLESHOOTING.md) for errors and [security](SECURITY.md) for storage details.
