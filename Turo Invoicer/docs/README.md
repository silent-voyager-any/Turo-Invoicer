# Project documentation

This reference describes version 0.2.2, including authenticated same-origin Turo JSON detail reads, completed-trip filtering, E-ZPass waiting, and manual vehicle mappings. Last reviewed: September 5, 2026.

## Reading paths

- **Hosts:** [User guide](USER_GUIDE.md), then [troubleshooting](TROUBLESHOOTING.md).
- **Engineers:** [Architecture](ARCHITECTURE.md), [data model](DATA_MODEL.md), and [development](DEVELOPMENT.md).
- **Reviewers and release owners:** [Security](SECURITY.md) and the release checklist in [development](DEVELOPMENT.md).

## Source map

Paths below are relative to the extension directory.

| File | Responsibility |
| --- | --- |
| [manifest.json](../manifest.json) | MV3 entry points, host permissions, content-script order |
| [background.js](../background.js) | Trusted popup operations, tab requests, local storage, reconciliation |
| [network_hook.js](../network_hook.js) | MAIN-world fetch/XHR response observation |
| [content_common.js](../content_common.js) | Bridge validation, bounded records, shared observer, async replies |
| [content_turo.js](../content_turo.js) | Turo record aliases, host-card selectors, wait configuration |
| [turo_details.js](../turo_details.js) | Bounded, allowlisted same-origin reservation-detail JSON GETs |
| [content_ezpass.js](../content_ezpass.js) | E-ZPass record aliases and activity-table fallbacks |
| [reconciler.js](../reconciler.js) | Pure normalization and interval matching |
| [popup.js](../popup.js), [popup.html](../popup.html), [popup.css](../popup.css) | Host-facing controls and results |
| [package.json](../package.json) | Dependency-free test/check commands |
| [tests](../tests) | Synthetic adapter, worker, network, and matching tests |

## Implementation versus roadmap

Implemented: passive capture on the exact history/transactions pages, explicit-sync JSON reads for history-linked reservations, completed-trip filtering, local suggestions, manual static vehicle mappings, safe ambiguity handling, bounded SPA waiting for both portals, and local clearing.

Not implemented: verified portal API contracts, automatic pagination, CSV/PDF import/export, invoice generation, claim submission, historical tag assignment, account identity verification, completeness certification, automatic retention expiry, backend services, licensing/billing, or a packaged Chrome Web Store release.

The project name does not imply those missing invoicing capabilities exist. Use the source and tests as the implementation reference; treat portal selectors as adapters to validate, not guaranteed contracts.
