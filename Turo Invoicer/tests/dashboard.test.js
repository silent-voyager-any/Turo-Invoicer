import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function node() {
  return {
    value: "", textContent: "", className: "", disabled: false, label: "", dataset: {}, children: [], listeners: {}, classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }
  };
}

async function dashboard() {
  const elements = new Map();
  const document = { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); }, createElement: node };
  let state = {
    version: 3, sources: { turo: { records: [{ id: "trip", vehicleId: "car1" }] }, ezpass: { records: [] } },
    settings: { timeZone: "America/New_York", graceMinutes: 0 }, fleet: { vehicles: [{ vehicleId: "car1", label: "Car one" }], assignments: [] },
    uiDrafts: { vehicleAssignment: { vehicleId: "car1", label: "Car one", kind: "tag", identifier: "001" } }, reconciliation: null, lastSync: null
  };
  const messages = [];
  const chrome = { runtime: { sendMessage: async (message) => {
    messages.push(structuredClone(message));
    if (message.type === "SAVE_UI_DRAFT") state.uiDrafts.vehicleAssignment = message.draft;
    if (message.type === "UPSERT_ASSIGNMENT") {
      state.fleet.assignments.push({ id: "a1", ...message.assignment }); state.uiDrafts.vehicleAssignment = {};
    }
    return { ok: true, state: structuredClone(state), synced: true, collection: { turo: { ok: true }, ezpass: { ok: true } } };
  } } };
  vm.runInNewContext(readFileSync("dashboard.js", "utf8"), { document, chrome, Intl, Date, Object, Set, clearTimeout, setTimeout, structuredClone });
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, messages, state };
}

test("dashboard restores a vehicle draft after reopening", async () => {
  const env = await dashboard();
  assert.equal(env.elements.get("#vehicleId").value, "car1");
  assert.equal(env.elements.get("#identifier").value, "001");
});

test("dashboard submits a dated assignment and clears the completed form", async () => {
  const env = await dashboard();
  env.elements.get("#validFrom").value = "2026-01-01";
  await env.elements.get("#assignmentForm").listeners.submit({ preventDefault() {} });
  const save = env.messages.find((message) => message.type === "UPSERT_ASSIGNMENT");
  assert.equal(save.assignment.identifier, "001");
  assert.equal(save.assignment.validFrom, "2026-01-01");
  assert.equal(env.elements.get("#vehicleId").value, "");
});
