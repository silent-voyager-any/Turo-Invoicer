import test from "node:test";
import assert from "node:assert/strict";

const stored = {};
let listener;
let noEzpass = false;
let doubleTuro = false;
let delayTuro = false;
let accessLevel;
const sentMessages = [];
let turoUrl = "https://turo.com/us/en/trips/history";
let ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
let managedUrl = null;
let managedEzpassUrl = null;
const navigatedEzpassUrls = [];
let inventoryFailuresRemaining = 0;
const existingTollInvoices = new Set();
const portalResponses = {
  1: { ok: true, source: "turo", complete: true, pagePath: "/us/en/trips/history", records: [{ id: "1001", vehicleId: "car1", start: "2026-07-01 09:00", end: "2026-07-01 18:00", vehicleLabel: "Example car", vehiclePlate: "NY:ABC-123", guestName: "Synthetic private field" }] },
  2: { ok: true, source: "ezpass", complete: true, completeForRange: true, collectorRevision: "0.5.12-trip-query-14", pagePath: "/ezpass/dashboard/transactions", records: [{ id: "toll1", timestamp: "2026-07-01 12:00", plaza: "Lincoln", amount: 10, tagOrPlate: "ABC123", queryId: "1001:plate:ABC123", queryReservationId: "1001", queryVehicleId: "car1", queryKind: "plate", queryIdentifier: "NY:ABC-123", accountNumber: "Synthetic private field" }] }
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
      sentMessages.push({ id, message: structuredClone(message) });
      if (message.type === "CLEAR_CAPTURE") return { ok: true };
      if (id === 90 && message.type === "COLLECT_INVOICE_STATUS") {
        const reservationId = String(message.reservationId);
        if (managedUrl.endsWith("/invoice-hub")) return { ok: true, phase: "hub", canCreate: true,
          invoiceUrls: existingTollInvoices.has(reservationId) ? [`https://turo.com/us/en/reservation/${reservationId}/reimbursement/invoice?invoiceId=9001`] : [] };
        if (managedUrl.includes("/reimbursement/invoice?")) return { ok: true, phase: "invoice", hasTolls: true };
        if (managedUrl.endsWith("/select-incidental")) return { ok: true, phase: "select", tollOptionAvailable: true };
      }
      if (id === 91 && message.type === "EZPASS_IDENTIFIER_INVENTORY") {
        if (inventoryFailuresRemaining > 0) {
          inventoryFailuresRemaining -= 1;
          return { ok: false, source: "ezpass", collectorRevision: portalResponses[2].collectorRevision,
            error: "Synthetic inventory hydration failure.", reason: "inventory_control_not_hydrated" };
        }
        const unavailable = new Set((portalResponses[2].queryReports || [])
          .filter((report) => report.status === "identifier_unavailable").map((report) => report.queryId));
        const queries = message.queryJobs?.length ? message.queryJobs : [
          { kind: "tag", identifier: "001", canonicalIdentifier: "001" },
          { kind: "plate", identifier: "NY:ABC-123", canonicalIdentifier: "ABC123" }
        ];
        return { ok: true, source: "ezpass", collectorRevision: portalResponses[2].collectorRevision,
          inventory: queries.filter((query) => !unavailable.has(query.queryId)).map((query) => ({
            kind: query.kind, identifier: query.identifier, canonicalIdentifier: query.canonicalIdentifier
          })) };
      }
      if (id === 91 && message.type === "COLLECT_EZPASS_QUERY") {
        const configured = portalResponses[2];
        if (configured.ok === false) return structuredClone(configured);
        const configuredReport = (configured.queryReports || []).find((report) => report.queryId === message.query.queryId);
        if (configured.complete === false && configuredReport?.status !== "complete") {
          return { ok: false, source: "ezpass", collectorRevision: configured.collectorRevision,
            error: "Synthetic direct query failure.", reason: configuredReport?.reason || "direct_query_failed" };
        }
        const records = (configured.records || []).filter((record) => record.queryId === message.query.queryId);
        const report = configuredReport || { queryId: message.query.queryId, reservationId: message.query.reservationId,
          kind: message.query.kind, pageCount: 1, rawCount: records.length, recordCount: records.length,
          complete: true, status: "complete" };
        return { ok: true, source: "ezpass", collectorRevision: configured.collectorRevision,
          pagePath: "/ezpass/dashboard/transactions", complete: true, completeForRange: true,
          pageCount: report.pageCount || 1, rawCount: report.rawCount ?? records.length,
          records: structuredClone(records), queryReports: [structuredClone(report)] };
      }
      if (id === 1 && delayTuro) await new Promise((resolve) => setTimeout(resolve, 5100));
      return structuredClone(portalResponses[id]);
    },
    create: async ({ url }) => {
      if (url.includes("e-zpassny.com")) { managedEzpassUrl = url; return { id: 91, url, status: "loading" }; }
      managedUrl = url; return { id: 90, url, status: "loading" };
    },
    update: async (id, changes) => {
      const url = changes.url || (id === 91 ? managedEzpassUrl : managedUrl);
      if (changes.url && id === 91) { managedEzpassUrl = url; navigatedEzpassUrls.push(url); } else if (changes.url) managedUrl = url;
      return { id, url, active: changes.active === true, status: "complete" };
    },
    get: async (id) => ({ id, url: id === 91 ? managedEzpassUrl : managedUrl, status: "complete" }),
    remove: async (id) => { if (id === 91) managedEzpassUrl = null; else managedUrl = null; }
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
  sentMessages.length = 0;
  navigatedEzpassUrls.length = 0;
  await call({ type: "UPSERT_ASSIGNMENT", assignment: { vehicleId: "car1", kind: "plate", identifier: "NY:ABC-123" } });
  const result = await call({ type: "RUN_SYNC" });
  assert.equal(result.ok, true);
  assert.equal(result.synced, true);
  assert.equal(result.state.sources.turo.records.length, 1);
  assert.equal(result.state.sources.ezpass.records.length, 1);
  assert.equal(result.state.sources.turo.records[0].guestName, undefined);
  assert.equal(result.state.sources.ezpass.records[0].accountNumber, undefined);
  assert.equal(result.state.reconciliation.matched.length, 1);
  assert.deepEqual(sentMessages.filter(({ message }) => message.type === "COLLECT_NOW").map(({ id }) => id), [1]);
  const inventory = sentMessages.find(({ id, message }) => id === 91 && message.type === "EZPASS_IDENTIFIER_INVENTORY");
  assert.ok(inventory);
  assert.deepEqual(inventory.message.queryJobs
    .map(({ reservationId, kind, canonicalIdentifier }) => [reservationId, kind, canonicalIdentifier]), [["1001", "plate", "ABC123"]]);
  const direct = sentMessages.find(({ id, message }) => id === 91 && message.type === "COLLECT_EZPASS_QUERY");
  assert.equal(direct.message.portalIdentifier, "NY:ABC-123");
  assert.ok(navigatedEzpassUrls.includes("https://www.e-zpassny.com/ezpass/dashboard/transactions?tagOrPlateNumber=NY%3AABC-123&transactionType=TOLL&endDate=07%2F01%2F2026&startDate=07%2F01%2F2026"));
  assert.equal(managedEzpassUrl, null, "temporary E-ZPass tab must be closed");
  assert.deepEqual(result.state.collectionRuns.ezpass.requestedRange, { startDate: "2026-07-01", endDate: "2026-07-01" });
});
test("worker retries inventory once before any direct query and always closes its temporary tab", async () => {
  sentMessages.length = 0;
  inventoryFailuresRemaining = 1;
  const result = await call({ type: "RUN_SYNC" });
  assert.equal(result.synced, true, JSON.stringify(result.collection));
  const inventoryIndexes = sentMessages.map(({ message }, index) => message.type === "EZPASS_IDENTIFIER_INVENTORY" ? index : -1)
    .filter((index) => index >= 0);
  const queryIndex = sentMessages.findIndex(({ message }) => message.type === "COLLECT_EZPASS_QUERY");
  assert.equal(inventoryIndexes.length, 2);
  assert.ok(queryIndex > inventoryIndexes[1]);
  assert.equal(managedEzpassUrl, null);

  sentMessages.length = 0;
  inventoryFailuresRemaining = 2;
  const failed = await call({ type: "RUN_SYNC" });
  assert.equal(failed.synced, false);
  assert.equal(sentMessages.filter(({ message }) => message.type === "EZPASS_IDENTIFIER_INVENTORY").length, 2);
  assert.equal(sentMessages.some(({ message }) => message.type === "COLLECT_EZPASS_QUERY"), false);
  assert.equal(managedEzpassUrl, null);
  inventoryFailuresRemaining = 0;
});
test("verified uncharged trips define the E-ZPass coverage boundary", async () => {
  const prior = portalResponses[1];
  sentMessages.length = 0;
  portalResponses[1] = { ...prior, records: [
    { ...prior.records[0], id: "1000", start: "2026-06-01 09:00", end: "2026-06-01 18:00" },
    { ...prior.records[0], id: "2000", start: "2026-07-15 09:00", end: "2026-07-16 18:00" }
  ] };
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, true, JSON.stringify(result.collection));
    const inventory = sentMessages.find(({ id, message }) => id === 91 && message.type === "EZPASS_IDENTIFIER_INVENTORY");
    assert.deepEqual(inventory.message.queryJobs.map(({ startDate, endDate }) => ({ startDate, endDate })),
      [{ startDate: "2026-07-15", endDate: "2026-07-16" }]);
    assert.equal(result.state.tripEligibility["1000"].reason, "standard_window_expired");
    assert.doesNotMatch(result.collection.turo.warning || "", /status is unverified/);
  } finally { portalResponses[1] = prior; }
});
test("existing Turo toll invoice is classified as already charged", async () => {
  existingTollInvoices.add("1001");
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, true);
    assert.equal(result.state.tripEligibility["1001"].status, "already_charged");
    assert.equal(result.state.tripEligibility["1001"].reason, "existing_toll_invoice");
    assert.equal(result.state.tripEligibility["1001"].adapterRevision, "0.4.7-invoice-dom-1");
    assert.equal(managedUrl, null, "temporary status tab must be closed");
  } finally { existingTollInvoices.delete("1001"); }
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
test("an unavailable configured tag is reported without discarding other collected trip results", async () => {
  const prior = portalResponses[2];
  const added = await call({ type: "UPSERT_ASSIGNMENT", assignment: { vehicleId: "car1", kind: "tag", identifier: "999" } });
  const addedId = added.state.fleet.assignments.find((assignment) => assignment.kind === "tag" && assignment.identifier === "999").id;
  portalResponses[2] = { ...prior, completeForRange: false, warning: "One configured E-ZPass identifier is unavailable.",
    queryReports: [
      { queryId: "1001:tag:999", reservationId: "1001", kind: "tag", status: "identifier_unavailable", complete: false },
      { queryId: "1001:plate:ABC123", reservationId: "1001", kind: "plate", status: "complete", complete: true, recordCount: 1 }
    ] };
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, true);
    assert.equal(result.state.sources.ezpass.records.length, 1);
    assert.equal(result.state.collectionRuns.ezpass.completeForRange, false);
    assert.ok(result.state.collectionRuns.ezpass.queryReports.some((report) => report.status === "identifier_unavailable"));
    assert.ok(result.state.invoiceDrafts.find((draft) => draft.reservationId === "1001")
      .blockingReasons.includes("identifier_unavailable"));
  } finally {
    portalResponses[2] = prior;
    await call({ type: "DELETE_ASSIGNMENT", id: addedId });
  }
});
test("partial trip searches retain the prior complete snapshot and reject unverified records", async () => {
  const completeBefore = (await call({ type: "RUN_SYNC" })).state;
  const priorTuro = portalResponses[1], priorEzpass = portalResponses[2];
  portalResponses[1] = { ...priorTuro, records: [priorTuro.records[0], { ...priorTuro.records[0], id: "1002",
    start: "2026-07-02 09:00", end: "2026-07-02 18:00" }] };
  portalResponses[2] = { ...priorEzpass, complete: false, completeForRange: false,
    queryReports: [
      { queryId: "1001:plate:ABC123", reservationId: "1001", kind: "plate", status: "complete", complete: true, recordCount: 1 },
      { queryId: "1002:plate:ABC123", reservationId: "1002", kind: "plate", status: "search_incomplete", complete: false, reason: "search_not_applied" }
    ] };
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, true, JSON.stringify(result.collection));
    assert.equal(result.state.collectionRuns.ezpass.complete, false);
    assert.equal(result.state.lastCompleteSnapshot.sources.ezpass.records.length, completeBefore.sources.ezpass.records.length);
    assert.equal(result.state.invoiceDrafts.find((draft) => draft.reservationId === "1001").selectable, true,
      JSON.stringify({ draft: result.state.invoiceDrafts.find((draft) => draft.reservationId === "1001"), reports: result.state.collectionRuns.ezpass.queryReports }));
    assert.ok(result.state.invoiceDrafts.find((draft) => draft.reservationId === "1002").blockingReasons.includes("search_incomplete"));
    portalResponses[2] = { ...portalResponses[2], complete: true, completeForRange: true,
      queryReports: portalResponses[2].queryReports.map((report) => ({ ...report, status: "complete", complete: true })),
      records: [{ ...priorEzpass.records[0], id: "bad", queryId: "1002:plate:ABC123" }] };
    const rejected = await call({ type: "RUN_SYNC" });
    assert.equal(rejected.synced, false);
    assert.equal(rejected.state.sources.ezpass.records[0].id, "toll1");
  } finally {
    portalResponses[1] = priorTuro; portalResponses[2] = priorEzpass;
    await call({ type: "RUN_SYNC" });
  }
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
  assert.equal(state.version, 7);
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
test("schema-5 state migrates without losing the synchronized snapshot", async () => {
  stored.turoTollReconcilerState = {
    version: 5,
    sources: { turo: { records: portalResponses[1].records, updatedAt: "prior" },
      ezpass: { records: portalResponses[2].records, updatedAt: "prior" } },
    settings: { timeZone: "America/New_York", graceMinutes: 0 },
    fleet: { vehicles: [{ vehicleId: "car1", label: "Car one" }], assignments: [] },
    uiDrafts: { vehicleAssignment: {} }, collectionRuns: {}, tripEligibility: {}, invoiceDrafts: [],
    selectionSummary: { tripCount: 0, tollCount: 0, totalCents: 0 }, evidence: [], submissionLedger: [], lastSync: "prior"
  };
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.version, 7);
  assert.equal(state.sources.turo.records.length, 1);
  assert.equal(state.sources.ezpass.records.length, 1);
  assert.equal(state.lastSync, "prior");
  assert.deepEqual(state.fleet.identifierInventory, { items: [], updatedAt: null });
});
test("identifier refresh persists sanitized inventory without changing synchronized records", async () => {
  const before = await call({ type: "GET_STATE" });
  const sources = structuredClone(before.state.sources);
  const result = await call({ type: "REFRESH_EZPASS_IDENTIFIERS" }, dashboardSender);
  assert.deepEqual(result.state.sources, sources);
  assert.deepEqual(result.inventory.items.map(({ kind, canonicalIdentifier }) => [kind, canonicalIdentifier]),
    [["plate", "ABC123"], ["tag", "001"]]);
  assert.ok(result.inventory.updatedAt);
  assert.equal(managedEzpassUrl, null, "temporary inventory tab closes");
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
  assert.equal(state.version, 7);
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
    Object.assign(portalResponses[2].records[0], { tagId: "001", tagOrPlate: "001",
      queryId: "1001:tag:001", queryKind: "tag", queryIdentifier: "001" });
    result = await call({ type: "RUN_SYNC" }, dashboardSender);
    assert.equal(result.state.invoiceDrafts[0].selectable, true);
    result = await call({ type: "SET_TRIP_SELECTION", reservationId: "1001", selected: true }, dashboardSender);
    assert.equal(result.state.selectionSummary.tripCount, 1);
    result = await call({ type: "SET_TOLL_SELECTION", reservationId: "1001", tollId: "toll1", selected: false }, dashboardSender);
    assert.equal(result.state.selectionSummary.tripCount, 0);
  } finally { portalResponses[1] = oldTuro; portalResponses[2] = oldEzpass; }
});
test("worker rejects E-ZPass dashboard pages outside transaction activity", async () => {
  ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard";
  try { assert.equal((await call({ type: "RUN_SYNC" })).synced, false); }
  finally { ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard/transactions"; }
});
test("worker identifies a stale E-ZPass content script before surfacing its old error", async () => {
  const prior = portalResponses[2];
  portalResponses[2] = { ok: false, source: "ezpass", error: "Old selector failure." };
  try {
    const result = await call({ type: "RUN_SYNC" });
    assert.equal(result.synced, false);
    assert.match(result.collection.ezpass.error, /older extension script.*Reload that transactions tab/i);
    assert.doesNotMatch(result.collection.ezpass.error, /Old selector/);
  } finally { portalResponses[2] = prior; }
});

test("schema-6 snapshot migrates without losing synced records or user selections", async () => {
  stored.turoTollReconcilerState = {
    version: 6, sources: { turo: { records: portalResponses[1].records, updatedAt: "prior" },
      ezpass: { records: portalResponses[2].records, updatedAt: "prior" } },
    settings: { timeZone: "America/New_York", graceMinutes: 0 },
    fleet: { vehicles: [{ vehicleId: "car1", label: "Car one" }], assignments: [],
      identifierInventory: { items: [], updatedAt: null } },
    uiDrafts: { vehicleAssignment: {} }, collectionRuns: {}, tripEligibility: {},
    invoiceDrafts: [{ reservationId: "1001", selected: false, batchSelectionTouched: true }],
    evidence: [], submissionLedger: [], lastSync: "prior"
  };
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.version, 7);
  assert.equal(state.sources.turo.records.length, 1);
  assert.equal(state.sources.ezpass.records.length, 1);
  assert.equal(state.lastSync, "prior");
  assert.deepEqual(state.fleet.hiddenVehicleIds, []);
  assert.deepEqual(state.settings.tripDateRange, { startDate: "", endDate: "" });
});

test("vehicle removal is reversible and keeps source records and assignments", async () => {
  const before = await call({ type: "GET_STATE" });
  const sources = structuredClone(before.state.sources);
  const removed = await call({ type: "HIDE_VEHICLE", vehicleId: "car1" }, dashboardSender);
  assert.deepEqual(removed.state.sources, sources);
  assert.deepEqual(removed.state.fleet.hiddenVehicleIds, ["car1"]);
  assert.equal(removed.state.invoiceDrafts.length, 0);
  const restored = await call({ type: "RESTORE_VEHICLE", vehicleId: "car1" }, dashboardSender);
  assert.equal(restored.state.invoiceDrafts.length, 1);
  assert.deepEqual(restored.state.sources, sources);
});

test("date settings validate inclusive boundaries without clearing cached records", async () => {
  const before = await call({ type: "GET_STATE" });
  const sources = structuredClone(before.state.sources);
  const outside = await call({ type: "UPDATE_SETTINGS", settings: {
    tripDateRange: { startDate: "2026-09-01", endDate: "2026-09-30" }
  } }, dashboardSender);
  assert.equal(outside.state.invoiceDrafts.length, 0);
  assert.deepEqual(outside.state.sources, sources);
  const inside = await call({ type: "UPDATE_SETTINGS", settings: {
    tripDateRange: { startDate: "2026-07-01", endDate: "2026-07-01" }
  } }, dashboardSender);
  assert.equal(inside.state.invoiceDrafts.length, 1);
  assert.equal((await call({ type: "UPDATE_SETTINGS", settings: {
    tripDateRange: { startDate: "2026-09-30", endDate: "2026-09-01" }
  } }, dashboardSender)).ok, false);
});

test("date-limited sync checks only in-range trip invoices and preserves older source records", async () => {
  delete stored.turoTollReconcilerState;
  const original = portalResponses[1];
  portalResponses[1] = { ...original, records: [
    original.records[0],
    { ...original.records[0], id: "1002", start: "2026-08-01 09:00", end: "2026-08-01 18:00" }
  ] };
  try {
    await call({ type: "UPDATE_SETTINGS", settings: {
      tripDateRange: { startDate: "2026-07-01", endDate: "2026-07-31" }
    } }, dashboardSender);
    const beforeMessages = sentMessages.length;
    const result = await call({ type: "RUN_SYNC" }, dashboardSender);
    assert.equal(result.synced, true);
    assert.equal(result.state.sources.turo.records.length, 2);
    assert.equal(result.state.invoiceDrafts.length, 1);
    const verified = sentMessages.slice(beforeMessages).filter(({ message }) => message.type === "COLLECT_INVOICE_STATUS");
    assert.ok(verified.length > 0);
    assert.ok(verified.every(({ message }) => String(message.reservationId) === "1001"));
    assert.equal(result.state.dateRangeNeedsSync, false);
  } finally { portalResponses[1] = original; }
});

test("unverified Turo send operations never write a sent ledger entry", async () => {
  const before = await call({ type: "GET_STATE" });
  const attempt = await call({ type: "SEND_APPROVED_BATCH" }, dashboardSender);
  assert.equal(attempt.ok, false);
  const after = await call({ type: "GET_STATE" });
  assert.deepEqual(after.state.submissionLedger, before.state.submissionLedger);
});

test("unverified E-ZPass pagination leaves the synchronized source snapshot unchanged", async () => {
  delete stored.turoTollReconcilerState;
  await call({ type: "UPSERT_ASSIGNMENT", assignment: {
    vehicleId: "car1", kind: "plate", identifier: "NY:ABC-123"
  } }, dashboardSender);
  const baseline = await call({ type: "RUN_SYNC" }, dashboardSender);
  assert.equal(baseline.synced, true);
  const prior = portalResponses[2];
  portalResponses[2] = { ...prior, complete: false, completeForRange: false, queryReports: [{
    queryId: "1001:plate:ABC123", reservationId: "1001", kind: "plate", status: "search_incomplete",
    complete: false, reason: "page_size_unverified"
  }] };
  try {
    const result = await call({ type: "RUN_SYNC" }, dashboardSender);
    assert.equal(result.synced, false);
    assert.match(result.collection.ezpass.error, /pagination could not be verified/);
    assert.deepEqual(result.state.sources, baseline.state.sources);
    assert.equal(result.state.lastSync, baseline.state.lastSync);
  } finally { portalResponses[2] = prior; }
});
