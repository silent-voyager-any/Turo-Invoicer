import test from "node:test";
import assert from "node:assert/strict";
import { buildTripWorkspace, selectAllReady, setTollSelection, setTripSelection } from "../workspace.js";

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
