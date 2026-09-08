import test from "node:test";
import assert from "node:assert/strict";
import { buildTripQueryJobs, flattenTripQueries } from "../trip_queries.js";

const trips = [{ id: "1001", vehicleId: "car1", start: "2026-07-01T13:00:00Z", end: "2026-07-01T22:00:00Z" }];
const eligibility = { "1001": { status: "eligible_uncharged" } };

test("builds one exact query per active confirmed tag and plate", () => {
  const jobs = buildTripQueryJobs({ trips, tripEligibility: eligibility, assignments: [
    { kind: "tag", identifier: "001-23", canonicalIdentifier: "00123", vehicleId: "car1", validFrom: null, validTo: null },
    { kind: "plate", identifier: "NY:ABC-123", canonicalIdentifier: "ABC123", vehicleId: "car1", validFrom: "2026-07-01", validTo: "2026-07-01" }
  ] });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].identifiers.map(({ kind, canonicalIdentifier }) => [kind, canonicalIdentifier]),
    [["tag", "00123"], ["plate", "ABC123"]]);
  assert.equal(flattenTripQueries(jobs).length, 2);
});

test("grace expands dates only when it crosses midnight and dated assignments are enforced", () => {
  const late = [{ id: "2002", vehicleId: "car1", start: "2026-07-02T04:05:00Z", end: "2026-07-02T05:00:00Z" }];
  const jobs = buildTripQueryJobs({ trips: late, tripEligibility: { "2002": { status: "eligible_uncharged" } }, graceMinutes: 15,
    assignments: [
      { kind: "tag", identifier: "001", canonicalIdentifier: "001", vehicleId: "car1", validFrom: null, validTo: "2026-07-01" },
      { kind: "tag", identifier: "002", canonicalIdentifier: "002", vehicleId: "car1", validFrom: "2026-07-03", validTo: null }
    ] });
  assert.equal(jobs[0].startDate, "2026-07-01");
  assert.equal(jobs[0].endDate, "2026-07-02");
  assert.deepEqual(jobs[0].identifiers.map((item) => item.identifier), ["001"]);
});

test("excludes unverified trips and trips without confirmed identifiers", () => {
  assert.deepEqual(buildTripQueryJobs({ trips, tripEligibility: {}, assignments: [] }), []);
});
