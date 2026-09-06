import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

async function popup() {
  const elements = new Map();
  const element = () => ({
    value: "", textContent: "", className: "", disabled: false, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }
  });
  const document = { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); } };
  const state = { version: 3, sources: { turo: { records: [{ id: "trip" }] }, ezpass: { records: [{ id: "toll" }] } }, lastSync: null };
  const opened = [];
  let closed = false;
  const chrome = {
    runtime: {
      getURL: (file) => `chrome-extension://test-id/${file}`,
      sendMessage: async (message) => ({ ok: true, state, synced: message.type === "RUN_SYNC", collection: { turo: { ok: true }, ezpass: { ok: true } } })
    },
    tabs: { create: async (options) => opened.push(options) }
  };
  vm.runInNewContext(readFileSync("popup.js", "utf8"), { document, chrome, window: { close: () => { closed = true; } }, Intl, Date, Object });
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, opened, closed: () => closed };
}

test("popup launches the persistent dashboard and reports saved counts", async () => {
  const env = await popup();
  assert.equal(env.elements.get("#tripCount").textContent, 1);
  assert.equal(env.elements.get("#tollCount").textContent, 1);
  await env.elements.get("#openDashboard").listeners.click();
  assert.equal(JSON.stringify(env.opened), JSON.stringify([{ url: "chrome-extension://test-id/dashboard.html" }]));
  assert.equal(env.closed(), true);
});

test("popup retains a compact sync action", async () => {
  const env = await popup();
  await env.elements.get("#syncButton").listeners.click();
  assert.match(env.elements.get("#status").textContent, /Sync complete/);
  assert.equal(env.elements.get("#syncButton").disabled, false);
});
