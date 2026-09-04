import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

async function popup() {
  const elements = new Map();
  const element = () => ({
    value: "", textContent: "", children: [], listeners: {}, classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }, reset() {}
  });
  const document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    createElement: element
  };
  let state = { sources: { turo: { records: [] }, ezpass: { records: [] } },
    settings: { timeZone: "America/New_York", graceMinutes: 0, vehicleByTag: { existing: "car0" }, vehicleByPlate: {} },
    reconciliation: null, lastSync: null };
  let writes = 0;
  const chrome = { runtime: { sendMessage: async (message) => {
    if (message.type === "UPDATE_SETTINGS") { writes += 1; state.settings = { ...state.settings, ...message.settings }; }
    return { ok: true, state: structuredClone(state) };
  } } };
  vm.runInNewContext(readFileSync("popup.js", "utf8"), { document, chrome, Intl, Date, Set });
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, state, writes: () => writes };
}

test("manual vehicle form saves exact tag/plate mappings without erasing other cars", async () => {
  const { elements, state } = await popup();
  elements.get("#vehicleIdInput").value = "12345";
  elements.get("#tagIdInput").value = "0012345678";
  elements.get("#plateInput").value = "NY:ABC1234";
  await elements.get("#vehicleMappingForm").listeners.submit({ preventDefault() {} });
  assert.equal(state.settings.vehicleByTag["0012345678"], "12345");
  assert.equal(state.settings.vehicleByTag.existing, "car0");
  assert.equal(state.settings.vehicleByPlate["NY:ABC1234"], "12345");
});
test("manual vehicle form does not save without both a vehicle and an identifier", async () => {
  const { elements, writes } = await popup();
  elements.get("#vehicleIdInput").value = "12345";
  await elements.get("#vehicleMappingForm").listeners.submit({ preventDefault() {} });
  assert.equal(writes(), 0);
  assert.match(elements.get("#status").textContent, /at least one/);
});
