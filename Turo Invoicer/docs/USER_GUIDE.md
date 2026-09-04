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

Open the extension and click **Sync open tabs**.

Turo waits for records containing a vehicle ID and both trip times, up to 20 seconds. A brief settling window groups nearby render updates. An incoming supported network response can also complete collection. E-ZPass also waits up to 20 seconds for supported activity rows or responses. Use its date, plate, and tag filters before syncing.

Both sources must return nonempty supported data. On success, the worker replaces the saved two-source snapshot and recalculates suggestions. On failure, it leaves the prior saved snapshot unchanged. Check the status message and last-sync timestamp; old results are not evidence of a successful refresh.

A successful sync means supported loaded records were collected—not that every relevant transaction or reservation was captured.

## Vehicle mappings

Open **Vehicle mappings**, enter the Turo vehicle ID (from its listing URL), then enter the E-ZPass tag number and/or plate. Click **Save vehicle mapping**. Leading zeros are preserved. Captured vehicle IDs appear as suggestions; before a successful sync you can enter the ID manually. Saving an existing tag/plate updates its assigned vehicle; use **Advanced JSON mappings** to remove entries or edit in bulk.

Turo is not assumed to provide E-ZPass tag numbers. Copy them from your own E-ZPass records. The alternative advanced JSON format is:

```json
{
  "tags": { "0012345678": "12345" },
  "plates": { "NY:ABC1234": "12345" }
}
```

The values must be exact Turo vehicle IDs, not vehicle names or E-ZPass internal vehicle IDs. Keys must match captured tags or plates exactly, including leading zeros, case, and state formatting when supplied. Leave a section as an empty object if unused.

Click **Save mappings** to persist mappings and recalculate the existing snapshot without reloading the portals. Each mapping object supports up to 500 entries. A combined Tag/Plate column is preserved as an untyped identifier and resolved only through your explicit tag/plate mappings.

Do not apply one static tag mapping across periods when that tag belonged to different vehicles. Historical assignments are not supported. Conflicting tag and plate mappings are sent for review rather than prioritized silently.

## Interpret results

| Popup result | Meaning | Your next action |
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

Version 0.2.0 collects Turo data only on trip history. The worker additionally excludes trips whose end time is in the future, along with invalid intervals; this also excludes in-progress trips. Prefetched upcoming trips cannot qualify through grace periods. Reload the extension and both tabs after upgrading. Old version-1 snapshots are not shown, while valid manual mappings are retained for the next sync.

## Before relying on a suggestion

Compare counts, amounts, passage times, and trip boundaries with the original portals. Confirm vehicle identity and inspect overlapping/end-point trips. Keep your own appropriate records outside this extension. Nothing in the popup submits a claim or proves eligibility.

See [troubleshooting](TROUBLESHOOTING.md) for errors and [security](SECURITY.md) for storage details.
