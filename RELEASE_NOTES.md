# v0.5.14-beta.1 — complete E-ZPass results and Batch management

This beta preserves existing synchronized trips, tolls, vehicle mappings, evidence, and sync timestamps. Installing or reloading it does not start a sync. After updating, reload both portal tabs and run **Find uncharged trips** to recalculate any trip affected by tolls previously hidden on later E-ZPass pages; refresh its evidence and approval before use.

## Changes

- Filtered E-ZPass searches re-read the live table after selecting View 100. If that size is unavailable, they follow every page at the current size; missing or uncertain pager transitions fail closed instead of saving a partial total.
- Toll charges are deduplicated by Lane Txn ID across pages, credits remain excluded, and selected toll evidence is captured on every results page. Search results include page and toll counts.
- Vehicles can be hidden and restored without deleting source records or mappings. Batch trips can be removed individually and added back; removing one does not block approval of another ready trip. Removal controls ask for confirmation.
- An optional inclusive trip-end date range limits verification and toll searches while retaining older cached records. Turo submission remains disabled until the authenticated composer and success states are verified.

## Verification and limits

All 179 synthetic/mock tests and the repository's manifest/JavaScript check pass. The two-page regression includes the later-page $4.19 charge and checks a $38.93 total. Live portal behavior and account totals still need manual acceptance. This is a personal-use, unpacked Chrome/Brave extension, not a Chrome Web Store package or automatic Turo invoicing integration.

See the [user guide](Turo%20Invoicer/docs/USER_GUIDE.md) and [troubleshooting](Turo%20Invoicer/docs/TROUBLESHOOTING.md).

---

# v0.5.13 — initial functional reconciliation release

This is the first release intended for the complete local reconciliation workflow. It is a personal-use, unpacked Chrome/Brave extension—not a Chrome Web Store package or an automatic Turo invoicing integration.

## What works

- Sync completed Turo history, verify toll-invoice status, and run exact E-ZPass tag/plate and trip-date searches.
- Preserve verified source snapshots when collection fails or a query is incomplete.
- Link discovered vehicles to verified E-ZPass account tags and plates, with dated assignments and a clearly marked manual fallback.
- Review unresolved tolls in place; saved mappings recalculate cached matches, trip readiness, and Batch counts.
- Automatically add ready trips to Batch while allowing explicit removal and toll deselection.
- Capture visible E-ZPass evidence locally, preview it, and approve individual trips and an unchanged batch.

## Updating from earlier versions

Load or reload the `Turo Invoicer/` folder as an unpacked extension, then reload the Turo and E-ZPass portal tabs. Schema 5 migrates to schema 6 without clearing saved trips, tolls, fleet assignments, evidence, or sync timestamps. Use **Refresh E-ZPass list** on Vehicles to populate the new identifier selector; that action does not resync trips or replace toll records.

## Verification and limits

The release passes 162 synthetic/mock tests and the repository's manifest and JavaScript checks. Live account totals and portal behavior still need manual acceptance after installing this version. Portal layouts can change. The extension does not verify account ownership, submit reimbursement claims, or guarantee that every toll is reimbursable; inspect source records before acting.

See the [user guide](Turo%20Invoicer/docs/USER_GUIDE.md), [troubleshooting](Turo%20Invoicer/docs/TROUBLESHOOTING.md), and [release checklist](Turo%20Invoicer/docs/DEVELOPMENT.md).
