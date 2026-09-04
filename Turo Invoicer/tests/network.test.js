import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function hook(href = "https://turo.com/us/en/trips/history") {
  const messages = [];
  const response = new Response(JSON.stringify({ trips: [{ id: 1 }] }), { headers: { "Content-Type": "application/json" } });
  class XHR {
    open(_method, url) { this.url = url; }
    addEventListener(name, callback) { (this.listeners ||= {})[name] = callback; }
    complete(url, payload) {
      this.responseURL = url;
      this.status = 200;
      this.responseType = "text";
      this.responseText = payload;
      this.listeners.load();
    }
  }
  const window = { fetch: async () => response, postMessage: (message) => messages.push(message) };
  const context = vm.createContext({
    window, XMLHttpRequest: XHR, URL, TextDecoder,
    location: { href, hostname: new URL(href).hostname, origin: new URL(href).origin }
  });
  vm.runInContext(readFileSync("network_hook.js", "utf8"), context);
  return { window, XHR, messages, response, location: context.location };
}

test("fetch hook preserves the original response and observes same-site API JSON", async () => {
  const { window, response, messages } = hook();
  const returned = await window.fetch("https://api.turo.com/api/trips?privateQuery=synthetic");
  assert.equal(returned, response);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.trips[0].id, 1);
  assert.equal(messages[0].url, undefined);
  assert.deepEqual(await response.json(), { trips: [{ id: 1 }] });
});
test("fetch hook excludes auth paths and unrelated domains", async () => {
  for (const url of ["https://turo.com/auth/trips", "https://other.invalid/trips", "https://turo.com/profile", "https://turo.com/login?next=trips"]) {
    const { window, messages } = hook();
    await window.fetch(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(messages.length, 0, url);
  }
});
test("XHR hook handles reuse and malformed JSON without breaking the portal", () => {
  const { XHR, messages } = hook();
  const xhr = new XHR();
  xhr.open("GET", "/api/trips");
  xhr.complete("https://turo.com/api/trips", '{"trips":[]}');
  xhr.open("GET", "/api/trips?page=2");
  xhr.complete("https://turo.com/api/trips", '{"trips":[1]}');
  xhr.open("GET", "/api/trips?page=3");
  xhr.complete("https://turo.com/api/trips", "malformed");
  assert.equal(messages.length, 2);
});

test("Turo response bodies are not captured on upcoming trips", async () => {
  const { window, messages } = hook("https://turo.com/us/en/trips/upcoming");
  await window.fetch("https://turo.com/api/trips");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, 0);
});
test("a request started outside history cannot enter the history capture after navigation", async () => {
  const { window, messages, location } = hook("https://turo.com/us/en/trips/upcoming");
  const pending = window.fetch("https://turo.com/api/trips");
  location.href = "https://turo.com/us/en/trips/history";
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, 0);
});
test("E-ZPass only observes transactions on the exact transactions page", async () => {
  for (const path of ["/ezpass/dashboard", "/ezpass/dashboard/transactions"]) {
    const { window, messages } = hook("https://www.e-zpassny.com" + path);
    await window.fetch("https://www.e-zpassny.com/api/transactions");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(messages.length, path.endsWith("/transactions") ? 1 : 0);
  }
});
