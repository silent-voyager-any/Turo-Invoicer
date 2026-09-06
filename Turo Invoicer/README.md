# Turo Toll Reconciler — extension

This directory is the runnable Chrome Manifest V3 extension. Select this folder, containing `manifest.json`, when using **Load unpacked**.

## Run

1. Use Chrome 111+ and enable Developer mode at `chrome://extensions`.
2. Load this directory, then reload your signed-in portal tabs.
3. Keep one Turo tab and one E-ZPass NY tab open. Open `/us/en/trips/history` and `/ezpass/dashboard/transactions`, then apply the intended activity filters.
4. Open the fleet dashboard from the popup, then select **Sync portal tabs**. Both collectors can take up to 20 seconds. Only completed Turo trips qualify.
5. Review suggestions and use the dashboard's dated vehicle-ID/tag/plate form before relying on a result.

Version 0.4.2 collects Turo first, derives the required E-ZPass Transaction Date range from completed trips, and walks the E-ZPass result pages until the disabled Next control proves completion. It also distinguishes unmapped identifiers from mapped personal/unassigned tolls and shows source coverage in the dashboard. Turo pagination and invoice status remain fail-closed; evidence and submission are not yet enabled. Reload the extension and both portal tabs after updating.

No package installation or build is needed. Development checks, from this directory:

```sh
npm test
npm run check
```

## Full documentation

Start with the [documentation index](docs/README.md), then the [user guide](docs/USER_GUIDE.md) or [developer guide](docs/DEVELOPMENT.md).

The project remains a development scaffold: production portal schemas are not authenticated-test verified, history completeness is not established, and no reimbursement claims are submitted. The extension stores normalized records locally, not portal passwords; see [security and privacy](docs/SECURITY.md).
