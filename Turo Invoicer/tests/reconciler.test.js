import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeIdentifier, toEpochMs, normalizeAmount, reconcileTolls, selectCompletedTrips } from "../reconciler.js";

const trip = { id: "trip-1", vehicleId: "car-1", start: "2026-07-01 09:00", end: "2026-07-01 18:00" };
const toll = { id: "toll-1", timestamp: "2026-07-01 12:00", plaza: "Queens Midtown", amount: "$6.94" };

test("normalizes Eastern winter and summer independently of host time zone", () => {
  assert.equal(toEpochMs("2026-01-01 12:00"), Date.parse("2026-01-01T17:00:00Z"));
  assert.equal(toEpochMs("07/01/2026 12:00 PM"), Date.parse("2026-07-01T16:00:00Z"));
  assert.equal(toEpochMs("2026-07-01T12:00:00-04:00"), Date.parse("2026-07-01T16:00:00Z"));
});
test("rejects DST gaps and folds rather than guessing", () => {
  assert.equal(toEpochMs("2026-03-08 02:30"), null);
  assert.equal(toEpochMs("2026-11-01 01:30"), null);
  assert.equal(toEpochMs("2026-11-01T01:30:00-05:00"), Date.parse("2026-11-01T06:30:00Z"));
});
test("rejects date-only, invalid calendar, unsupported and malformed times", () => {
  for (const date of ["2026-07-01", "2026-02-30 10:00", "2026-02-30T10:00:00Z", "07/01/2026 13:00 PM", "not a date", "Jul 1 2026 12:00", "2026-07-01 25:00"]) {
    assert.equal(toEpochMs(date), null, date);
  }
});
test("accepts seconds/milliseconds and rejects out-of-range epochs", () => {
  assert.equal(toEpochMs("09/05/2026 13:11:16.090"), Date.parse("2026-09-05T17:11:16.090Z"));
  assert.equal(toEpochMs("09/05/2026 1:11:16.9 PM"), Date.parse("2026-09-05T17:11:16.900Z"));
  assert.equal(toEpochMs(1782921600), 1782921600000);
  assert.equal(toEpochMs("1782921600000"), 1782921600000);
  assert.equal(toEpochMs(1e20), null);
});
test("parses monetary values without treating missing values as zero", () => {
  assert.equal(normalizeAmount("$1,234.56"), 1234.56);
  assert.equal(normalizeAmount("($6.94)"), -6.94);
  for (const value of ["", "N/A", "USD TBD", null]) assert.equal(normalizeAmount(value), null);
});
test("a unique temporal suggestion is explicitly unconfirmed by vehicle", () => {
  const result = reconcileTolls([toll], [trip]);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].vehicleConfirmed, false);
  assert.equal(result.matched[0].toll.amountCents, 694);
});
test("inclusive adjacent boundaries produce ambiguity", () => {
  const next = { ...trip, id: "trip-2", start: trip.end, end: "2026-07-01 20:00" };
  const result = reconcileTolls([{ ...toll, timestamp: trip.end }], [trip, next]);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.matched.length, 0);
});
test("tag mappings resolve overlaps, and conflicting mappings require review", () => {
  const second = { ...trip, id: "trip-2", vehicleId: "car-2" };
  const tagged = { ...toll, tagId: "001", plate: "NY:ABC" };
  const result = reconcileTolls([tagged], [trip, second], { vehicleByTag: { "001": "car-2" } });
  assert.equal(result.matched[0].trip.id, "trip-2");
  assert.equal(result.matched[0].vehicleConfirmed, true);
  const conflict = reconcileTolls([tagged], [trip, second], {
    vehicleByTag: { "001": "car-2" }, vehicleByPlate: { "NY:ABC": "car-1" }
  });
  assert.equal(conflict.unmatchedTolls[0].reason, "conflicting_vehicle_mapping");
});
test("grace periods are opt-in and flagged", () => {
  const early = { ...toll, timestamp: "2026-07-01 08:50" };
  assert.equal(reconcileTolls([early], [trip]).matched.length, 0);
  assert.equal(reconcileTolls([early], [trip], { graceMinutes: 15 }).matched[0].withinGrace, true);
});
test("invalid trips and nonpositive/invalid amounts do not match", () => {
  const result = reconcileTolls([{ ...toll, amount: "N/A" }, { ...toll, amount: 0 }], [trip, { ...trip, end: "bad" }]);
  assert.equal(result.matched.length, 0);
  assert.equal(result.invalidTrips.length, 1);
  assert.equal(result.unmatchedTolls.length, 2);
});
test("does not mutate inputs", () => {
  const original = JSON.stringify({ toll, trip });
  reconcileTolls([toll], [trip]);
  assert.equal(JSON.stringify({ toll, trip }), original);
});
test("normalizes E-ZPass debit signs to a positive charge before matching", () => {
  const result = reconcileTolls([{ ...toll, amount: "-$6.94" }], [trip]);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].toll.amount, 6.94);
  assert.equal(result.matched[0].toll.amountCents, 694);
});

test("history excludes future, in-progress, and invalid trips using normalized timestamps", () => {
  const nowMs = Date.parse("2026-07-01T22:00:00Z");
  const { completed, excludedCount } = selectCompletedTrips([
    trip, { ...trip, id: "future", start: "2026-07-02 09:00", end: "2026-07-02 18:00" },
    { ...trip, id: "ongoing", end: "2026-07-01 19:00" }, { ...trip, id: "invalid", end: "unknown" }
  ], { nowMs });
  assert.deepEqual(completed.map((t) => t.id), ["trip-1"]);
  assert.equal(excludedCount, 3);
});
test("mixed tag/plate identifiers resolve only through explicit, nonconflicting mappings", () => {
  const mixed = { ...toll, tagOrPlate: "000123" };
  assert.equal(reconcileTolls([mixed], [trip], { vehicleByTag: { "000123": "car-1" } }).matched[0].vehicleConfirmed, true);
  assert.equal(reconcileTolls([mixed], [trip], { vehicleByPlate: { "000123": "car-1" } }).matched[0].vehicleConfirmed, true);
  assert.equal(reconcileTolls([mixed], [trip], { vehicleByTag: { "000123": "car-1" }, vehicleByPlate: { "000123": "car-2" } }).unmatchedTolls[0].reason, "conflicting_vehicle_mapping");
});
test("canonical identifiers match formatting without weakening exact identity", () => {
  assert.equal(canonicalizeIdentifier("plate", "NY: abc-123"), "ABC123");
  assert.equal(canonicalizeIdentifier("plate", "NYABC123"), "NYABC123");
  assert.equal(canonicalizeIdentifier("tag", "00-12 34"), "001234");
  assert.notEqual(canonicalizeIdentifier("tag", "001234"), canonicalizeIdentifier("tag", "1234"));
  assert.equal(canonicalizeIdentifier("tag", "---"), null);

  const formatted = { ...toll, plate: "abc 123" };
  const result = reconcileTolls([formatted], [trip], {
    vehicleAssignments: [{ kind: "plate", identifier: "NY:ABC-123", vehicleId: "car-1" }]
  });
  assert.equal(result.matched[0].vehicleConfirmed, true);
});
test("Turo internal IDs are never inferred from E-ZPass identifiers", () => {
  const result = reconcileTolls([{ ...toll, tagOrPlate: "car-1", vehicleId: "car-1" }], [trip]);
  assert.equal(result.matched[0].vehicleConfirmed, false);
});
test("dated fleet assignments resolve only inside their inclusive local-date range", () => {
  const second = { ...trip, id: "trip-2", vehicleId: "car-2" };
  const tagged = { ...toll, tagOrPlate: "001" };
  const assignments = [{ kind: "tag", identifier: "001", vehicleId: "car-2", validFrom: "2026-07-01", validTo: "2026-07-01" }];
  const matched = reconcileTolls([tagged], [trip, second], { vehicleAssignments: assignments });
  assert.equal(matched.matched[0].trip.vehicleId, "car-2");
  assert.equal(matched.matched[0].vehicleConfirmed, true);
  const expired = reconcileTolls([{ ...tagged, timestamp: "2026-07-02 12:00" }], [
    { ...trip, end: "2026-07-02 18:00" }, { ...second, end: "2026-07-02 18:00" }
  ], { vehicleAssignments: assignments });
  assert.equal(expired.ambiguous.length, 1);
});
