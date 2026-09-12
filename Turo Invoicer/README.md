# Turo Toll Reconciler — extension

This directory is the runnable Chrome Manifest V3 extension. Select this folder, containing `manifest.json`, when using **Load unpacked**.

## Run

1. Use Chrome 111+ and enable Developer mode at `chrome://extensions`.
2. Load this directory, then reload your signed-in portal tabs.
3. Keep one Turo history tab and one unfiltered E-ZPass NY transactions tab open at `/us/en/trips/history` and `/ezpass/dashboard/transactions`.
4. Open the fleet dashboard from the popup, then select **Find uncharged trips**. Collection can take several minutes for large accounts. Only completed Turo trips qualify.
5. Review suggestions and use the dashboard's dated vehicle-ID/tag/plate form before relying on a result.

Version 0.5.7 collects and verifies Turo first, then searches E-ZPass separately for each eligible trip and every confirmed active tag and plate. It types each trip date into the portal's masked `MM/DD/YY` inputs, waits for the exact tag/plate menu, and reports unavailable vehicle assignments per trip while continuing other searches. An affected trip cannot be batched until its assignment is corrected. It retains sync-scoped session continuation, local evidence, and revision-bound approvals. Turo submission remains disabled pending verified upload fixtures. Reload the extension and both portal tabs after updating.

No package installation or build is needed. Development checks, from this directory:

```sh
npm test
npm run check
```

## Full documentation

Start with the [documentation index](docs/README.md), then the [user guide](docs/USER_GUIDE.md) or [developer guide](docs/DEVELOPMENT.md).

This is a personal-use reconciliation release, not a public-store release. Portal layouts remain changeable and no reimbursement claims are submitted. The extension stores normalized records locally, not portal passwords; see [security and privacy](docs/SECURITY.md).
