import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const baseDocument = { querySelectorAll: () => [], querySelector: () => null, body: { innerText: "", querySelectorAll: () => [] } };
class FakeEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}
class FakeInputElement {}
Object.defineProperty(FakeInputElement.prototype, "value", {
  configurable: true,
  get() { return this._value || ""; },
  set(value) { this._value = String(value); }
});
const context = vm.createContext({
  Date, URL, location: { href: "https://www.e-zpassny.com/ezpass/dashboard/transactions" },
  document: baseDocument, Event: FakeEvent, InputEvent: FakeEvent, KeyboardEvent: FakeEvent,
  HTMLInputElement: FakeInputElement,
  setTimeout, clearTimeout
});
vm.runInContext(readFileSync("ezpass_collection.js", "utf8"), context);
const api = context.EzpassCollection;

test("validates and formats the worker's E-ZPass date-range contract", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(api.validateRange({ startDate: "2026-08-01", endDate: "2026-08-31" }))),
    { startDate: "2026-08-01", endDate: "2026-08-31" });
  assert.equal(api.portalDate("2026-08-01"), "08/01/26");
  assert.throws(() => api.validateRange({ startDate: "2026-08-31", endDate: "2026-08-01" }), /valid/);
  assert.throws(() => api.validateRange({ startDate: "2026-02-30", endDate: "2026-03-01" }), /valid/);
});

test("splits large ranges into inclusive, nonoverlapping 14-day chunks", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(api.chunkDateRange({ startDate: "2026-08-01", endDate: "2026-09-02" }))), [
    { startDate: "2026-08-01", endDate: "2026-08-14" },
    { startDate: "2026-08-15", endDate: "2026-08-28" },
    { startDate: "2026-08-29", endDate: "2026-09-02" }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.chunkDateRange({ startDate: "2026-08-01", endDate: "2026-08-01" }))), [
    { startDate: "2026-08-01", endDate: "2026-08-01" }
  ]);
});

function domNode({ tag = "div", text = "", attributes = {}, visible = true, disabled = false, onEvent = null } = {}) {
  const node = {
    tag, ownText: text, attributes, visible, disabled, hidden: false, parentElement: null, children: [], clicks: 0,
    events: [], focused: false,
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
    get textContent() { return [this.ownText, ...this.children.map((child) => child.textContent)].filter(Boolean).join(" "); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    getClientRects() { return this.visible ? [{}] : []; },
    get offsetParent() { return this.visible ? {} : null; },
    click() { this.clicks += 1; },
    focus() { this.focused = true; },
    blur() { this.focused = false; },
    setSelectionRange() {},
    checkValidity() { return this.attributes.valid !== false; },
    dispatchEvent(event) { this.events.push(event); onEvent?.(event, this); return true; },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      if (selector === "input") return descendants.filter((child) => child.tag === "input");
      if (selector === "button, [role='button'], input[type='submit'], input[type='button']") {
        return descendants.filter((child) => child.tag === "button" || child.attributes.role === "button" ||
          child.tag === "input" && ["submit", "button"].includes(child.attributes.type));
      }
      return [];
    }
  };
  if (tag === "input") Object.setPrototypeOf(node, FakeInputElement.prototype);
  return node;
}

function filterFixture({ searchCount = 1, searchVisible = true, searchDisabled = false, dateCount = 2, includeLabels = true, nestingDepth = 0 } = {}) {
  const body = domNode(), header = domNode({ tag: "header" }), main = domNode({ tag: "main" });
  const headerSearches = [1, 2, 3].map(() => domNode({ tag: "button", text: "Search" }));
  header.append(...headerSearches);
  const panel = domNode({ text: includeLabels ? "Start Date End Date Type Tag/Plate #" : "" });
  const inputs = Array.from({ length: dateCount }, (_, index) => domNode({
    tag: "input", attributes: { placeholder: "MM/DD/YY", "aria-label": index ? "End Date" : "Start Date" }
  }));
  const searches = Array.from({ length: searchCount }, () => domNode({ tag: "button", text: "SEARCH", visible: searchVisible, disabled: searchDisabled }));
    let inputHost = panel;
    for (let depth = 0; depth < nestingDepth; depth += 1) {
      const wrapper = domNode();
      inputHost.append(wrapper);
      inputHost = wrapper;
    }
    inputHost.append(...inputs);
    panel.append(...searches); main.append(panel); body.append(header, main);
  context.document = {
    body,
    querySelector: (selector) => selector === "main, [role='main']" ? main : null,
    querySelectorAll: (selector) => body.querySelectorAll(selector)
  };
  return { headerSearches, main, panel, inputs, searches };
}

  test("scopes Search to the transaction date panel instead of portal header buttons", () => {
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
  const fixture = filterFixture();
  const search = api.testing.filterSearchButton(api.testing.requireVisibleDateInputs());
  search.click();
  api.testing.assertRoute("test filter search");
  assert.equal(fixture.searches[0].clicks, 1);
  assert.deepEqual(fixture.headerSearches.map((button) => button.clicks), [0, 0, 0]);
  });

  test("finds transaction Search when the date controls are deeply nested", () => {
    const fixture = filterFixture({ nestingDepth: 12 });
    const search = api.testing.filterSearchButton(api.testing.requireVisibleDateInputs());
    search.click();
    assert.equal(fixture.searches[0].clicks, 1);
    assert.deepEqual(fixture.headerSearches.map((button) => button.clicks), [0, 0, 0]);
  });

test("finds Search when field labels are rendered outside the shared ancestor", () => {
  const fixture = filterFixture({ includeLabels: false, nestingDepth: 4 });
  const search = api.testing.filterSearchButton(api.testing.requireVisibleDateInputs());
  assert.equal(search, fixture.searches[0]);
});

test("recognizes an input-based transaction Search control", () => {
  const fixture = filterFixture({ searchCount: 0 });
  const inputSearch = domNode({ tag: "input", attributes: { type: "submit", value: "Search" } });
  fixture.panel.append(inputSearch);
  const search = api.testing.filterSearchButton(api.testing.requireVisibleDateInputs());
  assert.equal(search, inputSearch);
});

test("orders date controls semantically and falls back to verified DOM order", () => {
  const fixture = filterFixture();
  const reversed = [fixture.inputs[1], fixture.inputs[0]];
  let ordered = api.testing.orderDateInputs(reversed);
  assert.equal(ordered[0], fixture.inputs[0]);
  assert.equal(ordered[1], fixture.inputs[1]);
  fixture.inputs.forEach((input) => { input.attributes["aria-label"] = "Date"; });
  ordered = api.testing.orderDateInputs(reversed);
  assert.equal(ordered[0], reversed[0]);
  assert.equal(ordered[1], reversed[1]);
});

test("hydrates masked date inputs with typing events before Search enables", async () => {
  const fixture = filterFixture({ searchDisabled: true });
  const enableWhenReady = (event) => {
    if (event.type === "keyup" && fixture.inputs.every((input) => String(input.value).replace(/\D/g, "").length === 6)) {
      fixture.searches[0].disabled = false;
    }
  };
  fixture.inputs.forEach((input) => { input.dispatchEvent = (event) => {
    input.events.push(event); enableWhenReady(event); return true;
  }; });
  await api.testing.commitDateInput(fixture.inputs[0], "08/01/26");
  assert.equal(fixture.searches[0].disabled, true);
  await api.testing.commitDateInput(fixture.inputs[1], "08/14/26");
  assert.equal(fixture.searches[0].disabled, false);
  assert.ok(fixture.inputs[0].events.some((event) => event.type === "beforeinput"));
  assert.ok(fixture.inputs[0].events.some((event) => event.type === "keyup"));
  assert.equal(api.testing.filterSearchButton(fixture.inputs), fixture.searches[0]);
});

test("rejects a date value the portal mask does not accept and emits sanitized diagnostics", async () => {
  const fixture = filterFixture();
  Object.defineProperty(fixture.inputs[0], "value", { configurable: true, get: () => "", set() {} });
  await assert.rejects(api.testing.commitDateInput(fixture.inputs[0], "08/01/26"),
    /rejected a requested date.*"accepted":false.*"valid":true/);
  const diagnostics = api.testing.controlDiagnostics(fixture.inputs, fixture.searches[0]);
  assert.doesNotMatch(diagnostics, /08\/01\/26/);
});

test("rejects missing, hidden, disabled, duplicate, and structurally unsupported filter Search controls", () => {
  for (const options of [
    { searchCount: 0 }, { searchVisible: false }, { searchDisabled: true }, { searchCount: 2 }
  ]) {
    filterFixture(options);
    assert.throws(() => api.testing.filterSearchButton(api.testing.requireVisibleDateInputs()), /Search|filter/);
  }
});

test("rejects ambiguous visible date-input groups and reports the navigation phase", () => {
  filterFixture({ dateCount: 3 });
  assert.throws(() => api.testing.requireVisibleDateInputs(), /exactly two/);
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/search";
  assert.throws(() => api.testing.assertRoute("transaction-filter search"), /transaction-filter search.*\/ezpass\/dashboard\/search/);
  context.location.href = "https://www.e-zpassny.com/ezpass/dashboard/transactions";
});
