import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

class TestInputElement {
  constructor() { this._value = ""; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
}
class TestEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}
const context = vm.createContext({
  Date, URL, location: { href: "https://www.e-zpassny.com/ezpass/dashboard/transactions" },
  document: { querySelectorAll: () => [], querySelector: () => null, body: { textContent: "" } },
  HTMLInputElement: TestInputElement, Event: TestEvent, InputEvent: TestEvent,
  KeyboardEvent: TestEvent, MouseEvent: TestEvent, setTimeout, clearTimeout
});
vm.runInContext(readFileSync("ezpass_collection.js", "utf8"), context);
const api = context.EzpassCollection;
const clone = (value) => JSON.parse(JSON.stringify(value));

const searchQuery = { kind: "tag", canonicalIdentifier: "00123", startDate: "2026-08-01", endDate: "2026-08-02" };
function searchFixture(initialRows, initialText = "") {
  let rows = initialRows, text = initialText, revision = 0, loading = false;
  const main = { get innerText() { return text; }, querySelectorAll(selector) {
    return selector.includes("aria-busy") && loading ? [visibleElement()] : [];
  } };
  const oldQuery = context.document.querySelector;
  context.document.querySelector = () => main;
  const readDom = (add) => rows.forEach(add);
  const parseRecord = (row) => row.activity === "CREDIT" ? null : row;
  return { readDom, parseRecord, getNetworkRevision: () => revision,
    set(nextRows, nextText = "", nextLoading = false) { rows = nextRows; text = nextText; loading = nextLoading; revision += 1; },
    restore() { context.document.querySelector = oldQuery; } };
}
const searchRow = (id = "lane-1") => ({ transactionId: id, id, timestamp: "08/01/2026 12:00:00",
  tagId: "00123", amount: "-$4.19", activity: "TOLL POSTING" });

test("search ignores the old table until a post-search transition and accepts delayed filtered rows", async () => {
  const fixture = searchFixture([{ ...searchRow("old"), tagId: "99999" }]);
  try {
    const baseline = api.testing.samplePage(fixture.readDom, fixture.parseRecord);
    setTimeout(() => fixture.set([searchRow("new")]), 200);
    const result = await api.testing.waitForSearchResult({ baseline, baselineRevision: 0, query: searchQuery,
      ...fixture, timeoutMs: 3500 });
    assert.equal(result.records[0].id, "new");
  } finally { fixture.restore(); }
});

test("search accepts identical-looking results only after a fresh response", async () => {
  const fixture = searchFixture([searchRow()]);
  try {
    const baseline = api.testing.samplePage(fixture.readDom, fixture.parseRecord);
    setTimeout(() => fixture.set([searchRow()]), 100);
    const result = await api.testing.waitForSearchResult({ baseline, baselineRevision: 0, query: searchQuery,
      ...fixture, timeoutMs: 3000 });
    assert.equal(result.records.length, 1);
  } finally { fixture.restore(); }
});

test("search rejects unchanged old rows and credit-only rows", async () => {
  const stale = searchFixture([searchRow()]);
  try {
    const baseline = api.testing.samplePage(stale.readDom, stale.parseRecord);
    await assert.rejects(api.testing.waitForSearchResult({ baseline, baselineRevision: 0, query: searchQuery,
      ...stale, timeoutMs: 300 }), /search incomplete \(search_not_applied\)/);
  } finally { stale.restore(); }
  const credit = searchFixture([searchRow("old")]);
  try {
    const baseline = api.testing.samplePage(credit.readDom, credit.parseRecord);
    credit.set([{ ...searchRow("credit"), activity: "CREDIT" }]);
    await assert.rejects(api.testing.waitForSearchResult({ baseline, baselineRevision: 0, query: searchQuery,
      ...credit, timeoutMs: 300 }), /search incomplete \(filters_not_confirmed\)/);
  } finally { credit.restore(); }
});

test("search requires a sustained empty state and ignores transient placeholders", async () => {
  const fixture = searchFixture([searchRow("old")]);
  try {
    const baseline = api.testing.samplePage(fixture.readDom, fixture.parseRecord);
    setTimeout(() => fixture.set([], "No transactions found"), 100);
    setTimeout(() => fixture.set([searchRow("new")]), 450);
    const result = await api.testing.waitForSearchResult({ baseline, baselineRevision: 0, query: searchQuery,
      ...fixture, timeoutMs: 3300 });
    assert.equal(result.records[0].id, "new");
  } finally { fixture.restore(); }
  const empty = searchFixture([searchRow("old")]);
  try {
    const baseline = api.testing.samplePage(empty.readDom, empty.parseRecord);
    setTimeout(() => empty.set([], "No transactions found"), 100);
    const result = await api.testing.waitForSearchResult({ baseline, baselineRevision: 0, query: searchQuery,
      ...empty, timeoutMs: 3000 });
    assert.equal(result.raw.length, 0);
  } finally { empty.restore(); }
});

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

test("normalizes only allowlisted direction marks in masked date input values", () => {
  for (const mark of ["\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
    "\u2066", "\u2067", "\u2068", "\u2069"]) {
    assert.equal(api.testing.inputDate(`9${mark}/1${mark}/26`), "2026-09-01");
    assert.equal(api.testing.inputDate(`${mark}09/01/2026${mark}`), "2026-09-01");
  }
  assert.equal(api.testing.inputDate("9\u200b/1/26"), null);
  assert.equal(api.testing.inputDate("9-1-26"), null);
  assert.equal(api.testing.inputDate("September 1, 2026"), null);
  assert.equal(api.testing.inputDate("2/30/26"), null);
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
  fixture.start.value = "8\u200e/1\u200e/26";
  fixture.end.value = "8\u200e/2\u200e/26";
  assert.deepEqual(clone(api.testing.snapshotFilters()).startDate, "2026-08-01");
  assert.deepEqual(clone(api.testing.snapshotFilters()).endDate, "2026-08-02");
});

test("distinguishes duplicate and missing labelled filter controls", () => {
  let fixture = labelledFilterFixture({ duplicateType: true });
  assert.throws(() => api.testing.transactionFilterControls([fixture.start, fixture.end]), /multiple Type controls/);
  fixture = labelledFilterFixture({ omitType: true });
  assert.throws(() => api.testing.transactionFilterControls([fixture.start, fixture.end]), /Type filter was not found/);
  fixture = labelledFilterFixture({ omitIdentifier: true });
  assert.throws(() => api.testing.transactionFilterControls([fixture.start, fixture.end]), /Tag\/Plate # filter was not found/);
});

function identifierFixture({ kind = "tag", canonicalIdentifier = "000123", optionText = "E-ZPass Tag: 000123",
  delayed = false, menuDelay = 0, ambiguous = false } = {}) {
  let options = [];
  const combo = new TestInputElement();
  Object.assign(combo, visibleElement({ events: [], readOnly: false, disabled: false,
    focus() {}, select() {}, setSelectionRange() {},
    dispatchEvent(event) {
      this.events.push(event);
      if (delayed && event.type === "input" && this.value === canonicalIdentifier) {
        setTimeout(() => { options = makeOptions(); }, 25);
      }
      return true;
    },
    click() {
      if (delayed) return;
      if (menuDelay) setTimeout(() => { options = makeOptions(); }, menuDelay);
      else options = makeOptions();
    }
  }));
  combo.value = "All tags";
  const makeOption = (text) => visibleElement({ textContent: text, click() { combo.value = text; } });
  const makeOptions = () => [makeOption(optionText), ...(ambiguous ? [makeOption(`${optionText} (duplicate)`)] : [])];
  context.document = {
    body: { textContent: "" },
    querySelector: () => null,
    querySelectorAll: (selector) => selector === '[role="option"]' ? options : []
  };
  return { combo, query: { kind, canonicalIdentifier, identifier: canonicalIdentifier } };
}

test("matches exact identifiers inside decorated tag and plate option labels", () => {
  let fixture = identifierFixture();
  fixture.combo.click();
  assert.equal(api.testing.uniqueIdentifierOption(fixture.query).textContent, "E-ZPass Tag: 000123");
  assert.equal(api.testing.optionIdentifierCandidates({ textContent: "Tag 123" }, "tag").has("000123"), false,
    "leading zeros remain significant");

  fixture = identifierFixture({ kind: "plate", canonicalIdentifier: "ABC123",
    optionText: "License Plate • NY: ABC-123" });
  fixture.combo.click();
  assert.equal(api.testing.uniqueIdentifierOption(fixture.query).textContent, "License Plate • NY: ABC-123");
});

test("types an exact identifier to reveal a delayed or virtualized option", async () => {
  const fixture = identifierFixture({ delayed: true });
  await api.testing.selectIdentifier(fixture.combo, fixture.query);
  assert.equal(fixture.combo.value, "E-ZPass Tag: 000123");
  assert.ok(fixture.combo.events.some((event) => event.type === "beforeinput"));
  assert.ok(fixture.combo.events.some((event) => event.type === "input"));
});

test("waits for a slowly hydrated exact identifier menu before typing", async () => {
  const fixture = identifierFixture({ menuDelay: 250 });
  await api.testing.selectIdentifier(fixture.combo, fixture.query);
  assert.equal(fixture.combo.value, "E-ZPass Tag: 000123");
  assert.equal(fixture.combo.events.some((event) => event.type === "input"), false);
});

test("classifies a genuinely absent configured identifier without exposing its value", async () => {
  const fixture = identifierFixture({ canonicalIdentifier: "999999", optionText: "000123" });
  await assert.rejects(api.testing.selectIdentifier(fixture.combo, fixture.query), (error) => {
    assert.equal(error.code, "EZPASS_IDENTIFIER_UNAVAILABLE");
    assert.match(error.message, /Update or remove the assignment/);
    assert.doesNotMatch(error.message, /999999/);
    return true;
  });
});

test("rejects ambiguous exact identifier options", async () => {
  const fixture = identifierFixture({ ambiguous: true });
  await assert.rejects(api.testing.selectIdentifier(fixture.combo, fixture.query), /option is ambiguous/);
});

test("validates tag and plate results against their corresponding fields", () => {
  const record = { id: "lane-1", tagId: "000123", plate: "ABC-123", tagOrPlate: null };
  assert.equal(api.testing.recordMatchesQuery(record, { kind: "tag", canonicalIdentifier: "000123" }), true);
  assert.equal(api.testing.recordMatchesQuery(record, { kind: "plate", canonicalIdentifier: "ABC123" }), true);
  assert.equal(api.testing.recordMatchesQuery(record, { kind: "plate", canonicalIdentifier: "000123" }), false,
    "a plate query must not fall back to the dedicated tag field");
});

test("merges duplicate lane transactions across separate tag and plate searches", () => {
  const records = new Map();
  const record = { id: "lane-1", timestamp: "09/01/2026 12:00 PM", plaza: "Example", amount: "-$1.00",
    tagId: "000123", plate: "ABC-123" };
  const tagQuery = { queryId: "1001:tag:000123", reservationId: "1001", vehicleId: "car1", kind: "tag",
    identifier: "000123" };
  const plateQuery = { queryId: "1001:plate:ABC123", reservationId: "1001", vehicleId: "car1", kind: "plate",
    identifier: "NY:ABC-123" };
  assert.equal(api.testing.mergeQueryRecord(records, record, tagQuery), true);
  assert.equal(api.testing.mergeQueryRecord(records, record, plateQuery), false);
  assert.equal(records.size, 1);
  assert.equal(records.get("lane-1").queryId, tagQuery.queryId);
  assert.throws(() => api.testing.mergeQueryRecord(records, { ...record, amount: "-$2.00" }, plateQuery),
    /conflicting duplicate Lane Txn IDs/);
});

function typedDateFixture({ execCommand = true, replaceInput = false, readOnly = false, disabled = false,
  rejectValue = false, invalid = false } = {}) {
  let active = null, calendarClicks = 0;
  const makeInput = (role) => {
    const input = new TestInputElement();
    Object.assign(input, visibleElement({ labels: [{ textContent: `${role} Date` }], events: [], readOnly, disabled,
      attributes: { placeholder: "MM/DD/YY" },
      focus() { active = this; }, select() {}, setSelectionRange() {}, blur() {}, checkValidity: () => !invalid,
      dispatchEvent(event) {
        this.events.push(event);
        if (replaceInput && role === "Start" && event.type === "input" && !inputs.replaced) {
          const replacement = makeInput(role);
          replacement.value = this.value;
          inputs[0] = replacement;
          inputs.replaced = true;
          active = replacement;
        }
        return true;
      }
    }));
    return input;
  };
  const inputs = [makeInput("Start"), makeInput("End")];
  const calendar = visibleElement({ textContent: "Choose date", click() { calendarClicks += 1; } });
  const main = { querySelectorAll: (selector) => selector === "input" ? inputs :
    selector === "button, [role='button'], input[type='submit'], input[type='button']" ? [calendar] : [] };
  context.document = {
    body: { textContent: "" },
    querySelector: (selector) => selector === "main, [role='main']" ? main : null,
    querySelectorAll: (selector) => main.querySelectorAll(selector)
  };
  if (execCommand) {
    context.document.execCommand = (command, _ui, value) => {
      if (command === "delete") { active.value = ""; return true; }
      if (command !== "insertText") return false;
      const digits = `${api.testing.normalizedDateDigits(active.value)}${value}`;
      if (!rejectValue) active.value = api.testing.maskedDatePrefix(digits);
      return true;
    };
  }
  return { inputs, get calendarClicks() { return calendarClicks; } };
}

test("types an exact masked date through Chromium editing without opening the calendar", async () => {
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
  const fixture = typedDateFixture();
  fixture.inputs[0].value = "01/01/25";
  await api.testing.commitDateInput(fixture.inputs[0], "2026-08-01");
  assert.equal(fixture.inputs[0].value, "08/01/26");
  assert.equal(fixture.calendarClicks, 0);
});

test("native input fallback emits typing events and reacquires a replaced input", async () => {
  const fixture = typedDateFixture({ execCommand: false, replaceInput: true });
  const original = fixture.inputs[0];
  const accepted = await api.testing.commitDateInput(original, "2026-08-01");
  assert.notEqual(accepted, original);
  assert.equal(accepted.value, "08/01/26");
  assert.ok(original.events.some((event) => event.type === "beforeinput"));
  assert.ok(accepted.events.some((event) => event.type === "keyup"));
  assert.equal(fixture.calendarClicks, 0);
});

test("typing both masked dates supplies the events that enable portal Search", async () => {
  const fixture = typedDateFixture({ execCommand: false });
  let searchEnabled = false;
  for (const input of fixture.inputs) {
    const dispatch = input.dispatchEvent.bind(input);
    input.dispatchEvent = (event) => {
      const result = dispatch(event);
      if (event.type === "keyup" && fixture.inputs.every((field) =>
        api.testing.normalizedDateDigits(field.value).length === 6)) searchEnabled = true;
      return result;
    };
  }
  await api.testing.commitDateInput(fixture.inputs[0], "2026-08-01");
  assert.equal(searchEnabled, false);
  await api.testing.commitDateInput(fixture.inputs[1], "2026-08-14");
  assert.equal(searchEnabled, true);
});

test("typed dates accept safe formatting marks but reject uneditable or rejected fields", async () => {
  let fixture = typedDateFixture();
  fixture.inputs[0].value = "8\u200e/1\u200e/26";
  assert.equal(await api.testing.commitDateInput(fixture.inputs[0], "2026-08-01"), fixture.inputs[0]);
  fixture = typedDateFixture({ readOnly: true });
  await assert.rejects(api.testing.commitDateInput(fixture.inputs[0], "2026-08-01"), /not editable.*readOnly/);
  fixture = typedDateFixture({ disabled: true });
  await assert.rejects(api.testing.commitDateInput(fixture.inputs[0], "2026-08-01"), /not editable.*disabled/);
  fixture = typedDateFixture({ rejectValue: true, invalid: true });
  await assert.rejects(api.testing.commitDateInput(fixture.inputs[0], "2026-08-01"), /rejected a typed date.*digitCount/);
});

test("continues only the exact E-ZPass session-expiry dialog action", async () => {
  let open = true, clicks = 0;
  const continueButton = visibleElement({ textContent: "continue working", click() { clicks += 1; open = false; } });
  const logoutButton = visibleElement({ textContent: "logout", click() { throw new Error("logout must not be clicked"); } });
  const dialog = visibleElement({ textContent: "Session will expire soon You will be automatically logged out for security reason",
    querySelectorAll: (selector) => selector === "button, [role='button'], input[type='submit'], input[type='button']" ?
      [continueButton, logoutButton] : [] });
  context.document = {
    body: { textContent: "" },
    querySelector: () => null,
    querySelectorAll: (selector) => selector === '[role="dialog"]' && open ? [dialog] : []
  };
  assert.equal(await api.testing.continueActiveSessionIfNeeded(true), true);
  assert.equal(clicks, 1);
});

test("session continuation is sync-scoped and rejects ambiguous actions", async () => {
  const button = () => visibleElement({ textContent: "continue working", click() {} });
  const dialog = visibleElement({ textContent: "Session will expire soon You will be automatically logged out",
    querySelectorAll: (selector) => selector === "button, [role='button'], input[type='submit'], input[type='button']" ?
      [button(), button()] : [] });
  context.document = {
    body: { textContent: "" }, querySelector: () => null,
    querySelectorAll: (selector) => selector === '[role="dialog"]' ? [dialog] : []
  };
  assert.equal(await api.testing.continueActiveSessionIfNeeded(), false);
  await assert.rejects(api.testing.continueActiveSessionIfNeeded(true), /ambiguous Continue working/);
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
  repeatNext = false, omitPrevious = false, omitNext = false, omitPager = false, transientEmptyMs = 0 }) {
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
      if (selector.includes('nav[aria-label="pagination navigation"]')) return omitPager ? [] : [pager];
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

test("accepts a stable nonempty one-page result when E-ZPass omits pagination", async () => {
  const fixture = portalFixture({ omitPager: true,
    pages: [[{ id: "one", timestamp: "08/20/2026 1:00 PM", amount: "-$1" }]] });
  const result = await api.collect({ range: { startDate: "2026-08-01", endDate: "2026-08-31" },
    parseRecord: fixture.parseRecord, readDom: fixture.readDom });
  assert.equal(result.terminalReason, "single_page_no_pager");
  assert.deepEqual(clone(result.records).map(({ id }) => id), ["one"]);

  const firstPage = { noTransactions: false, signature: "filtered-one", pageNumber: null,
    raw: [{ id: "one" }], records: [{ id: "one" }] };
  const filtered = await api.testing.collectFilteredPages(firstPage, {}, () => {}, (value) => value);
  assert.equal(filtered.pageCount, 1);
  assert.deepEqual(clone(filtered.records), [{ id: "one" }]);
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
    parseRecord: repeated.parseRecord, readDom: repeated.readDom }), /finish loading|repeated|pagination did not settle or advance/i);
});

test("route changes are attributed to pagination", () => {
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/search";
  assert.throws(() => api.testing.assertRoute("pagination"), /pagination.*\/ezpass\/dashboard\/search/);
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
});
