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

  function createCapture(source, parseRecord, readDom) {
    const network = new Map();
    let dom = new Map();
    let timer;
    let paused = false;
    let capped = false;
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
    }

    window.addEventListener("message", (event) => {
      if (paused || event.source !== window || event.origin !== location.origin ||
          event.data?.source !== MESSAGE_SOURCE || event.data?.type !== "NETWORK_RESPONSE") return;
      // MAIN-world messages can be forged by the host page. They carry data only,
      // never commands, URLs to fetch, or privileged extension actions.
      try { scan(event.data.payload); } catch { /* Invalid schema: use DOM fallback. */ }
    });

    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return false;
      if (message?.type === "CLEAR_CAPTURE") {
        paused = true;
        clearTimeout(timer);
        network.clear();
        dom.clear();
        capped = false;
        reply({ ok: true });
      } else if (message?.type === "COLLECT_NOW") {
        paused = false;
        extractDom();
        // Do not combine API and DOM representations: different IDs could make
        // one toll appear twice. Network data takes precedence for this tab.
        const records = [...(network.size ? network : dom).values()];
        reply({
          ok: true, source, records,
          warning: capped ? "Capture limit reached; narrow the portal date range and reload." :
            "Only loaded records are included; pagination and completeness are not verified."
        });
      } else return false;
      return false;
    });

    const observer = new MutationObserver(() => {
      if (paused || timer) return;
      // Throttle, not trailing debounce: a busy SPA cannot starve collection.
      timer = setTimeout(() => { timer = null; extractDom(); }, 500);
    });
    // documentElement may not exist yet at document_start.
    observer.observe(document, { childList: true, subtree: true, characterData: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", extractDom, { once: true });
    else extractDom();
  }

  globalThis.TollCapture = Object.freeze({ scalar, pick, timestamp, textOf, tableValues, createCapture });
})();
