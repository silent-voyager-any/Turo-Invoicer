# Trip-centric toll reconciliation and batch workflow

Last reviewed: September 6, 2026. Version 0.4.0 implements the schema-4 trip workspace, nested confirmed tolls, four dashboard pages, and persistent selection. Complete pagination, verified Turo invoice status, evidence, and submission remain required behavior rather than completed capabilities.

## Goal

Turn the dashboard into a fleet-first workspace that finds every completed, reimbursement-eligible Turo trip without an existing toll invoice, attaches all uniquely matching E-ZPass tolls to that trip, lets the host select multiple trips and tolls, captures the required evidence, and runs one explicitly approved batch.

“Run” means prepare and submit selected Turo reimbursement invoices. It never means charging a payment card directly, and it never guarantees immediate guest payment.

## Why the current dashboard is incomplete

- Turo collection reads only history cards currently loaded in the page and rejects more than 50 discovered reservations. It does not paginate the complete history.
- E-ZPass collection reads only transaction records already loaded by the current page/API responses. It does not request every result page.
- The dashboard renders toll-oriented `Matched` and `Needs review` lists. It has no trip cards, toll checkboxes, trip selection, invoice-status filtering, or batch action.
- A toll becomes vehicle-confirmed only when its captured tag or plate resolves to the exact Turo vehicle ID through a dated fleet assignment. Missing or conflicting assignments leave it unmatched.
- The Turo adapter currently knows trip times and vehicle ID, but it does not yet determine whether a toll reimbursement invoice already exists.

## Required user workflow

### 1. Fleet setup

The dashboard starts on a **Vehicles** page. Each vehicle profile contains:

- Host-facing label, such as `BMW X1 — black`.
- Exact Turo vehicle ID selected from discovered Turo records, with manual entry only as a fallback.
- One or more license plates with optional state and inclusive effective dates.
- One or more E-ZPass tag IDs with inclusive effective dates.
- **Add another vehicle**, **Edit**, and **Remove** actions.

Unfinished fields autosave locally. An identifier cannot have overlapping assignments. Leading zeros and exact portal formatting are preserved.

The dashboard blocks batch preparation until every selected trip’s vehicle has a unique active tag or plate assignment for the relevant dates.

### 2. Discover eligible Turo trips

The user selects **Find uncharged trips**. The Turo history collector:

1. Starts from `/us/en/trips/history` in the active signed-in desktop session.
2. Enumerates every history page/cursor in the configured lookback window instead of relying on visible cards.
3. Loads the verified reservation-detail record for each numeric reservation ID with bounded concurrency.
4. Keeps only completed trips belonging to configured fleet vehicles.
5. Reads the verified Turo reimbursement/invoice state for each reservation.
6. Classifies each trip as:
   - `eligible_uncharged`: no existing toll reimbursement and still eligible;
   - `already_charged`: a toll reimbursement already exists or was paid;
   - `ineligible`: cancelled, outside the allowed deadline, or otherwise blocked by Turo;
   - `status_unknown`: the invoice state could not be verified.

Only `eligible_uncharged` trips are selectable. `already_charged`, `ineligible`, and `status_unknown` trips remain available behind diagnostic filters but cannot enter a batch.

The default lookback is 90 days from trip end. The collector stops at a configurable safety cap, reports the number of pages and trips examined, and marks the result incomplete if any page, reservation, or invoice-status request fails. An incomplete result cannot be submitted.

### 3. Collect all relevant E-ZPass tolls

After eligible trips are known, the E-ZPass collector derives the required date span from the earliest trip start through the latest trip end, including the selected grace period. It then:

1. Uses the signed-in `/ezpass/dashboard/transactions` tab.
2. Requests every verified transaction page/cursor for that span, chunking the range only when required by the portal.
3. Collects toll postings identified by either tag ID or plate number.
4. Excludes credits, deposits, payments, replenishments, refunds, adjustments, duplicates, and incomplete timestamps.
5. Reports page count, raw row count, accepted toll count, ignored non-toll count, and completeness.

The extension must not claim **All tolls loaded** unless it reached the verified final page for every requested date chunk. A partial E-ZPass result is viewable but cannot be submitted.

### 4. Build trip cards

The primary dashboard page becomes **Trips**, grouped first by configured vehicle and then by trip end date. Every eligible trip is its own card containing:

- Trip/reservation ID and vehicle label.
- Trip start/end time in `America/New_York`.
- Verified Turo invoice state and reimbursement deadline.
- Every toll whose passage time falls inside the trip interval plus grace and whose tag/plate assignment resolves to that vehicle on the toll’s local date.
- Toll time, plaza, amount, tag/plate identity, match confidence, and evidence status.
- Trip toll total calculated in integer cents.

Trips with no matching tolls remain visible as **No tolls found** but cannot be selected. Already charged trips are hidden by default.

A toll may belong to exactly one trip draft. Overlapping trip intervals, conflicting vehicle identities, duplicate toll fingerprints, missing mappings, invalid timestamps, or an unverifiable source send the toll to **Needs review** instead of silently attaching it.

### 5. Select tolls and trips

- Each uniquely matched toll has a checkbox and is preselected inside its trip card.
- The host can deselect an individual toll without deleting it.
- Each eligible trip has a checkbox. Selecting a trip selects its currently approved toll rows; deselecting the trip removes it from the batch.
- **Select all ready trips** selects only complete, uniquely matched, evidence-ready trips.
- The sticky batch bar displays selected trip count, toll count, and exact total.
- Any mapping, toll-selection, amount, evidence, or source change invalidates the previous approval.

`Needs review` supports assigning a toll to one eligible trip only after showing the competing candidates and requiring an explicit host choice. Manually assigned tolls remain visibly marked and require confirmation on the final review screen.

### 6. Prepare evidence and run the batch

The first action is **Prepare selected trips**, not immediate submission. For each selected trip the extension:

1. Opens or focuses the E-ZPass transactions tab and filters/navigates to the selected toll rows.
2. Captures one or more unmodified visible portal screenshots that show date, time, plaza, amount, and tag/plate identity.
3. Stores screenshot blobs locally in IndexedDB and links their hashes to one immutable trip draft.
4. Shows an evidence preview and blocks the draft if any selected toll is not visible in the evidence.

When every draft is complete, **Review batch** displays every trip, selected toll, total, evidence image, deadline, manual override, and warning. **Run approved batch** becomes available only after the host approves that exact immutable review.

Submission runs sequentially through Turo’s visible reimbursement flow. Before the final send for each trip, it rechecks the reservation ID, existing toll-invoice state, amount, and uploaded evidence. A challenge, navigation mismatch, changed DOM, existing invoice, upload failure, or uncertain result stops that trip as `manual_review`; it is never retried automatically.

## Dashboard navigation

The persistent dashboard uses four pages:

1. **Vehicles** — add/edit fleet profiles and dated tags/plates.
2. **Trips** — eligible uncharged trips with nested matched tolls and multi-select controls.
3. **Needs review** — unmatched/ambiguous tolls, incomplete sources, unknown invoice states, and manual resolution.
4. **Batch** — evidence preparation, immutable approval, submission progress, and sent ledger.

The header always shows Turo completeness, E-ZPass completeness, last successful refresh, and active vehicle filter. Source counts must distinguish loaded records from complete records.

## Data and state additions

The next schema revision must add:

- `collectionRuns`: source range, cursors/pages, counts, errors, completeness, and timestamps.
- `tripEligibility`: reservation ID, normalized invoice state, deadline, checked-at time, and source adapter revision.
- `invoiceDrafts`: reservation ID, vehicle ID, selected toll fingerprints, total cents, evidence IDs, status, revision hash, and approval metadata.
- `submissionLedger`: immutable attempted/sent results and toll fingerprints used to prevent duplicates.
- IndexedDB evidence blobs; screenshot bytes never enter `chrome.storage.local`.

No guest name, messages, addresses, cookies, request headers, passwords, or raw portal payloads are stored.

## Matching rules

- Normalize Turo and E-ZPass times in `America/New_York`; preserve explicit offsets and reject ambiguous DST times.
- Resolve tag/plate ownership on the toll’s local calendar date using the vehicle’s dated assignments.
- Require both a unique vehicle match and a unique trip interval match before preselecting a toll.
- Use a stable portal transaction ID when available. Otherwise fingerprint normalized timestamp, plaza, amount cents, and tag/plate identity.
- Never attach one fingerprint to multiple trips or a fingerprint already recorded as sent.
- Grace is opt-in and visibly flagged on every affected toll.
- Totals use integer cents and equal the sum of selected tolls; no convenience fee is added.

## Implementation sequence

1. **Fleet UX:** separate Vehicles page, multi-vehicle editor, discovered Turo vehicle picker, and assignment diagnostics.
2. **Complete collectors:** fixture-backed Turo history pagination, toll-invoice status adapter, E-ZPass date-range pagination, progress, caps, cancellation, and completeness proofs.
3. **Trip workspace:** trip-centric grouping, toll/trip checkboxes, review queue, integer-cent totals, filtering, and persisted selections.
4. **Evidence:** explicit active-tab capture, row-visibility verification, IndexedDB storage, hashing, previews, quota handling, and retention.
5. **Batch engine:** immutable review, duplicate ledger, dry-run Turo adapter, sequential submission, stop/recovery rules, and one separately authorized live acceptance test.

Exact private endpoint paths and response fields must be established from redacted authenticated browser inspection and locked into synthetic fixtures before collector or submission code is written. Do not guess pagination, invoice status, or submission success from visible labels alone.

## Acceptance criteria

- A host can configure multiple vehicles and switch tabs without losing unfinished text.
- Sync examines all Turo and E-ZPass pages in the chosen range or clearly reports an incomplete run.
- Every eligible uncharged trip appears once under the correct vehicle, including trips with zero tolls.
- Every unique vehicle-and-time-qualified toll appears under exactly one trip; ambiguous tolls remain in review.
- The host can select/deselect individual tolls and multiple trip cards and see an exact batch total.
- Already charged, unknown, incomplete, duplicate, evidence-free, or ineligible trips cannot run.
- No Turo submission occurs before evidence preparation and explicit approval of the unchanged batch.
- Existing version-3 fleet assignments and normalized source snapshots migrate without data loss.

## Decisions to verify during portal inspection

- The exact Turo pagination request and terminal cursor/page signal.
- The exact Turo field or visible state that distinguishes no toll invoice, pending invoice, paid invoice, disputed invoice, and unsupported incidental types.
- The exact E-ZPass pagination request, maximum date range, page size, final-page signal, and stable transaction identifier.
- Whether one filtered E-ZPass page can visibly contain every toll for a trip; otherwise evidence must span multiple screenshots.
- The Turo reimbursement form’s category, amount, note, attachment, duplicate-warning, and final success selectors.
