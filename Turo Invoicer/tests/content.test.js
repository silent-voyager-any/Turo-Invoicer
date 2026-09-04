import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function environment(timers = { setTimeout, clearTimeout }) {
  const listeners = {};
  const observers = [];
  const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
  const document = {
    readyState: "loading", addEventListener() {}, querySelectorAll: () => []
  };
  const runtime = { id: "test-extension", onMessage: { addListener: (callback) => { listeners.runtime = callback; } } };
  const context = vm.createContext({
    window, document, URL, location: { origin: "https://turo.com", href: "https://turo.com/us/en/trips/history" }, chrome: { runtime },
    AbortController, TextDecoder,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; this.disconnected = false; }
      disconnect() { this.disconnected = true; }
    }, ...timers
  });
  vm.runInContext(readFileSync("content_common.js", "utf8"), context);
  vm.runInContext(readFileSync("turo_details.js", "utf8"), context);
  return { context, listeners, window, document, observers };
}

function adapter(file) {
  const env = environment();
  if (file === "content_ezpass.js") {
    env.context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
    env.context.location.origin = "https://www.e-zpassny.com";
  }
  let adapter;
  env.context.TollCapture = {
    ...env.context.TollCapture,
    createCapture: (source, parse, readDom, options) => { adapter = { source, parse, readDom, options }; }
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
    querySelector: () => null, querySelectorAll: () => [], closest: () => null
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

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    pending() { return timers.size; }
  };
}

function tripRow(dataset = {}) {
  return {
    dataset, querySelectorAll: () => [], querySelector: () => null,
    matches: () => false, closest: () => null
  };
}

function liveTuro() {
  const clock = fakeClock();
  const env = environment({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(readFileSync("content_turo.js", "utf8"), env.context);
  const answers = [];
  const collect = () => env.listeners.runtime({ type: "COLLECT_NOW" }, { id: "test-extension" }, (value) => answers.push(value));
  const rows = (values) => { env.document.querySelectorAll = (selector) => selector.startsWith("[data-trip-id]") ? values : []; };
  const mutate = () => env.observers[0].callback([]);
  return { ...env, clock, collect, answers, rows, mutate };
}
const completeTrip = () => tripRow({
  tripId: "101", vehicleId: "202", start: "2026-09-04 09:00", end: "2026-09-04 18:00"
});

test("Turo sync keeps its channel open until asynchronously inserted trips settle", () => {
  const env = liveTuro();
  assert.equal(env.collect(), true);
  env.clock.tick(6000); // Must outlast the previous worker's five-second timeout.
  assert.equal(env.answers.length, 0);
  env.rows([completeTrip()]);
  env.mutate();
  env.clock.tick(399);
  assert.equal(env.answers.length, 0);
  env.clock.tick(1);
  assert.equal(env.answers[0].records[0].id, "101");
  assert.equal(env.clock.pending(), 0);
});

test("attribute-only hydration waits for both trip times, not an empty card", () => {
  const env = liveTuro();
  const row = tripRow({ tripId: "101", vehicleId: "202" });
  env.rows([row]);
  env.collect();
  env.clock.tick(1000);
  assert.equal(env.answers.length, 0);
  assert.equal(env.observers[0].options.attributes, true);
  assert.ok(env.observers[0].options.attributeFilter.includes("data-end"));
  Object.assign(row.dataset, completeTrip().dataset);
  env.mutate();
  env.clock.tick(400);
  assert.equal(env.answers[0].records.length, 1);
});

test("an incoming network response also satisfies a pending Turo collection", () => {
  const env = liveTuro();
  env.collect();
  env.listeners.message({ source: env.window, origin: "https://turo.com", data: {
    source: "turo-toll-reconciler-page", type: "NETWORK_RESPONSE", pagePath: "/us/en/trips/history",
    payload: { trips: [{ id: "api-1", vehicleId: "202", start: "2026-09-04 09:00", end: "2026-09-04 18:00" }] }
  } });
  env.clock.tick(300);
  assert.equal(env.answers[0].records[0].id, "api-1");
  assert.equal(env.clock.pending(), 0);
});

test("Turo timeout returns an actionable error once, with no pending timers", () => {
  const env = liveTuro();
  env.collect();
  env.clock.tick(20000);
  assert.equal(env.answers[0].ok, false);
  assert.match(env.answers[0].error, /20 seconds/);
  assert.equal(env.answers[0].source, "turo");
  assert.equal(env.clock.pending(), 0);
  env.rows([completeTrip()]);
  env.mutate();
  env.clock.tick(1000);
  assert.equal(env.answers.length, 1);
});

test("clear and navigation cancel pending waits; back-forward restore reattaches observer", () => {
  const env = liveTuro();
  env.collect();
  env.listeners.runtime({ type: "CLEAR_CAPTURE" }, { id: "test-extension" }, () => {});
  assert.match(env.answers[0].error, /cleared/);
  env.collect();
  env.listeners.pagehide();
  assert.match(env.answers[1].error, /navigated/);
  assert.equal(env.clock.pending(), 0);
  assert.equal(env.observers[0].disconnected, true);
  env.listeners.pageshow();
  assert.equal(env.observers[0].disconnected, false);
});

test("concurrent collection requests each receive one response from the shared observer", () => {
  const env = liveTuro();
  env.collect();
  env.collect();
  env.rows([completeTrip()]);
  env.mutate();
  env.clock.tick(400);
  assert.equal(env.answers.length, 2);
  assert.ok(env.answers.every((answer) => answer.records.length === 1));
  assert.equal(env.observers.length, 1);
  assert.equal(env.clock.pending(), 0);
});

test("settling includes a later card without unrelated DOM churn starving the reply", () => {
  const env = liveTuro();
  env.rows([completeTrip()]);
  env.collect();
  env.clock.tick(100);
  const second = completeTrip();
  second.dataset.tripId = "102";
  env.rows([completeTrip(), second]);
  env.mutate();
  env.clock.tick(100); // The changed batch restarts the 300 ms settle timer.
  env.mutate();
  env.clock.tick(299); // Unchanged data from this mutation does not restart it.
  assert.equal(env.answers.length, 0);
  env.clock.tick(1);
  assert.equal(env.answers[0].records.length, 2);
});

test("host trip link cards extract their own trip ID and rental-link vehicle ID", () => {
  const { document, readDom, parse } = adapter("content_turo.js");
  const row = tripRow();
  row.getAttribute = () => "/us/en/host/trips/101";
  row.matches = () => true;
  row.querySelectorAll = (selector) => selector === "time[datetime]"
    ? [{ dateTime: "2026-09-04 09:00" }, { dateTime: "2026-09-04 18:00" }]
    : selector.includes("-rental/") ? [{ getAttribute: () => "/us/en/car-rental/united-states/new-york-ny/toyota/camry/202" }] : [];
  document.querySelectorAll = (selector) => selector.startsWith("[data-trip-id]") ? [] : [row];
  const records = [];
  readDom((candidate) => records.push(parse(candidate)));
  assert.equal(records[0].id, "101");
  assert.equal(records[0].vehicleId, "202");
});

test("a container with links to multiple trips cannot mix their fields", () => {
  const { document, readDom } = adapter("content_turo.js");
  const row = completeTrip();
  row.querySelectorAll = (selector) => selector.includes('/host/trips/')
    ? ["101", "102"].map((id) => ({ getAttribute: () => "/us/en/host/trips/" + id })) : [];
  document.querySelectorAll = (selector) => selector.startsWith("[data-trip-id]") ? [row] : [];
  let count = 0;
  readDom(() => { count += 1; });
  assert.equal(count, 0);
});

test("Turo refuses collection off history and never reads those DOM rows", () => {
  const env = liveTuro();
  env.context.location.href = "https://turo.com/us/en/trips/upcoming";
  env.document.querySelectorAll = () => { throw new Error("Off-history DOM must not be read"); };
  assert.equal(env.collect(), false);
  assert.equal(env.answers[0].ok, false);
  assert.match(env.answers[0].error, /restricted/);
});
test("leaving history clears captured data and cancels pending collection", () => {
  const env = liveTuro();
  env.rows([completeTrip()]);
  env.collect();
  env.context.location.href = "https://turo.com/us/en/trips/upcoming";
  env.mutate();
  env.clock.tick(100);
  assert.equal(env.answers[0].ok, false);
  env.context.location.href = "https://turo.com/us/en/trips/history";
  env.rows([]);
  env.collect();
  env.clock.tick(20000);
  assert.equal(env.answers[1].ok, false);
});
test("Turo rejects network data without history provenance", () => {
  const env = liveTuro();
  env.collect();
  env.listeners.message({ source: env.window, origin: "https://turo.com", data: {
    source: "turo-toll-reconciler-page", type: "NETWORK_RESPONSE", pagePath: "/us/en/trips/upcoming",
    payload: { trips: [{ id: "wrong", vehicleId: "202", start: "2026-01-01 09:00", end: "2026-01-01 18:00" }] }
  } });
  env.clock.tick(20000);
  assert.equal(env.answers[0].ok, false);
});

function transactionRow(headers, values, variant = "table") {
  const node = (text, attributes = {}) => ({ textContent: text, getAttribute: (key) => attributes[key] || null });
  const headerNodes = headers.map((label) => node(label));
  const cells = values.map((value, index) => node(value, variant === "mobile" ? { "data-label": headers[index] } : {}));
  const container = {
    querySelectorAll: () => variant === "legacy" ? [] : headerNodes,
    querySelector: () => ({ querySelectorAll: () => headerNodes })
  };
  return {
    dataset: {}, closest: () => variant === "mobile" ? null : container,
    querySelectorAll: () => cells, querySelector: () => null
  };
}

for (const variant of ["table", "legacy", "grid", "mobile"]) {
  test(`E-ZPass ${variant} extracts transaction datetime, toll amount and mixed tag/plate`, () => {
    const { document, readDom, parse } = adapter("content_ezpass.js");
    const row = transactionRow(
      ["Posted Date", "Transaction Date & Time", "Exit Plaza", "Toll Amount", "Tag # / Plate #"],
      ["09/06/2026", "09/04/2026 12:30 PM", "Lincoln", "$15.00", "0012345678"], variant
    );
    document.querySelectorAll = () => [row];
    const records = [];
    readDom((candidate) => records.push(parse(candidate)));
    assert.equal(records[0].timestamp, "09/04/2026 12:30 PM");
    assert.equal(records[0].amount, "$15.00");
    assert.equal(records[0].tagOrPlate, "0012345678");
    assert.equal(records[0].tagId, null);
  });
}
test("E-ZPass rejects posted-only and payment rows", () => {
  const { document, readDom, parse } = adapter("content_ezpass.js");
  document.querySelectorAll = () => [transactionRow(["Posted Date", "Amount", "Description"], ["09/04/2026 12:00", "15.00", "Example"]),
    transactionRow(["Transaction Date/Time", "Amount", "Description", "Type"], ["09/04/2026 12:00", "15.00", "Deposit", "Payment"])];
  const records = [];
  readDom((candidate) => { const result = parse(candidate); if (result) records.push(result); });
  assert.equal(records.length, 0);
});
test("E-ZPass normalizes snake-case aliases and combines separate date/time columns", () => {
  const { parse, document, readDom } = adapter("content_ezpass.js");
  assert.equal(parse({ transaction_date: "09/04/2026", transaction_time: "12:30 PM", exit_plaza: { name: "Lincoln" }, toll_amount: "15.00" }).timestamp,
    "09/04/2026 12:30 PM");
  document.querySelectorAll = () => [transactionRow(["Transaction Date", "Transaction Time", "Plaza", "Amount"],
    ["09/04/2026", "12:30 PM", "Lincoln", "15.00"])];
  readDom((candidate) => assert.equal(parse(candidate).timestamp, "09/04/2026 12:30 PM"));
});
test("E-ZPass waits for asynchronously loaded transaction rows on its exact data route", () => {
  const clock = fakeClock();
  const env = environment({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  env.context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
  env.context.location.origin = "https://www.e-zpassny.com";
  vm.runInContext(readFileSync("content_ezpass.js", "utf8"), env.context);
  const answers = [];
  assert.equal(env.listeners.runtime({ type: "COLLECT_NOW" }, { id: "test-extension" }, (value) => answers.push(value)), true);
  clock.tick(6000);
  assert.equal(answers.length, 0);
  env.document.querySelectorAll = () => [transactionRow(["Transaction Date/Time", "Plaza", "Amount"], ["09/04/2026 12:30 PM", "Lincoln", "15.00"])];
  env.observers[0].callback([]);
  clock.tick(400);
  assert.equal(answers[0].records.length, 1);
  assert.equal(answers[0].pagePath, "/ezpass/dashboard/transactions");
});

// Synthetic link-wrapped card: intentionally no guest identity, images, year,
// exact clocks, or vehicle ID. Those fields must come from reservation details.
function historyCard(id = "900001") {
  const row = tripRow();
  row.getAttribute = (key) => key === "href" ? `/us/en/reservation/${id}` : null;
  row.matches = (selector) => selector.includes('/reservation/');
  row.textContent = "Aug 27 - Aug 30 Example Sedan 2020 TEST001";
  return row;
}
const detailRecord = (id = "900001") => ({
  reservationId: id, vehicle: { id: "800001" },
  startDateTime: "2026-08-27T10:00:00-04:00", endDateTime: "2026-08-30T15:00:00-04:00"
});
const jsonRoot = (...payloads) => ({
  querySelectorAll: (selector) => selector.startsWith("script")
    ? payloads.map((payload) => ({ textContent: typeof payload === "string" ? payload : JSON.stringify(payload) })) : []
});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function detailEnvironment(ids = ["900001"]) {
  const env = liveTuro();
  const cards = ids.map(historyCard);
  env.document.querySelectorAll = () => cards;
  const requested = [];
  const roots = new Map();
  env.document.createElement = (tag) => {
    assert.equal(tag, "template");
    return { set innerHTML(value) { this.content = roots.get(value) || jsonRoot(); } };
  };
  env.context.fetch = async (url, options) => {
    requested.push({ url, options });
    const id = url.split("/").pop();
    const marker = `synthetic-html-${id}`;
    roots.set(marker, jsonRoot({ props: { pageProps: { reservation: detailRecord(id) } } }));
    const response = new Response(marker, { headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { ...env, requested, roots };
}

test("baseTripCard discovery enriches only its reservation during explicit sync", async () => {
  const env = detailEnvironment();
  env.mutate();
  env.clock.tick(100);
  assert.equal(env.requested.length, 0); // No passive browsing requests.
  env.collect();
  assert.equal(env.answers.length, 0);
  await flush();
  env.clock.tick(300);
  assert.equal(env.answers[0].ok, true);
  assert.equal(env.answers[0].records[0].id, "900001");
  assert.equal(env.answers[0].records[0].vehicleId, "800001");
  assert.equal(env.answers[0].records[0].start, detailRecord().startDateTime);
  assert.equal(env.requested.length, 1);
  assert.equal(env.requested[0].url, "https://turo.com/us/en/reservation/900001");
  assert.equal(env.requested[0].options.credentials, "same-origin");
  assert.equal(env.requested[0].options.redirect, "error");
  assert.equal(env.requested[0].options.method, "GET");
  assert.equal(env.clock.pending(), 0);
});

test("reservation URL allowlist strips query and rejects off-origin and non-detail targets", () => {
  const { context } = environment();
  const { reservationLink } = context.TuroDetails;
  assert.equal(reservationLink("/us/en/reservation/900001?private=example#info").url,
    "https://turo.com/us/en/reservation/900001");
  for (const url of ["https://evil.invalid/us/en/reservation/900001", "//www.turo.com/us/en/reservation/900001",
    "/us/en/reservation/900001/cancel", "/us/en/trips/upcoming", "javascript:alert(1)",
    "https://name:password@turo.com/us/en/reservation/900001", "/api/reservations/900001"]) {
    assert.equal(reservationLink(url), null, url);
  }
});

test("detail parsing requires the linked ID and full clocks, rejecting conflicts and malformed JSON", () => {
  const env = adapter("content_turo.js");
  const parse = (root) => env.context.TuroDetails.parseDocument(root, "900001", env.parse, () => {});
  assert.equal(parse(jsonRoot("not JSON", detailRecord("900002"))), null);
  assert.equal(parse(jsonRoot({ ...detailRecord(), startDateTime: "Aug 27 - Aug 30" })), null);
  assert.equal(parse(jsonRoot({ ...detailRecord(), startDateTime: "2026-08-27" })), null);
  assert.throws(() => parse(jsonRoot(detailRecord(), { ...detailRecord(), vehicle: { id: "other" } })), /conflicting/);
  assert.equal(parse(jsonRoot({ reservationId: "900001", status: "CANCELED" }))._remove, true);
  const record = parse(jsonRoot({ ...detailRecord(), guest: "synthetic-private", paymentDetails: {} }));
  assert.equal(record.guest, undefined);
  assert.equal(record.paymentDetails, undefined);
});

test("details support semantic HTML without inferring year/time from history labels", () => {
  const env = adapter("content_turo.js");
  const main = completeTrip();
  main.dataset = { vehicleId: "800001", start: detailRecord().startDateTime, end: detailRecord().endDateTime };
  const root = { querySelectorAll: (selector) => selector === "main" ? [main] : [] };
  assert.equal(env.context.TuroDetails.parseDocument(root, "900001", env.parse, env.readDom).id, "900001");
  const values = [];
  const card = historyCard();
  env.document.querySelectorAll = () => [card];
  env.readDom((value) => values.push(env.parse(value)));
  assert.deepEqual(values, [null]);
});

test("an app-shell response fails explicitly instead of guessing trip boundaries", async () => {
  const env = detailEnvironment();
  env.document.createElement = () => ({ content: jsonRoot(), set innerHTML(_value) {} });
  env.collect();
  await flush();
  assert.equal(env.answers[0].ok, false);
  assert.match(env.answers[0].error, /app shell/);
  assert.equal(env.clock.pending(), 0);
});

test("detail pool caps concurrency at three and waits for every loaded card", async () => {
  const env = detailEnvironment(["900001", "900002", "900003", "900004"]);
  const original = env.context.fetch;
  const releases = [];
  env.context.fetch = (url, options) => new Promise((resolve) => {
    releases.push(async () => resolve(await original(url, options)));
  });
  env.collect();
  assert.equal(releases.length, 3);
  await releases[0]();
  await flush();
  assert.equal(releases.length, 4);
  env.clock.tick(300);
  assert.equal(env.answers.length, 0);
  for (const release of releases.slice(1)) await release();
  await flush();
  env.clock.tick(300);
  assert.equal(env.answers[0].records.length, 4);
});

for (const action of ["clear", "pagehide", "route", "timeout"]) {
  test(`pending reservation reads abort on ${action} and never reply twice`, async () => {
    const env = detailEnvironment();
    let signal;
    env.context.fetch = (_url, options) => { signal = options.signal; return new Promise(() => {}); };
    env.collect();
    if (action === "clear") env.listeners.runtime({ type: "CLEAR_CAPTURE" }, { id: "test-extension" }, () => {});
    if (action === "pagehide") env.listeners.pagehide();
    if (action === "route") {
      env.context.location.href = "https://turo.com/us/en/trips/upcoming";
      env.mutate();
      env.clock.tick(100);
    }
    if (action === "timeout") env.clock.tick(20000);
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal(env.answers.length, 1);
    assert.equal(env.answers[0].ok, false);
    env.clock.tick(20000);
    assert.equal(env.answers.length, 1);
  });
}

test("oversized detail responses and HTTP failures fail the whole collection", async () => {
  for (const scenario of ["large", "stream", "http", "redirect"]) {
    const env = detailEnvironment();
    env.context.fetch = async (url) => {
      if (scenario === "redirect") throw new TypeError("fetch failed");
      const response = new Response(scenario === "stream" ? "x".repeat(2000001) : "synthetic", {
        status: scenario === "http" ? 403 : 200,
        headers: { "content-type": "text/html", "content-length": scenario === "large" ? "2000001" : "9" }
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    env.collect();
    await flush();
    assert.equal(env.answers[0].ok, false, scenario);
    assert.equal(env.answers[0].records, undefined);
  }
});

test("complete history network records avoid extra GETs and exclude unrelated IDs", async () => {
  const env = detailEnvironment();
  env.listeners.message({ source: env.window, origin: "https://turo.com", data: {
    source: "turo-toll-reconciler-page", type: "NETWORK_RESPONSE", pagePath: "/us/en/trips/history",
    payload: { reservations: [detailRecord(), detailRecord("900099")] }
  } });
  env.collect();
  env.clock.tick(300);
  assert.equal(env.answers[0].records.length, 1);
  assert.equal(env.answers[0].records[0].id, "900001");
  assert.equal(env.requested.length, 0);
  const crowded = detailEnvironment(Array.from({ length: 51 }, (_, i) => String(900000 + i)));
  crowded.collect();
  assert.equal(crowded.answers[0].ok, false);
  assert.match(crowded.answers[0].error, /50 history/);
  assert.equal(crowded.requested.length, 0);
});
