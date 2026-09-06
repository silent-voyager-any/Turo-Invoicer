# Project documentation

This reference describes version 0.3.1, including the persistent fleet dashboard, dated vehicle assignments, authenticated same-origin Turo detail reads, completed-trip filtering, and E-ZPass normalization. Last reviewed: September 6, 2026.

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

Implemented: passive capture on the exact history/transactions pages, explicit-sync JSON reads for history-linked reservations, completed-trip filtering, local suggestions, a persistent dashboard, autosaved fleet drafts, dated tag/plate assignments, safe ambiguity handling, bounded SPA waiting, and local clearing.

Not implemented: automatic pagination, screenshot evidence storage, invoice generation/submission, account identity verification, completeness certification, backend services, licensing/billing, or a packaged Chrome Web Store release. These remain gated in the root `PROJECT_PLAN.md`.

The project name does not imply those missing invoicing capabilities exist. Use the source and tests as the implementation reference; treat portal selectors as adapters to validate, not guaranteed contracts.
