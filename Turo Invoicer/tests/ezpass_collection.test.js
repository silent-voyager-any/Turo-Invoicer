import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const context = vm.createContext({
  Date, URL, location: { href: "https://www.e-zpassny.com/ezpass/dashboard/transactions" },
  document: { querySelectorAll: () => [], querySelector: () => null, body: { textContent: "" } },
  setTimeout, clearTimeout
});
vm.runInContext(readFileSync("ezpass_collection.js", "utf8"), context);
const api = context.EzpassCollection;
const clone = (value) => JSON.parse(JSON.stringify(value));

test("validates the worker's E-ZPass date-range contract", () => {
  assert.deepEqual(clone(api.validateRange({ startDate: "2026-08-01", endDate: "2026-08-31" })),
    { startDate: "2026-08-01", endDate: "2026-08-31" });
  assert.throws(() => api.validateRange({ startDate: "2026-08-31", endDate: "2026-08-01" }), /valid/);
  assert.throws(() => api.validateRange({ startDate: "2026-02-30", endDate: "2026-03-01" }), /valid/);
});

test("validates exact trip-first identifier queries", () => {
  const queries = [{ queryId: "1001:tag:00123", reservationId: "1001", vehicleId: "car1",
    kind: "tag", identifier: "00-123", canonicalIdentifier: "00123", startDate: "2026-08-01", endDate: "2026-08-02" }];
  assert.equal(api.validateQueries(queries).length, 1);
  assert.throws(() => api.validateQueries([{ ...queries[0], canonicalIdentifier: "00*123" }]), /invalid trip query/);
  assert.throws(() => api.validateQueries([{ ...queries[0], reservationId: "trip" }]), /invalid trip query/);
});

test("normalizes portal timestamps into sortable local keys", () => {
  assert.equal(api.testing.localTimestampKey("09/05/2026 13:11:16.090"), "20260905131116");
  assert.equal(api.testing.localTimestampKey("9/5/26 1:11:16 PM"), "20260905131116");
  assert.equal(api.testing.localTimestampKey("2026-09-05T13:11:16"), "20260905131116");
  assert.equal(api.testing.localTimestampKey("not a date"), null);
  assert.equal(api.testing.localTimestampKey("2026-99-99T13:11:16"), null);
  assert.equal(api.testing.localTimestampKey("09/05/2026 13:11 PM"), null);
});

const visibleElement = (properties = {}) => ({
  hidden: false,
  get offsetParent() { return {}; },
  getClientRects: () => ({ length: 1 }),
  getAttribute(name) { return this.attributes?.[name] ?? null; },
  ...properties
});

function labelledFilterFixture({ duplicateType = false, omitType = false, omitIdentifier = false } = {}) {
  const label = (textContent, htmlFor = "") => ({ textContent, htmlFor });
  const startLabel = label("Start Date"), endLabel = label("End Date");
  const typeLabel = label("Type", "type-control"), identifierLabel = label("Tag/Plate #", "identifier-control");
  const start = visibleElement({ value: "08/01/26", labels: [startLabel] });
  const end = visibleElement({ value: "08/02/26", labels: [endLabel] });
  const type = visibleElement({ id: "type-control", value: "All", labels: [typeLabel] });
  const identifier = visibleElement({ id: "identifier-control", value: "All tags", labels: [identifierLabel] });
  const view = visibleElement({ textContent: "10", attributes: { "aria-label": "View" } });
  const hiddenType = visibleElement({ id: "hidden-type", labels: [typeLabel], hidden: true, offsetParent: null,
    getClientRects: () => ({ length: 0 }) });
  const secondType = visibleElement({ id: "second-type", labels: [typeLabel] });
  const search = visibleElement({ textContent: "Search" });
  const combos = [...(omitType ? [] : [type]), ...(duplicateType ? [secondType] : []),
    ...(omitIdentifier ? [] : [identifier]), view, hiddenType];
  const root = {
    parentElement: null,
    contains: (node) => [start, end, ...combos, search].includes(node),
    querySelectorAll(selector) {
      if (selector === '[role="combobox"]') return combos;
      if (selector === "button, [role='button'], input[type='submit'], input[type='button']") return [search];
      if (selector === "input") return [start, end, type, identifier];
      if (selector === '[role="combobox"][aria-label="View"]') return [view];
      return [];
    }
  };
  start.parentElement = root;
  end.parentElement = root;
  const labels = [startLabel, endLabel, typeLabel, identifierLabel];
  context.document = {
    body: { textContent: "" },
    querySelector: (selector) => selector === "main, [role='main']" ? root : null,
    querySelectorAll: (selector) => selector === "label" ? labels : root.querySelectorAll(selector),
    getElementById: () => null
  };
  return { start, end, type, identifier, view, root };
}

test("resolves combobox names from standard accessible label relationships", () => {
  const native = visibleElement({ labels: [{ textContent: "Type" }] });
  assert.equal(api.testing.accessibleControlName(native), "Type");

  context.document = { ...context.document, getElementById: (id) => id === "tag-label" ? { textContent: "Tag/Plate #" } : null };
  const labelledBy = visibleElement({ attributes: { "aria-labelledby": "tag-label" } });
  assert.equal(api.testing.accessibleControlName(labelledBy), "Tag/Plate #");

  const direct = visibleElement({ attributes: { "aria-label": "View", "aria-labelledby": "tag-label" } });
  assert.equal(api.testing.accessibleControlName(direct), "View");

  context.document = { ...context.document,
    querySelectorAll: (selector) => selector === "label" ? [{ htmlFor: "legacy-type", textContent: "Type" }] : [] };
  const labelFor = visibleElement({ id: "legacy-type", labels: [] });
  assert.equal(api.testing.accessibleControlName(labelFor), "Type");
});

test("scopes Type and Tag/Plate controls to their shared transaction filter", () => {
  const fixture = labelledFilterFixture();
  const filters = api.testing.transactionFilterControls([fixture.start, fixture.end]);
  assert.equal(filters.type, fixture.type);
  assert.equal(filters.identifier, fixture.identifier);
  assert.notEqual(filters.type, fixture.view);
  assert.deepEqual(clone(api.testing.snapshotFilters()), {
    startDate: "2026-08-01", endDate: "2026-08-02", type: "All", identifier: "All tags", view: "10"
  });
});

test("distinguishes duplicate and missing labelled filter controls", () => {
  let fixture = labelledFilterFixture({ duplicateType: true });
  assert.throws(() => api.testing.transactionFilterControls([fixture.start, fixture.end]), /multiple Type controls/);
  fixture = labelledFilterFixture({ omitType: true });
  assert.throws(() => api.testing.transactionFilterControls([fixture.start, fixture.end]), /Type filter was not found/);
  fixture = labelledFilterFixture({ omitIdentifier: true });
  assert.throws(() => api.testing.transactionFilterControls([fixture.start, fixture.end]), /Tag\/Plate # filter was not found/);
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

function calendarFixture({ year = 2026, month = 9, delayMs = 180, stall = false, skip = false } = {}) {
  let shown = { year, month };
  let dialog = null;
  let open = false;
  let dialogBuilds = 0;
  let navClicks = 0;
  const localTimestamp = (day) => new Date(shown.year, shown.month - 1, day).getTime();
  const formattedInput = (day) => `${String(shown.month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(shown.year).slice(-2)}`;
  const input = visibleElement({ value: "", labels: [{ textContent: "Start Date" }] });
  const main = { querySelectorAll: () => [] };

  const buildDialog = () => {
    dialogBuilds += 1;
    const heading = { textContent: `${MONTHS[shown.month - 1]} ${shown.year}`, getAttribute: () => null };
    const shift = (direction) => {
      navClicks += 1;
      if (stall) return;
      setTimeout(() => {
        const date = new Date(Date.UTC(shown.year, shown.month - 1 + direction * (skip ? 2 : 1), 1));
        shown = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
        dialog = buildDialog();
      }, delayMs);
    };
    const navigation = (ariaLabel, direction) => visibleElement({ textContent: "",
      attributes: { "aria-label": ariaLabel }, click: () => shift(direction) });
    const days = Array.from({ length: new Date(Date.UTC(shown.year, shown.month, 0)).getUTCDate() }, (_, index) => {
      const day = index + 1;
      return visibleElement({ textContent: String(day), attributes: { role: "gridcell", "data-timestamp": String(localTimestamp(day)) },
        click: () => { input.value = formattedInput(day); open = false; } });
    });
    const controls = [navigation("Previous month", -1), navigation("Next month", 1), ...days];
    return visibleElement({
      querySelectorAll(selector) {
        if (selector === "*") return [heading, ...days];
        if (selector === "button, [role='button'], input[type='submit'], input[type='button']" ||
            selector === 'button, [role="button"], [role="gridcell"], [data-timestamp]') return controls;
        return [];
      }
    });
  };
  const picker = visibleElement({ textContent: "Choose date", click: () => { open = true; dialog = buildDialog(); } });
  const field = {
    parentElement: main,
    querySelectorAll: (selector) => selector === "button, [role='button'], input[type='submit'], input[type='button']" ? [picker] : []
  };
  input.parentElement = field;
  context.document = {
    body: { textContent: "" },
    querySelector: (selector) => selector === "main, [role='main']" ? main : null,
    querySelectorAll: (selector) => selector === '[role="dialog"]' && open ? [dialog] : []
  };
  return { input, get dialogBuilds() { return dialogBuilds; }, get navClicks() { return navClicks; } };
}

test("calendar waits for delayed month hydration and reacquires replaced dialogs", async () => {
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
  const fixture = calendarFixture({ month: 9, delayMs: 180 });
  await api.testing.setCalendarDate(fixture.input, "2026-07-31");
  assert.equal(fixture.input.value, "07/31/26");
  assert.equal(fixture.navClicks, 2);
  assert.ok(fixture.dialogBuilds >= 3);
});

test("calendar day selection uses the complete timestamp-backed date", () => {
  const day = (year, month, date) => visibleElement({ textContent: String(date),
    attributes: { role: "gridcell", "data-timestamp": String(new Date(year, month - 1, date).getTime()) } });
  const correct = day(2026, 7, 31), adjacent = day(2026, 8, 31);
  const heading = { textContent: "July 2026", getAttribute: () => null };
  const dialog = { querySelectorAll: (selector) => selector === "*" ? [heading, correct, adjacent] : [correct, adjacent] };
  assert.equal(api.testing.calendarDayControl(dialog, { year: 2026, month: 7, day: 31 }), correct);

  const duplicate = day(2026, 7, 31);
  const ambiguous = { querySelectorAll: (selector) => selector === "*" ? [heading, correct, duplicate] : [correct, duplicate] };
  assert.throws(() => api.testing.calendarDayControl(ambiguous, { year: 2026, month: 7, day: 31 }), /multiple matching full-date/);

  const missing = { querySelectorAll: (selector) => selector === "*" ? [heading, adjacent] : [adjacent] };
  assert.throws(() => api.testing.calendarDayControl(missing, { year: 2026, month: 7, day: 31 }), /full-date.*not found/);

  const fallbackDay = visibleElement({ textContent: "31" });
  const fallback = { querySelectorAll: (selector) => selector === "*" ? [heading, fallbackDay] : [fallbackDay] };
  assert.equal(api.testing.calendarDayControl(fallback, { year: 2026, month: 7, day: 31 }), fallbackDay);
});

test("calendar navigation rejects skipped and stalled months", async () => {
  let fixture = calendarFixture({ month: 9, delayMs: 20, skip: true });
  await assert.rejects(api.testing.setCalendarDate(fixture.input, "2026-08-30"), /skipped the expected month/);
  fixture = calendarFixture({ month: 9, stall: true });
  await assert.rejects(api.testing.setCalendarDate(fixture.input, "2026-08-30"), /navigation stalled/);
});

test("proves descending page chronology and rejects boundary reversals", () => {
  const first = api.testing.pageChronology({ raw: [
    { timestamp: "09/05/2026 1:00 PM" }, { timestamp: "09/04/2026 1:00 PM" }
  ] });
  assert.equal(first.descending, true);
  const second = api.testing.pageChronology({ raw: [{ timestamp: "09/06/2026 1:00 PM" }] }, first.oldest);
  assert.equal(second.descending, false);
  assert.equal(api.testing.pageChronology({ raw: [{ timestamp: "bad" }] }).complete, false);
});

function portalFixture({ pages, startPage = 0, activeFilter = false, descendingSort = true,
  repeatNext = false, omitPrevious = false, omitNext = false, transientEmptyMs = 0 }) {
  let pageIndex = startPage;
  let loading = false;
  const clicks = { previous: 0, next: 0, transactionDate: 0, filter: 0, search: 0 };
  const visible = () => ({ length: 1 });
  const previous = {
    textContent: "Go to previous page", hidden: false, get offsetParent() { return {}; }, getClientRects: visible,
    get disabled() { return pageIndex === 0; }, getAttribute: (name) => name === "aria-label" ? "Go to previous page" : null,
    click() { clicks.previous += 1; pageIndex = Math.max(0, pageIndex - 1); if (transientEmptyMs) { loading = true; setTimeout(() => { loading = false; }, transientEmptyMs); } }
  };
  const next = {
    textContent: "Go to next page", hidden: false, get offsetParent() { return {}; }, getClientRects: visible,
    get disabled() { return pageIndex === pages.length - 1; }, getAttribute: (name) => name === "aria-label" ? "Go to next page" : null,
    click() { clicks.next += 1; if (!repeatNext) pageIndex = Math.min(pages.length - 1, pageIndex + 1); if (transientEmptyMs) { loading = true; setTimeout(() => { loading = false; }, transientEmptyMs); } }
  };
  const unrelated = ["Transaction Date", "Filter", "Search"].map((text) => ({
    textContent: text, hidden: false, disabled: false, get offsetParent() { return {}; }, getClientRects: visible,
    getAttribute: () => null,
    click() { clicks[text === "Transaction Date" ? "transactionDate" : text.toLowerCase()] += 1; }
  }));
  const dateHeader = {
    textContent: "Transaction Date", getAttribute: (name) => name === "aria-sort" && descendingSort ? "descending" : null
  };
  const filterInput = {
    value: activeFilter ? "synthetic-nonempty" : "", hidden: false, get offsetParent() { return {}; },
    getClientRects: visible, labels: [],
    getAttribute: (name) => name === "aria-label" ? "Start Date" : name === "placeholder" ? "MM/DD/YY" : null
  };
  const active = {
    get textContent() { return String(pageIndex + 1); }, hidden: false, disabled: false,
    get offsetParent() { return {}; }, getClientRects: visible,
    getAttribute: (name) => name === "aria-label" ? `page ${pageIndex + 1}` : name === "aria-current" ? "true" : null
  };
  const pager = {
    hidden: false, get offsetParent() { return {}; }, getClientRects: visible,
    querySelectorAll(selector) {
      return selector === "button, [role='button'], input[type='submit'], input[type='button']" ?
        [...(omitPrevious ? [] : [previous]), active, ...(omitNext ? [] : [next])] : [];
    }
  };
  const main = {
    querySelectorAll(selector) {
      if (selector.includes('nav[aria-label="pagination navigation"]')) return [pager];
      if (selector === "button, [role='button'], input[type='submit'], input[type='button']") {
        return [...(omitPrevious ? [] : [previous]), active, ...(omitNext ? [] : [next]), ...unrelated];
      }
      if (selector === '[role="combobox"][aria-label="View"]') return [];
      if (selector === "input") return [filterInput];
      if (selector === "th, [role='columnheader']") return [dateHeader];
      return [];
    }
  };
  context.document = {
    body: { get textContent() { return loading ? "No transactions found" : ""; } },
    querySelector: (selector) => selector === "main, [role='main']" ? main : null,
    querySelectorAll: (selector) => main.querySelectorAll(selector)
  };
  const readDom = (add) => { if (!loading) pages[pageIndex].forEach(add); };
  const parseRecord = (row) => row.amount ? {
    id: row.id, timestamp: row.timestamp, plaza: row.plaza || "Example", amount: row.amount
  } : null;
  return { readDom, parseRecord, clicks, get pageIndex() { return pageIndex; } };
}

test("collects existing rows without touching filters and stops after the oldest trip", async () => {
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
  const fixture = portalFixture({ startPage: 1, pages: [
    [{ id: "new", timestamp: "09/05/2026 1:00 PM", amount: "-$1" }],
    [{ id: "match", timestamp: "08/20/2026 1:00 PM", amount: "-$2" }],
    [{ id: "old", timestamp: "07/31/2026 1:00 PM", amount: "-$3" }]
  ] });
  const result = await api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: fixture.parseRecord, readDom: fixture.readDom });
  assert.deepEqual(clone(result.records).map(({ id }) => id), ["match"]);
  assert.equal(result.terminalReason, "older_than_required_range");
  assert.equal(result.ordering, "descending");
  assert.equal(result.pageCount, 3);
  assert.equal(fixture.clicks.previous, 1);
  assert.equal(fixture.clicks.next, 2);
  assert.deepEqual([fixture.clicks.transactionDate, fixture.clicks.filter, fixture.clicks.search], [0, 0, 0]);
  assert.deepEqual(clone(result.observedRange), { startDate: "2026-07-31", endDate: "2026-09-05" });
});

test("without explicit descending sort proof collection continues to disabled Next", async () => {
  const fixture = portalFixture({ descendingSort: false, pages: [
    [{ id: "new", timestamp: "09/05/2026 1:00 PM", amount: "-$1" }],
    [{ id: "old", timestamp: "07/31/2026 1:00 PM", amount: "-$2" }],
    [{ id: "match", timestamp: "08/20/2026 1:00 PM", amount: "-$3" }]
  ] });
  const result = await api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: fixture.parseRecord, readDom: fixture.readDom });
  assert.equal(result.terminalReason, "next_disabled");
  assert.equal(result.ordering, "unverified");
  assert.deepEqual(clone(result.records).map(({ id }) => id), ["match"]);
});

test("transient empty placeholder after Next is not treated as a terminal page", async () => {
  const fixture = portalFixture({ transientEmptyMs: 500, pages: [
    [{ id: "new", timestamp: "09/05/2026 1:00 PM", amount: "-$1" }],
    [{ id: "match", timestamp: "08/20/2026 1:00 PM", amount: "-$2" }]
  ] });
  const result = await api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: fixture.parseRecord, readDom: fixture.readDom });
  assert.deepEqual(clone(result.records).map(({ id }) => id), ["match"]);
  assert.equal(result.lastPage, 2);
  assert.equal(result.terminalReason, "next_disabled");
});

test("active portal filters fail without retaining their values", async () => {
  const fixture = portalFixture({ activeFilter: true, pages: [[{ id: "one", timestamp: "08/20/2026", amount: "-$1" }]] });
  assert.equal(api.testing.hasActivePortalFilters(), true);
  await assert.rejects(api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: fixture.parseRecord, readDom: fixture.readDom }), /active date, tag, or plate filter/);
});

test("missing and repeated pagination controls fail safely", async () => {
  const missing = portalFixture({ omitPrevious: true, pages: [[{ id: "one", timestamp: "08/20/2026", amount: "-$1" }]] });
  await assert.rejects(api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: missing.parseRecord, readDom: missing.readDom }), /Previous pagination control is missing/);
  const repeated = portalFixture({ repeatNext: true, pages: [
    [{ id: "one", timestamp: "09/05/2026", amount: "-$1" }],
    [{ id: "two", timestamp: "08/20/2026", amount: "-$2" }]
  ] });
  await assert.rejects(api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: repeated.parseRecord, readDom: repeated.readDom }), /finish loading|repeated/i);
});

test("route changes are attributed to pagination", () => {
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/search";
  assert.throws(() => api.testing.assertRoute("pagination"), /pagination.*\/ezpass\/dashboard\/search/);
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
});
