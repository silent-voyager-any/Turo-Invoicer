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

test("normalizes portal timestamps into sortable local keys", () => {
  assert.equal(api.testing.localTimestampKey("09/05/2026 13:11:16.090"), "20260905131116");
  assert.equal(api.testing.localTimestampKey("9/5/26 1:11:16 PM"), "20260905131116");
  assert.equal(api.testing.localTimestampKey("2026-09-05T13:11:16"), "20260905131116");
  assert.equal(api.testing.localTimestampKey("not a date"), null);
  assert.equal(api.testing.localTimestampKey("2026-99-99T13:11:16"), null);
  assert.equal(api.testing.localTimestampKey("09/05/2026 13:11 PM"), null);
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
