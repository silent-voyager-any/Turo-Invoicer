import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function hook() {
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
    location: { href: "https://turo.com/us/en/trips", hostname: "turo.com", origin: "https://turo.com" }
  });
  vm.runInContext(readFileSync("network_hook.js", "utf8"), context);
  return { window, XHR, messages, response };
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
