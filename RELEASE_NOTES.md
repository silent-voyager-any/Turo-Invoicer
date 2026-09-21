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
