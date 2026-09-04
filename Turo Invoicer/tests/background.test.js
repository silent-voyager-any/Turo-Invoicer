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
  1: { ok: true, source: "turo", pagePath: "/us/en/trips/history", records: [{ id: "trip1", vehicleId: "car1", start: "2026-07-01 09:00", end: "2026-07-01 18:00", guestName: "Synthetic private field" }] },
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
const call = (message, from = sender) => new Promise((resolve) => listener(message, from, resolve));

test("worker restricts storage and rejects content-script privileged actions", async () => {
  assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  assert.equal((await call({ type: "RUN_SYNC" }, { ...sender, tab: { id: 1 } })).ok, false);
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
    call({ type: "UPDATE_SETTINGS", settings: { graceMinutes: 15, vehicleByTag: { "001": "car1" } } })
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
test("worker invalidates old snapshots but retains manual mappings", async () => {
  stored.turoTollReconcilerState = { version: 1, sources: { turo: { records: [{ id: "old" }] } },
    settings: { vehicleByTag: { "001": "car1" }, vehicleByPlate: {}, graceMinutes: 15 } };
  const { state } = await call({ type: "GET_STATE" });
  assert.equal(state.version, 2);
  assert.equal(state.sources.turo.records.length, 0);
  assert.equal(state.settings.vehicleByTag["001"], "car1");
  assert.equal(state.lastSync, null);
});
test("worker rejects E-ZPass dashboard pages outside transaction activity", async () => {
  ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard";
  try { assert.equal((await call({ type: "RUN_SYNC" })).synced, false); }
  finally { ezpassUrl = "https://www.e-zpassny.com/ezpass/dashboard/transactions"; }
});
