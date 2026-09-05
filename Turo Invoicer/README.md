# Turo Toll Reconciler — extension

This directory is the runnable Chrome Manifest V3 extension. Select this folder, containing `manifest.json`, when using **Load unpacked**.

## Run

1. Use Chrome 111+ and enable Developer mode at `chrome://extensions`.
2. Load this directory, then reload your signed-in portal tabs.
3. Keep one Turo tab and one E-ZPass NY tab open. Open `/us/en/trips/history` and `/ezpass/dashboard/transactions`, then apply the intended activity filters.
4. Select **Sync open tabs** in the popup. Both collectors can take up to 20 seconds. Only completed Turo trips qualify.
5. Review suggestions and use the manual vehicle-ID/tag/plate form before relying on a result.

Version 0.2.2 uses read-only JSON detail requests for numeric reservation links discovered in loaded Turo history cards. Sync uses your existing browser session without reading credentials. It prefers the endpoint's epoch trip boundaries and stable vehicle ID; short date labels are never guessed. Unsupported or invalid detail responses preserve prior results and show an actionable error. Reload the extension and both portal tabs after updating.

No package installation or build is needed. Development checks, from this directory:

```sh
npm test
npm run check
```

## Full documentation

Start with the [documentation index](docs/README.md), then the [user guide](docs/USER_GUIDE.md) or [developer guide](docs/DEVELOPMENT.md).

The project remains a development scaffold: production portal schemas are not authenticated-test verified, history completeness is not established, and no reimbursement claims are submitted. The extension stores normalized records locally, not portal passwords; see [security and privacy](docs/SECURITY.md).
