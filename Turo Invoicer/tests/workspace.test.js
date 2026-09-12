import test from "node:test";
import assert from "node:assert/strict";
import { batchRevision, buildTripWorkspace, selectAllReady, setTollSelection, setTripApproval, setTripSelection } from "../workspace.js";

const trip = { id: "trip-1", vehicleId: "car-1", start: "2026-07-01 09:00", end: "2026-07-01 18:00" };
const toll = { id: "toll-1", timestampMs: Date.parse("2026-07-01T16:00:00Z"), plaza: "Example", amountCents: 694 };
const complete = { turo: { complete: true }, ezpass: { complete: true } };

function workspace(overrides = {}) {
  return buildTripWorkspace({
    trips: [trip],
    reconciliation: { matched: [{ trip: { ...trip, startMs: 1, endMs: 2 }, toll, vehicleConfirmed: true, withinGrace: false }] },
    tripEligibility: { "trip-1": { status: "eligible_uncharged" } },
    collectionRuns: complete,
    ...overrides
  });
}

test("builds one trip-centric draft with preselected confirmed tolls", () => {
  const result = workspace();
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(result.drafts[0].selectedTollIds, ["toll-1"]);
  assert.equal(result.drafts[0].totalCents, 694);
  assert.equal(result.drafts[0].selectable, true);
});

test("time-only matches never enter a trip draft", () => {
  const result = workspace({ reconciliation: { matched: [{ trip, toll, vehicleConfirmed: false }] } });
  assert.equal(result.drafts[0].tolls.length, 0);
  assert.ok(result.drafts[0].blockingReasons.includes("no_matching_tolls"));
});

test("unknown eligibility and incomplete collections fail closed", () => {
  const result = workspace({ tripEligibility: {}, collectionRuns: { turo: { complete: false }, ezpass: { complete: true } } });
  assert.deepEqual(result.drafts[0].blockingReasons.slice(0, 2), ["turo_collection_incomplete", "status_unknown"]);
  assert.equal(result.drafts[0].selectable, false);
});

test("an unavailable portal identifier blocks only its affected trip", () => {
  const result = workspace({ collectionRuns: { ...complete, ezpass: { complete: true, queryReports: [
    { reservationId: "trip-1", kind: "tag", status: "identifier_unavailable", complete: false }
  ] } } });
  assert.ok(result.drafts[0].blockingReasons.includes("identifier_unavailable"));
  assert.equal(result.drafts[0].selectable, false);
});

test("a partial run leaves completed trips selectable but blocks the stalled trip", () => {
  const other = { ...trip, id: "trip-2" };
  const result = workspace({
    trips: [trip, other],
    reconciliation: { matched: [
      { trip, toll, vehicleConfirmed: true },
      { trip: other, toll: { ...toll, id: "toll-2" }, vehicleConfirmed: true }
    ] },
    tripEligibility: { "trip-1": { status: "eligible_uncharged" }, "trip-2": { status: "eligible_uncharged" } },
    collectionRuns: { turo: { complete: true }, ezpass: { complete: false, queryReports: [
      { reservationId: "trip-1", status: "complete", complete: true },
      { reservationId: "trip-2", status: "search_incomplete", complete: false, reason: "search_not_applied" }
    ] } }
  });
  assert.equal(result.drafts.find((draft) => draft.reservationId === "trip-1").selectable, true);
  const stalled = result.drafts.find((draft) => draft.reservationId === "trip-2");
  assert.equal(stalled.selectable, false);
  assert.ok(stalled.blockingReasons.includes("search_incomplete"));
});

test("stale evidence and prior approvals cannot survive a source refresh", () => {
  const prior = workspace({ evidence: [{ id: "shot", hash: "abc", reservationId: "trip-1", coveredTollIds: ["toll-1"] }] }).drafts;
  const refreshed = workspace({ previousDrafts: prior, evidence: [{ id: "shot", hash: "abc", status: "stale",
    reservationId: "trip-1", coveredTollIds: ["toll-1"] }] });
  assert.equal(refreshed.drafts[0].evidenceComplete, false);
  assert.equal(refreshed.drafts[0].batchReady, false);
});

test("sent toll fingerprints are not attached again", () => {
  const result = workspace({ submissionLedger: [{ status: "sent", tollIds: ["toll-1"] }] });
  assert.equal(result.drafts[0].tolls.length, 0);
});

test("toll and trip selection updates exact cent totals", () => {
  let drafts = workspace().drafts;
  drafts = setTripSelection(drafts, "trip-1", true);
  assert.equal(drafts[0].selected, true);
  drafts = setTollSelection(drafts, "trip-1", "toll-1", false);
  assert.equal(drafts[0].totalCents, 0);
  assert.equal(drafts[0].selected, false);
  assert.throws(() => setTripSelection(drafts, "trip-1", true), /not ready/);
});

test("select all includes only ready trips", () => {
  const ready = workspace().drafts[0];
  const blocked = { ...ready, reservationId: "trip-2", selectable: false, selected: false };
  const selected = selectAllReady([ready, blocked]);
  assert.equal(selected[0].selected, true);
  assert.equal(selected[1].selected, false);
});

test("evidence coverage enables individual approval and revisions invalidate it", () => {
  const withEvidence = workspace({ evidence: [{ id: "shot-1", hash: "abc", reservationId: "trip-1", coveredTollIds: ["toll-1"] }] });
  let drafts = setTripSelection(withEvidence.drafts, "trip-1", true);
  assert.equal(drafts[0].batchReady, true);
  drafts = setTripApproval(drafts, "trip-1", true);
  assert.equal(drafts[0].tripApproved, true);
  assert.match(batchRevision(drafts), /^batch-v1-/);
  const rebuilt = workspace({ previousDrafts: drafts, evidence: [{ id: "shot-2", hash: "changed", reservationId: "trip-1", coveredTollIds: ["toll-1"] }] });
  assert.equal(rebuilt.drafts[0].tripApproved, false);
});
