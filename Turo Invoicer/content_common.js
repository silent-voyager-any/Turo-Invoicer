(() => {
  "use strict";
  const MAX_RECORDS = 5000;
  const MAX_NODES = 20000;
  const MESSAGE_SOURCE = "turo-toll-reconciler-page";

  function scalar(value) {
    return typeof value === "string" && value.length <= 250 ||
      typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function pick(object, keys) {
    if (!object || typeof object !== "object") return null;
    const entries = Object.entries(object);
    // Alias priority is deterministic, independent of JSON property order.
    for (const alias of keys) {
      const entry = entries.find(([key, value]) => key.toLowerCase() === alias.toLowerCase() && value != null && value !== "");
      if (entry) return entry[1];
    }
    return null;
  }

  function timestamp(object, instantKeys, dateKeys, timeKeys) {
    const direct = scalar(pick(object, instantKeys));
    if (direct != null) return direct;
    const date = scalar(pick(object, dateKeys));
    const time = scalar(pick(object, timeKeys));
    if (typeof date === "string" && /\d{1,2}:\d{2}/.test(date) || typeof date === "number") return date;
    return date != null && time != null ? date + " " + time : date;
  }

  function textOf(element, selectors) {
    for (const selector of selectors) {
      const found = element.querySelector(selector);
      const value = found?.getAttribute("datetime") || found?.textContent?.trim();
      if (value) return value;
    }
    return null;
  }

  function tableValues(row) {
    const table = row.closest("table");
    if (!table) return () => null;
    const headers = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent.trim().toLowerCase());
    const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
    return (patterns) => {
      const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
      return index >= 0 ? cells[index] : null;
    };
  }

  function createCapture(source, parseRecord, readDom, options = {}) {
    const network = new Map();
    let dom = new Map();
    let timer;
    let paused = false;
    let capped = false;
    const pending = new Set();
    const waitTimeoutMs = Math.min(20000, Math.max(0, options.waitTimeoutMs || 0));
    const settleMs = Math.max(0, options.settleMs ?? 300);
    const records = () => [...(network.size ? network : dom).values()];
    const snapshot = () => ({
      ok: true, source, records: records(),
      warning: capped ? "Capture limit reached; narrow the portal date range and reload." :
        "Only loaded records are included; pagination and completeness are not verified."
    });
    const notify = () => { for (const check of [...pending]) check(); };

    // Use the existing shared MutationObserver to wake pending collections.
    // Keep each Chrome reply channel open until complete records have settled,
    // not merely until a skeleton/container appears. Every wait has a deadline.
    function waitForRecords(reply) {
      let done = false;
      let quietTimer;
      let lastSignature = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearTimeout(quietTimer);
        pending.delete(check);
        reply(result);
      };
      const check = () => {
        const current = records();
        const signature = current.length ? JSON.stringify(current) : null;
        if (signature === lastSignature) return;
        lastSignature = signature;
        clearTimeout(quietTimer);
        if (signature) quietTimer = setTimeout(() => finish(snapshot()), settleMs);
      };
      check.cancel = (error) => finish({ ok: false, source, error });
      const deadline = setTimeout(() => {
        // A busy/virtualized SPA may never become quiet. Return available data
        // at the deadline, but never claim that its pagination is complete.
        extractDom();
        finish(records().length ? snapshot() : {
          ok: false, source,
          error: options.emptyMessage || "Timed out waiting for supported portal records."
        });
      }, waitTimeoutMs);
      pending.add(check);
      check();
    }
    const put = (map, record) => {
      if (!record) return;
      const key = record.id ?? JSON.stringify(record);
      if (record._remove) { map.delete(key); return; }
      if (map.size >= MAX_RECORDS && !map.has(key)) { capped = true; return; }
      map.set(key, record);
    };

    function scan(root) {
      const queue = [{ value: root, depth: 0 }];
      const seen = new WeakSet();
      for (let index = 0; index < queue.length && index < MAX_NODES; index += 1) {
        const { value, depth } = queue[index];
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if (!Array.isArray(value)) put(network, parseRecord(value));
        if (depth >= 8) continue;
        for (const child of Object.values(value)) {
          if (queue.length >= MAX_NODES) { capped = true; break; }
          if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
        }
      }
    }

    function extractDom() {
      if (paused) return;
      const next = new Map();
      try { readDom((candidate) => put(next, parseRecord(candidate))); }
      catch { /* A selector failure must not break the host page. */ }
      dom = next;
      notify();
    }

    window.addEventListener("message", (event) => {
      if (paused || event.source !== window || event.origin !== location.origin ||
          event.data?.source !== MESSAGE_SOURCE || event.data?.type !== "NETWORK_RESPONSE") return;
      // MAIN-world messages can be forged by the host page. They carry data only,
      // never commands, URLs to fetch, or privileged extension actions.
      try { scan(event.data.payload); } catch { /* Invalid schema: use DOM fallback. */ }
      notify();
    });

    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return false;
      if (message?.type === "CLEAR_CAPTURE") {
        paused = true;
        clearTimeout(timer);
        timer = null;
        network.clear();
        dom.clear();
        capped = false;
        for (const check of [...pending]) check.cancel("Capture cleared while waiting for portal data.");
        reply({ ok: true });
      } else if (message?.type === "COLLECT_NOW") {
        paused = false;
        extractDom();
        if (waitTimeoutMs) {
          waitForRecords(reply);
          return true; // Required for asynchronous sendResponse in Chrome MV3.
        }
        // API and DOM representations are not combined to avoid double-counting.
        reply(snapshot());
      } else return false;
      return false;
    });

    const observer = new MutationObserver(() => {
      if (paused || timer) return;
      // Throttle, not trailing debounce: a busy SPA cannot starve collection.
      timer = setTimeout(() => { timer = null; extractDom(); }, options.observeThrottleMs ?? 500);
    });
    // documentElement may not exist yet at document_start.
    const observerOptions = {
      childList: true, subtree: true, characterData: true,
      // Hydration may update only attributes on nodes that already exist.
      attributes: true,
      attributeFilter: ["datetime", "href", "class", "data-testid", "data-test", "data-field",
        "data-trip-id", "data-reservation-id", "data-vehicle-id", "data-listing-id", "data-status",
        "data-start", "data-end", "data-start-time", "data-end-time", "data-start-date-time",
        "data-end-date-time", "aria-busy"]
    };
    observer.observe(document, observerOptions);
    window.addEventListener("pagehide", () => {
      clearTimeout(timer);
      timer = null;
      observer.disconnect();
      for (const check of [...pending]) check.cancel("Portal navigated away while waiting for data. Try sync again.");
    });
    window.addEventListener("pageshow", () => {
      observer.observe(document, observerOptions); // Also handles back/forward cache restore.
      extractDom();
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", extractDom, { once: true });
    else extractDom();
  }

  globalThis.TollCapture = Object.freeze({ scalar, pick, timestamp, textOf, tableValues, createCapture });
})();
