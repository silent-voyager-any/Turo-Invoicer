# Turo Toll Reconciler — extension

This directory is the runnable Chrome Manifest V3 extension. Select this folder, containing `manifest.json`, when using **Load unpacked**.

## Run

1. Use Chrome 111+ and enable Developer mode at `chrome://extensions`.
2. Load this directory, then reload your signed-in portal tabs.
3. Keep one Turo history tab and one unfiltered E-ZPass NY transactions tab open at `/us/en/trips/history` and `/ezpass/dashboard/transactions`.
4. Open the fleet dashboard from the popup, then select **Find uncharged trips**. Collection can take several minutes for large accounts. Only completed Turo trips qualify.
5. Review suggestions and use the dashboard's dated vehicle-ID/tag/plate form before relying on a result.

Beta 0.5.14 adds reversible vehicle removal, individual Batch removal, and an optional trip-end date range. Filtered E-ZPass collection now verifies the live table after changing its page size and follows every results page, so a first-page-only toll total cannot be saved as complete. It deduplicates tolls by Lane Txn ID, excludes credits, and captures evidence across pages. Refreshing identifiers does not replace synchronized trips or tolls. Collection uses strict trip-first direct queries, preserves leading zeros, closes its temporary tab, and leaves the user's existing E-ZPass tab unchanged. Incomplete queries remain blocked and prior verified results are retained. Turo submission remains disabled pending verified authenticated composer and success fixtures. Reload the extension and both portal tabs after updating, then sync again to recalculate affected trips and refresh evidence and approvals.

No package installation or build is needed. Development checks, from this directory:

```sh
npm test
npm run check
```

## Full documentation

Start with the [documentation index](docs/README.md), then the [user guide](docs/USER_GUIDE.md) or [developer guide](docs/DEVELOPMENT.md).

This is a personal-use reconciliation release, not a public-store release. Portal layouts remain changeable and no reimbursement claims are submitted. The extension stores normalized records locally, not portal passwords; see [security and privacy](docs/SECURITY.md).
