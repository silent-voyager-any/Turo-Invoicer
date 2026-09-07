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
      const canonical = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const entry = entries.find(([key, value]) => canonical(key) === canonical(alias) && value != null && value !== "");
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
    const table = row.closest('table, [role="grid"], [role="table"]');
    const normalize = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let headerNodes = table ? [...table.querySelectorAll('thead th, [role="columnheader"]')] : [];
    if (!headerNodes.length && table) {
      // Legacy tables can render their header in the first tbody row.
      headerNodes = [...(table.querySelector("tr")?.querySelectorAll("th, td") || [])];
    }
    const headers = headerNodes.map((cell) => normalize(cell.textContent));
    const cells = [...row.querySelectorAll('td, [role="gridcell"], [role="cell"]')];
    return (patterns) => {
      for (const pattern of patterns) {
        const index = cells.findIndex((cell, index) => {
          const labelled = cell.getAttribute("data-label") || cell.getAttribute("data-title");
          const column = Number(cell.getAttribute("aria-colindex")) || index + 1;
          return pattern.test(labelled ? normalize(labelled) : headers[column - 1] || "");
        });
        if (index >= 0) return cells[index].querySelector?.("time[datetime]")?.getAttribute("datetime") || cells[index].textContent.trim();
      }
      return null;
    };
  }

  function createCapture(source, parseRecord, readDom, options = {}) {
    const network = new Map();
    let dom = new Map();
    let timer;
    let paused = false;
    let capped = false;
    let networkMessages = 0;
    let domCandidates = 0;
    const pagePath = () => new URL(location.href).pathname.replace(/\/$/, "");
    let capturePath = pagePath();
    const pending = new Set();
    const waitTimeoutMs = Math.min(20000, Math.max(0, options.waitTimeoutMs || 0));
    const settleMs = Math.max(0, options.settleMs ?? 300);
    const records = () => [...(network.size ? network : dom).values()];
    const snapshot = (current = records()) => {
      const proof = options.completeness?.(current) || {};
      const complete = proof.complete === true && !capped;
      return {
        ok: true, source, records: current, ...(options.isPageAllowed ? { pagePath: capturePath } : {}),
        complete, pageCount: Number.isInteger(proof.pageCount) ? proof.pageCount : 1,
        rawCount: current.length, terminalReason: proof.terminalReason || null,
        warning: capped ? "Capture limit reached; narrow the portal date range and reload." : complete ? null :
          "Only loaded records are included; pagination and completeness are not verified."
      };
    };
    const notify = () => { for (const check of [...pending]) check(); };
    function checkPage() {
      const path = pagePath();
      if (options.isPageAllowed && (path !== capturePath || !options.isPageAllowed(path))) {
        network.clear();
        dom.clear();
        capped = false;
        networkMessages = 0;
        domCandidates = 0;
        for (const check of [...pending]) check.cancel(options.pageMessage || "Portal left the supported data page. Return and sync again.");
        options.enrichment?.reset();
      }
      capturePath = path;
      return !options.isPageAllowed || options.isPageAllowed(path);
    }

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
        if (!pending.size) options.enrichment?.reset();
        reply(result);
      };
      const check = () => {
        if (done) return;
        if (!checkPage()) return;
        // Detail reads start only inside an explicit collection, never during
        // passive DOM observation. Missing details cannot yield partial success.
        const enriched = options.enrichment?.refresh(records(), notify);
        if (enriched?.error) { finish({ ok: false, source, error: enriched.error }); return; }
        if (enriched?.pending) {
          clearTimeout(quietTimer);
          lastSignature = null;
          return;
        }
        const current = enriched?.records || records();
        const signature = current.length ? JSON.stringify(current) : null;
        if (signature === lastSignature) return;
        lastSignature = signature;
        clearTimeout(quietTimer);
        if (signature) quietTimer = setTimeout(() => {
          // SPA route changes do not always produce a DOM mutation.
          if (!checkPage()) return;
          const latest = options.enrichment?.refresh(records(), notify);
          if (latest?.pending || latest?.error || latest && JSON.stringify(latest.records) !== signature) {
            lastSignature = null;
            check();
          } else {
            const result = snapshot(current);
            // Adapters with an explicit terminal proof (currently Turo
            // history) must keep waiting after records first appear. A stable
            // partial list is not a complete history snapshot.
            if (typeof options.completeness === "function" && !result.complete) {
              lastSignature = null;
              return;
            }
            finish(result);
          }
        }, settleMs);
      };
      check.cancel = (error) => finish({ ok: false, source, error });
      const deadline = setTimeout(() => {
        // A busy/virtualized SPA may never become quiet. Return available data
        // at the deadline, but never claim that its pagination is complete.
        extractDom();
        if (done) return;
        const enriched = options.enrichment?.refresh(records(), notify);
        if (enriched?.error || enriched?.pending) {
          finish({ ok: false, source, error: enriched.error || enriched.timeoutError });
          return;
        }
        const current = enriched?.records || records();
        finish(current.length ? snapshot(current) : {
          ok: false, source,
          error: (options.emptyMessage || "Timed out waiting for supported portal records.") +
            ` Diagnostics: ${domCandidates} DOM row/card candidates, ${networkMessages} supported-path JSON responses observed; neither yielded complete records.`
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
      if (paused || !checkPage()) return;
      const next = new Map();
      domCandidates = 0;
      try { readDom((candidate) => { domCandidates += 1; put(next, parseRecord(candidate)); }); }
      catch { /* A selector failure must not break the host page. */ }
      dom = next;
      notify();
    }

    window.addEventListener("message", (event) => {
      if (paused || event.source !== window || event.origin !== location.origin ||
          event.data?.source !== MESSAGE_SOURCE || event.data?.type !== "NETWORK_RESPONSE") return;
      if (!checkPage() || (options.isPageAllowed && event.data.pagePath !== capturePath)) return;
      networkMessages += 1;
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
        networkMessages = 0;
        domCandidates = 0;
        for (const check of [...pending]) check.cancel("Capture cleared while waiting for portal data.");
        options.enrichment?.reset();
        reply({ ok: true });
      } else if (message?.type === "COLLECT_NOW") {
        const collectReply = (value) => reply({
          ...value,
          ...(options.collectorRevision ? { collectorRevision: options.collectorRevision } : {})
        });
        if (!checkPage()) {
          collectReply({ ok: false, source, error: options.pageMessage || "Open the supported data page and sync again." });
          return false;
        }
        paused = false;
        if (typeof options.collect === "function" && message.range) {
          Promise.resolve(options.collect({ range: message.range, parseRecord, readDom }))
            .then((result) => collectReply({ ok: true, source, pagePath: capturePath, ...result }))
            .catch((error) => collectReply({ ok: false, source, error: error?.message || "Portal collection failed." }));
          return true;
        }
        extractDom();
        if (waitTimeoutMs) {
          waitForRecords(collectReply);
          return true; // Required for asynchronous sendResponse in Chrome MV3.
        }
        // API and DOM representations are not combined to avoid double-counting.
        collectReply(snapshot());
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
        "data-end-date-time", "aria-busy", "data-label", "data-title", "aria-colindex",
        "data-amount", "data-timestamp", "data-transaction-date", "data-transaction-time", "data-plaza"]
    };
    observer.observe(document, observerOptions);
    window.addEventListener("pagehide", () => {
      clearTimeout(timer);
      timer = null;
      observer.disconnect();
      if (options.isPageAllowed) { network.clear(); dom.clear(); }
      for (const check of [...pending]) check.cancel("Portal navigated away while waiting for data. Try sync again.");
      options.enrichment?.reset();
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
