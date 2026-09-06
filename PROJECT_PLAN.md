# Turo Invoicer product plan

Last reviewed: September 6, 2026. This document is the implementation source of truth for the local-first Chrome extension.

The detailed trip-centric discovery, selection, evidence, and batch experience is specified in [TRIP_BATCH_WORKFLOW.md](TRIP_BATCH_WORKFLOW.md).

## Product goal

Help a multi-vehicle Turo host collect NY E-ZPass toll activity, associate each toll with the correct completed trip, assemble portal evidence, and send selected reimbursement invoices after one explicit batch approval. “Charge” means sending a Turo reimbursement invoice; it does not guarantee immediate guest payment.

## Non-negotiable safeguards

- Never request, read, or store portal passwords, cookies, authorization headers, or payment credentials.
- Never submit an invoice without a visible batch approval listing its trip, tolls, total, and evidence.
- Never guess vehicle identity, dates, amounts, evidence, or successful submission.
- Block ambiguous mappings, duplicate tolls, unsupported Turo states, missing evidence, challenges, and standard invoices more than 90 days after trip end.
- Add no administrative or convenience fee. Invoice totals must equal selected toll evidence.
- Keep all trip, vehicle, evidence, draft, and submission data in the local extension profile.
- Do not alter screenshots or fabricate EXIF, date, location, or geolocation metadata.

## User workflow

1. Open the persistent extension dashboard. The toolbar popup only launches the dashboard and shows compact status.
2. Sync one signed-in Turo history tab and one signed-in E-ZPass transactions tab.
3. Review vehicle profiles. Assign tags and plates to Turo vehicle IDs using inclusive effective date ranges; open-ended ranges are allowed.
4. Resolve unmatched or ambiguous tolls. Exactly one time-and-vehicle-qualified trip is required.
5. Select a trip draft, switch to the E-ZPass transaction page, expose the relevant rows and required columns, and capture one or more unmodified visible portal screenshots.
6. Review the fleet queue. Select eligible drafts and approve the batch.
7. Submit approved invoices sequentially through Turo’s visible invoice UI. Stop safely on navigation, challenge, schema, upload, or duplicate-check failures.
8. Retain sent evidence for 30 days, then delete it automatically. Keep unsent evidence until the draft is sent or manually removed.

## Architecture

### Extension surfaces

- `popup.html`: compact launcher, sync status, and explicit active-tab evidence capture entry point.
- `dashboard.html`: persistent fleet setup, mapping diagnostics, evidence queue, invoice review, and submission progress.
- MV3 service worker: serialized state transitions, portal coordination, reconciliation, screenshot capture, retention, and submission orchestration.
- Isolated content scripts: narrowly scoped Turo/E-ZPass adapters. Page responses remain untrusted and are reduced to allowlisted scalar fields.
- IndexedDB: screenshot blobs. `chrome.storage.local`: versioned metadata, settings, drafts, and ledger only.

### Permissions

- Keep `storage` and the existing Turo/E-ZPass host permissions.
- Add `activeTab` only for an explicit visible-tab screenshot capture initiated on E-ZPass.
- Add `alarms` for 30-day evidence cleanup.
- Do not add `<all_urls>`, `cookies`, `webRequest`, `debugger`, `downloads`, or remote-code permissions.

## Schema 3

```json
{
  "version": 3,
  "sources": { "turo": { "records": [] }, "ezpass": { "records": [] } },
  "settings": { "timeZone": "America/New_York", "graceMinutes": 0 },
  "fleet": {
    "vehicles": [{ "vehicleId": "12345", "label": "Host label" }],
    "assignments": [{
      "id": "assignment-id",
      "kind": "tag",
      "identifier": "0012345678",
      "vehicleId": "12345",
      "validFrom": "2026-01-01",
      "validTo": null
    }]
  },
  "uiDrafts": { "vehicleAssignment": {} },
  "invoiceDrafts": [],
  "evidence": [],
  "submissionLedger": [],
  "reconciliation": null,
  "lastSync": null
}
```

Date ranges are interpreted as inclusive calendar dates in the configured time zone. Overlapping assignments for the same identifier are rejected. Legacy tag/plate mappings migrate as open-ended assignments without discarding saved source snapshots.

Invoice draft states are `needs_mapping`, `needs_evidence`, `ready`, `approved`, `submitting`, `sent`, `failed`, and `manual_review`. A service-worker restart must recover a `submitting` draft as `manual_review`, never retry it blindly.

## Matching and duplicate rules

- Normalize portal timestamps in `America/New_York`, preserving explicit offsets and rejecting DST gaps/folds without offsets.
- Resolve tag/plate assignments at the toll’s local calendar date. A mixed tag/plate value may use either namespace only when the result is unique.
- Require one qualifying trip after interval, grace, and vehicle filtering. Time-only suggestions require mapping before invoicing.
- Group tolls by reservation into one draft. The amount is the exact sum of selected toll cents.
- Fingerprint a toll from its stable source ID or normalized timestamp, plaza, amount, and identifier. Record sent fingerprints by reservation so rediscovery cannot create another eligible draft.
- Check the visible Turo invoice state before submission. Existing, open, paid, disputed, or unverifiable invoices require manual review.

## Evidence contract

- Evidence is one or more PNG captures of the unmodified visible E-ZPass transaction page for a single trip.
- Each capture must visibly contain the relevant transaction rows and the portal columns needed to establish date, time, location, amount, and plate/tag identity.
- Store the PNG blob in IndexedDB and metadata containing only its local key, SHA-256 hash, dimensions, capture time, source route, draft ID, and retention deadline.
- Screenshot capture must fail closed if the active tab is not the exact E-ZPass transactions route.
- Browser screenshots do not receive fabricated camera or geolocation metadata. If Turo rejects this evidence, the draft becomes `manual_review`.

## Batch submission contract

- The approval screen shows every selected reservation, vehicle, toll, amount, evidence thumbnail/hash, deadline, and warning.
- One approval covers only the displayed immutable batch. Changes to a draft revoke approval.
- Submit one invoice at a time through the visible Turo UI. Re-read the reservation ID, amount, evidence count, and existing-invoice state before the final send action.
- Record `attemptedAt` before send and the visible result afterward. An uncertain result is `manual_review`; it is never automatically retried.
- Continue or stop after a per-invoice failure according to the approved batch setting, while preserving a complete local audit trail.

## Milestones

### M1 — Persistent fleet dashboard

- Schema-3 migration, full dashboard, autosaved form drafts, dated assignments, fleet-aware reconciliation, and regression tests.

### M2 — Evidence capture

- Explicit active-tab authorization, row targeting, unmodified PNG capture, IndexedDB storage, hashing, previews, retention, and quota/error handling.

### M3 — Invoice drafts

- Per-trip grouping, eligibility/deadline checks, duplicate ledger, immutable batch review, and exportable diagnostics.

### M4 — Turo submission adapter

- Redacted DOM fixtures for every invoice step, sequential orchestration, upload verification, existing-invoice detection, safe restart recovery, and dry runs that stop before send.

### M5 — Controlled release

- One separately authorized eligible live invoice, rollback verification, privacy review, packaged installation tests, and Chrome Web Store release work.

## Acceptance criteria

- Switching away from the dashboard never erases unsaved fleet input; a browser restart restores the draft.
- Multiple vehicles and historical tag transfers resolve tolls only inside their effective date ranges.
- No ambiguous, unsupported, duplicate, over-deadline, or evidence-free draft can become approved.
- Screenshot bytes never enter `chrome.storage.local`, leave the device, or outlive the retention policy.
- A batch cannot send an invoice absent explicit approval, and an uncertain send is never retried automatically.
- Automated tests use synthetic/redacted fixtures. Live verification never commits account data.
