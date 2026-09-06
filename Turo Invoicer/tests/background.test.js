import test from "node:test";
import assert from "node:assert/strict";

const stored = {};
let listener;
let noEzpass = false;
let doubleTuro = false;
let delayTuro = false;
let accessLevel;
let turoUrl = "https://turo.com/us/en/trips/history";
let ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
const portalResponses = {
  1: { ok: true, source: "turo", pagePath: "/us/en/trips/history", records: [{ id: "trip1", vehicleId: "car1", start: "2026-07-01 09:00", end: "2026-07-01 18:00", vehicleLabel: "Example car", vehiclePlate: "NY:ABC-123", guestName: "Synthetic private field" }] },
  2: { ok: true, source: "ezpass", pagePath: "/ezpass/dashboard/transactions", records: [{ id: "toll1", timestamp: "2026-07-01 12:00", plaza: "Lincoln", amount: 10, accountNumber: "Synthetic private field" }] }
};
globalThis.chrome = {
  runtime: { id: "test-id", getURL: (file) => "chrome-extension://test-id/" + file,
    onMessage: { addListener: (callback) => { listener = callback; } } },
  storage: { local: {
    setAccessLevel: async (value) => { accessLevel = value.accessLevel; },
    get: async (key) => structuredClone({ [key]: stored[key] }),
    set: async (values) => Object.assign(stored, structuredClone(values)),
    remove: async (key) => { delete stored[key]; }
  } },
  tabs: {
    query: async ({ url }) => url[0].includes("turo") ? (doubleTuro ? [{ id: 1, url: turoUrl }, { id: 3, url: turoUrl }] : [{ id: 1, url: turoUrl }]) : (noEzpass ? [] : [{ id: 2, url: ezpassUrl }]),
    sendMessage: async (id, message) => {
      if (message.type === "CLEAR_CAPTURE") return { ok: true };
      if (id === 1 && delayTuro) await new Promise((resolve) => setTimeout(resolve, 5100));
      return structuredClone(portalResponses[id]);
    }
  }
};
await import("../background.js");
const sender = { id: "test-id", url: "chrome-extension://test-id/popup.html" };
const dashboardSender = {
  id: "test-id",
  url: "chrome-extension://test-id/dashboard.html",
  tab: { id: 9, url: "chrome-extension://test-id/dashboard.html" }
};
const call = (message, from = sender) => new Promise((resolve) => listener(message, from, resolve));

test("worker trusts exact extension UI pages and rejects all other senders", async () => {
  assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  assert.equal((await call({ type: "GET_STATE" })).ok, true);
  assert.equal((await call({ type: "GET_STATE" }, dashboardSender)).ok, true);
  assert.equal((await call({ type: "GET_STATE" }, {
    id: "test-id", url: "https://turo.com/us/en/trips/history", tab: { id: 1 }
  })).ok, false);
  assert.equal((await call({ type: "GET_STATE" }, {
    id: "test-id", url: "chrome-extension://test-id/options.html", tab: { id: 10 }
  })).ok, false);
  assert.equal((await call({ type: "GET_STATE" }, {
    id: "foreign-id", url: "chrome-extension://test-id/dashboard.html", tab: { id: 11 }
  })).ok, false);
});
test("worker collects both sources atomically and strips extra fields", async () => {
  const result = await call({ type: "RUN_SYNC" });
  assert.equal(result.ok, true);
  assert.equal(result.synced, true);
  assert.equal(result.state.sources.turo.records.length, 1);
  assert.equal(result.state.sources.ezpass.records.length, 1);
  assert.equal(result.state.sources.turo.records[0].guestName, undefined);
  assert.equal(result.state.sources.ezpass.records[0].accountNumber, undefined);
  assert.equal(result.state.reconciliation.matched.length, 1);
});
test("failed or multiple-tab collection preserves the prior snapshot", async () => {
  const before = JSON.stringify(stored);
  noEzpass = true;
  assert.equal((await call({ type: "RUN_SYNC" })).synced, false);
  noEzpass = false;
  doubleTuro = true;
  assert.equal((await call({ type: "RUN_SYNC" })).synced, false);
  doubleTuro = false;
  assert.equal(JSON.stringify(stored), before);
});
test("concurrent sync/settings updates are serialized without lost writes", async () => {
  const results = await Promise.all([
    call({ type: "RUN_SYNC" }),
    call({ type: "UPDATE_SETTINGS", settings: { graceMinutes: 15 } })
  ]);
  assert.ok(results.every((result) => result.ok));
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.settings.graceMinutes, 15);
  assert.equal(state.sources.ezpass.records.length, 1);
});
test("worker accepts Turo responses beyond the old five-second transport deadline", async () => {
  delayTuro = true;
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, true);
    assert.equal(result.state.reconciliation.matched.length, 1);
  } finally { delayTuro = false; }
});
test("a content-side hydration timeout preserves the complete previous snapshot", async () => {
  const before = JSON.stringify(stored);
  const prior = portalResponses[1];
  portalResponses[1] = { ok: false, source: "turo", error: "Timed out waiting for complete Turo trips." };
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, false);
    assert.match(result.collection.turo.error, /Timed out/);
    assert.equal(JSON.stringify(stored), before);
  } finally { portalResponses[1] = prior; }
});
test("invalid settings are rejected and clear resets persisted and page data", async () => {
  assert.equal((await call({ type: "UPDATE_SETTINGS", settings: { timeZone: "invalid" } })).ok, false);
  assert.equal((await call({ type: "UPDATE_SETTINGS", settings: { vehicleByTag: [] } })).ok, false);
  const result = await call({ type: "CLEAR_LOCAL_DATA" });
  assert.equal(result.resetFailures, 0);
  assert.equal(Object.keys(stored).length, 0);
  assert.equal(result.state.lastSync, null);
});

test("worker rejects other Turo pages and completed snapshots exclude prefetched future trips", async () => {
  turoUrl = "https://turo.com/us/en/trips/upcoming";
  assert.equal((await call({ type: "RUN_SYNC" })).synced, false);
  turoUrl = "https://turo.com/us/en/trips/history";
  const original = portalResponses[1].records;
  portalResponses[1].records = [...original, { ...original[0], id: "future", start: "2099-07-01 09:00", end: "2099-07-01 18:00" }];
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, true);
    assert.equal(result.state.sources.turo.records.length, 1);
    assert.match(result.collection.turo.warning, /excluded/);
  } finally { portalResponses[1].records = original; }
});
test("worker invalidates version-1 snapshots but migrates manual mappings", async () => {
  stored.turoTollReconcilerState = { version: 1, sources: { turo: { records: [{ id: "old" }] } },
    settings: { vehicleByTag: { "001": "car1" }, vehicleByPlate: {}, graceMinutes: 15 } };
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.version, 4);
  assert.equal(state.sources.turo.records.length, 0);
  assert.deepEqual(state.fleet.assignments.map(({ kind, identifier, vehicleId, validFrom, validTo }) =>
    ({ kind, identifier, vehicleId, validFrom, validTo })), [
    { kind: "tag", identifier: "001", vehicleId: "car1", validFrom: null, validTo: null }
  ]);
  assert.equal(state.lastSync, null);
});
test("dashboard drafts persist and dated assignments reject overlapping ownership", async () => {
  let result = await call({ type: "SAVE_UI_DRAFT", draft: { vehicleId: "car1", kind: "tag", identifier: "002", label: "Car one" } }, dashboardSender);
  assert.equal(result.state.uiDrafts.vehicleAssignment.identifier, "002");
  result = await call({ type: "UPSERT_ASSIGNMENT", assignment: {
    vehicleId: "car1", kind: "tag", identifier: "002", label: "Car one", validFrom: "2026-01-01", validTo: "2026-06-30"
  } }, dashboardSender);
  assert.equal(result.ok, true);
  assert.equal(result.state.fleet.assignments.find((assignment) => assignment.identifier === "002").canonicalIdentifier, "002");
  assert.equal(result.state.uiDrafts.vehicleAssignment.vehicleId, undefined);
  assert.equal(result.state.fleet.vehicles.find((vehicle) => vehicle.vehicleId === "car1").label, "Car one");
  const overlap = await call({ type: "UPSERT_ASSIGNMENT", assignment: {
    vehicleId: "car2", kind: "tag", identifier: "0-0-2", validFrom: "2026-06-01", validTo: "2026-12-31"
  } }, dashboardSender);
  assert.equal(overlap.ok, false);
  assert.match(overlap.error, /Overlapping tag/);
});
test("schema-4 assignments hydrate canonical values without clearing fleet data", async () => {
  stored.turoTollReconcilerState = {
    version: 4,
    sources: { turo: { records: portalResponses[1].records }, ezpass: { records: [] } },
    settings: { timeZone: "America/New_York", graceMinutes: 0 },
    fleet: { vehicles: [], assignments: [{ id: "plate1", kind: "plate", identifier: "NY:ABC-123", vehicleId: "car1", label: "", validFrom: null, validTo: null }] },
    uiDrafts: { vehicleAssignment: {} }, collectionRuns: {}, tripEligibility: {}, invoiceDrafts: [], evidence: [], submissionLedger: []
  };
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.fleet.assignments[0].canonicalIdentifier, "ABC123");
  assert.equal(state.fleet.vehicles[0].sourcePlateConfirmed, true);
  assert.equal(stored.turoTollReconcilerState.fleet.assignments[0].canonicalIdentifier, "ABC123");
});
test("schema-3 state migrates without treating its loaded page as complete", async () => {
  stored.turoTollReconcilerState = {
    version: 3,
    sources: { turo: { records: portalResponses[1].records, updatedAt: "prior" }, ezpass: { records: portalResponses[2].records, updatedAt: "prior" } },
    settings: { timeZone: "America/New_York", graceMinutes: 0 },
    fleet: { vehicles: [{ vehicleId: "car1", label: "Car one" }], assignments: [] },
    uiDrafts: { vehicleAssignment: {} }, evidence: [], submissionLedger: [], lastSync: "prior"
  };
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.version, 4);
  assert.equal(state.sources.turo.records.length, 1);
  assert.equal(state.collectionRuns.turo.complete, false);
  assert.equal(state.invoiceDrafts[0].eligibility, "status_unknown");
});
test("trip and toll selections persist only for complete eligible drafts", async () => {
  delete stored.turoTollReconcilerState;
  const oldTuro = portalResponses[1], oldEzpass = portalResponses[2];
  portalResponses[1] = { ...oldTuro, complete: true, pageCount: 2, records: oldTuro.records.map((item) => ({ ...item, invoiceStatus: "eligible_uncharged" })) };
  portalResponses[2] = { ...oldEzpass, complete: true, pageCount: 3, records: oldEzpass.records.map((item) => ({ ...item })) };
  try {
    let result = await call({ type: "RUN_SYNC" }, dashboardSender);
    assert.equal(result.state.invoiceDrafts[0].selectable, false, "vehicle identity must be confirmed");
    result = await call({ type: "UPSERT_ASSIGNMENT", assignment: { vehicleId: "car1", kind: "tag", identifier: "001" } }, dashboardSender);
    portalResponses[2].records[0].tagId = "001";
    result = await call({ type: "RUN_SYNC" }, dashboardSender);
    assert.equal(result.state.invoiceDrafts[0].selectable, true);
    result = await call({ type: "SET_TRIP_SELECTION", reservationId: "trip1", selected: true }, dashboardSender);
    assert.equal(result.state.selectionSummary.tripCount, 1);
    result = await call({ type: "SET_TOLL_SELECTION", reservationId: "trip1", tollId: "toll1", selected: false }, dashboardSender);
    assert.equal(result.state.selectionSummary.tripCount, 0);
  } finally { portalResponses[1] = oldTuro; portalResponses[2] = oldEzpass; }
});
test("worker rejects E-ZPass dashboard pages outside transaction activity", async () => {
  ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard";
  try { assert.equal((await call({ type: "RUN_SYNC" })).synced, false); }
  finally { ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard/transactions"; }
});
