import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function environment() {
  const listeners = {};
  const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
  const document = {
    readyState: "loading", addEventListener() {}, querySelectorAll: () => []
  };
  const runtime = { id: "test-extension", onMessage: { addListener: (callback) => { listeners.runtime = callback; } } };
  const context = vm.createContext({
    window, document, location: { origin: "https://turo.com" }, chrome: { runtime },
    MutationObserver: class { observe() {} }, setTimeout, clearTimeout
  });
  vm.runInContext(readFileSync("content_common.js", "utf8"), context);
  return { context, listeners, window, document };
}

function adapter(file) {
  const env = environment();
  let adapter;
  env.context.TollCapture = {
    ...env.context.TollCapture,
    createCapture: (source, parse, readDom) => { adapter = { source, parse, readDom }; }
  };
  vm.runInContext(readFileSync(file, "utf8"), env.context);
  return { ...env, ...adapter };
}

test("E-ZPass adapter combines transaction date/time and discards extra fields", () => {
  const { parse } = adapter("content_ezpass.js");
  const record = parse({
    transactionId: "1", transactionDate: "07/01/2026", transactionTime: "12:30 PM",
    plazaName: "Lincoln", amount: "$15.00", tagNumber: "00123", vehicleId: "agency-only-id",
    accountBalance: 100, paymentDetails: { example: "must not persist" }
  });
  assert.equal(record.timestamp, "07/01/2026 12:30 PM");
  assert.equal(record.tagId, "00123");
  assert.equal(record.vehicleId, null);
  assert.equal(record.paymentDetails, undefined);
});
test("E-ZPass rejects posting dates and non-scalar amounts", () => {
  const { parse } = adapter("content_ezpass.js");
  assert.equal(parse({ postedAt: "2026-07-01T12:00Z", plaza: "Lincoln", amount: 10 }), null);
  assert.equal(parse({ timestamp: "2026-07-01T12:00Z", plaza: "Lincoln", amount: {} }), null);
});
test("Turo adapter keeps epochs, requires vehicle ID, and signals cancellations", () => {
  const { parse } = adapter("content_turo.js");
  assert.equal(parse({ id: "1", startTime: 1782921600, endTime: 1782925200, vehicle: { id: 20 } }).start, 1782921600);
  assert.equal(parse({ id: "1", start: "2026-07-01 12:00", end: "2026-07-01 13:00" }), null);
  assert.equal(parse({ id: "1", status: "CANCELED" })._remove, true);
});
test("DOM dataset fallback extracts toll rows", () => {
  const { document, readDom } = adapter("content_ezpass.js");
  document.querySelectorAll = () => [{
    dataset: { transactionId: "dom1", timestamp: "2026-07-01 12:00", plaza: "Lincoln", amount: "10" },
    querySelector: () => null, closest: () => null
  }];
  const values = [];
  readDom((value) => values.push(value));
  assert.equal(values[0].timestamp, "2026-07-01 12:00");
  assert.equal(values[0].transactionId, "dom1");
});
test("capture bridge ignores foreign messages, prioritizes API, and clears memory", () => {
  const { context, listeners, window } = environment();
  context.TollCapture.createCapture("turo", (value) => value.start ? { id: value.id, start: value.start } : null,
    (add) => add({ id: "dom", start: "dom-time" }));
  const event = { source: window, origin: "https://turo.com", data: {
    source: "turo-toll-reconciler-page", type: "NETWORK_RESPONSE", payload: { data: [{ id: "api", start: "api-time", secret: "synthetic" }] }
  } };
  listeners.message({ ...event, origin: "https://other.invalid" });
  let result;
  const collect = () => listeners.runtime({ type: "COLLECT_NOW" }, { id: "test-extension" }, (value) => { result = value; });
  collect();
  assert.equal(result.records[0].id, "dom");
  listeners.message(event);
  collect();
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "api");
  assert.equal(result.records[0].secret, undefined);
  listeners.runtime({ type: "CLEAR_CAPTURE" }, { id: "test-extension" }, () => {});
  listeners.message(event); // paused capture ignores late responses
  collect();
  assert.equal(result.records[0].id, "dom");
});
