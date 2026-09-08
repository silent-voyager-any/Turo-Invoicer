# Project documentation

This reference describes version 0.5.1: trip-first exact E-ZPass searches, semantic E-ZPass filter detection, schema-5 evidence and approval state, authenticated Turo status checks, local IndexedDB screenshots, and the four-page dashboard. Last reviewed: September 8, 2026.

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

Implemented: authenticated trip/status reads, completed-trip filtering, trip-first date/tag/plate E-ZPass searches, filtered pagination, exact matching, local evidence capture and previews, persistent selection, per-trip approval, immutable batch approval, dated fleet assignments, and safe local clearing.

Not implemented: Turo evidence upload/final submission, account identity verification, backend services, licensing/billing, or a packaged Chrome Web Store release. These remain gated roadmap work.

The project name does not imply those missing invoicing capabilities exist. Use the source and tests as the implementation reference; treat portal selectors as adapters to validate, not guaranteed contracts.
