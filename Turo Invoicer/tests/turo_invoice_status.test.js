import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function load(pathname, selectors = {}) {
  const document = {
    documentElement: {},
    querySelector: (selector) => (selectors[selector] || [])[0] || null,
    querySelectorAll: (selector) => selectors[selector] || []
  };
  const context = vm.createContext({
    URL, document, location: { origin: "https://turo.com", href: `https://turo.com${pathname}` },
    chrome: { runtime: { id: "test", onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout, clearTimeout
  });
  vm.runInContext(readFileSync("turo_invoice_status.js", "utf8"), context);
  return context.TuroInvoiceStatus;
}

const shown = (textContent, attributes = {}) => ({
  textContent, hidden: false, disabled: false, offsetParent: {}, getClientRects: () => ({ length: 1 }),
  getAttribute: (name) => attributes[name] ?? null, querySelectorAll: () => []
});

test("invoice hub deduplicates exact reservation invoice links", () => {
  const heading = shown("Invoices");
  const create = shown("Create Invoice");
  const link = shown("View", { href: "/us/en/reservation/123/reimbursement/invoice?invoiceId=456" });
  const api = load("/us/en/reservation/123/invoice-hub", {
    h1: [heading], "button, a": [create], 'a[href*="/reimbursement/invoice"]': [link, link]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.inspect("123"))), {
    ok: true, phase: "hub", invoiceUrls: ["https://turo.com/us/en/reservation/123/reimbursement/invoice?invoiceId=456"], canCreate: true
  });
  assert.equal(api.invoiceLink("/us/en/reservation/999/reimbursement/invoice?invoiceId=456", "123"), null);
  assert.equal(api.invoiceLink("/us/en/reservation/123/reimbursement/invoice?invoiceId=456&extra=1", "123"), null);
});

test("invoice detail recognizes a distinct Tolls item", () => {
  const tollHeading = shown("Tolls");
  const root = shown("");
  root.querySelectorAll = () => [shown("Refueling"), tollHeading];
  const api = load("/us/en/reservation/123/reimbursement/invoice?invoiceId=456", {
    '[data-testid="reimbursement-InvoiceOverviewView"]': [root]
  });
  assert.equal(api.inspect("123").hasTolls, true);
});

test("select-incidental view verifies an enabled toll option", () => {
  const toll = shown("");
  const selector = 'input[type="radio"]#TOLLS, input[type="radio"][value="TOLLS"]';
  const api = load("/us/en/reservation/123/reimbursement/request/select-incidental", { [selector]: [toll] });
  assert.equal(api.inspect("123").tollOptionAvailable, true);
  toll.disabled = true;
  assert.equal(api.inspect("123").tollOptionAvailable, false);
});

test("status adapter rejects unrelated reservation routes", () => {
  const api = load("/us/en/reservation/999/invoice-hub");
  assert.equal(api.route("123"), null);
  assert.equal(api.inspect("123"), null);
});
