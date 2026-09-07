# Project documentation

This reference describes version 0.4.7, including vehicle cards, canonical tag/plate matching, the trip-centric dashboard, schema-4 drafts and selections, authenticated Turo detail/status reads, terminal history proof, resilient E-ZPass pagination, and coverage diagnostics. Last reviewed: September 6, 2026.

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
| [turo_invoice_status.js](../turo_invoice_status.js) | Exact-route Turo invoice-hub, invoice-detail, and toll-option adapter |
| [content_ezpass.js](../content_ezpass.js) | E-ZPass record aliases and activity-table fallbacks |
| [reconciler.js](../reconciler.js) | Pure normalization and interval matching |
| [workspace.js](../workspace.js) | Pure trip-draft grouping, blockers, selections, and totals |
| [dashboard.js](../dashboard.js), [dashboard.html](../dashboard.html), [dashboard.css](../dashboard.css) | Vehicles, Trips, Needs review, and Batch pages |
| [popup.js](../popup.js), [popup.html](../popup.html), [popup.css](../popup.css) | Compact launcher and sync status |
| [package.json](../package.json) | Dependency-free test/check commands |
| [tests](../tests) | Synthetic adapter, worker, network, and matching tests |

## Implementation versus roadmap

Implemented: passive capture, explicit-sync JSON reads for history-linked reservations, completed-trip filtering, terminal Turo history proof, normalized toll-invoice eligibility checks, resilient range-aware E-ZPass pagination without date-filter interaction, trip-centric drafts, nested uniquely confirmed tolls, persistent toll/trip selection, exact cent totals, four dashboard pages, autosaved fleet drafts, dated tag/plate assignments, safe blockers, bounded SPA waiting, and local clearing.

Not implemented: screenshot evidence storage, invoice generation/submission, account identity verification, backend services, licensing/billing, or a packaged Chrome Web Store release. These remain gated roadmap work.

The project name does not imply those missing invoicing capabilities exist. Use the source and tests as the implementation reference; treat portal selectors as adapters to validate, not guaranteed contracts.
