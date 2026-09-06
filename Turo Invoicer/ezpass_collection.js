(() => {
  "use strict";

  const TRANSACTIONS_PATH = "/ezpass/dashboard/transactions";
  const CHUNK_DAYS = 14;
  const MAX_TOTAL_PAGES = 500;
  const MAX_PAGES_PER_CHUNK = 100;
  const RUN_TIMEOUT_MS = 120000;
  const PAGE_TIMEOUT_MS = 10000;
  const SETTLE_MS = 350;

  const isoParts = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
      ? { year, month, day, date } : null;
  };

  function validateRange(range) {
    const start = isoParts(range?.startDate), end = isoParts(range?.endDate);
    if (!start || !end || start.date > end.date) throw new Error("E-ZPass collection requires a valid completed-trip date range.");
    return { startDate: range.startDate, endDate: range.endDate };
  }

  const isoDate = (date) => date.toISOString().slice(0, 10);
  function chunkDateRange(range, days = CHUNK_DAYS) {
    range = validateRange(range);
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("Invalid E-ZPass date chunk size.");
    const chunks = [];
    let cursor = isoParts(range.startDate).date;
    const end = isoParts(range.endDate).date;
    while (cursor <= end) {
      const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (days - 1) * 86400000));
      chunks.push({ startDate: isoDate(cursor), endDate: isoDate(chunkEnd) });
      cursor = new Date(chunkEnd.getTime() + 86400000);
    }
    return chunks;
  }

  const portalDate = (value) => {
    const { year, month, day } = isoParts(value);
    return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(year).slice(-2)}`;
  };
  const compactPortalDate = (value) => {
    const { year, month, day } = isoParts(value);
    return `${month}/${day}/${String(year).slice(-2)}`;
  };
  const normalizedText = (node) => String(node?.textContent || node?.getAttribute?.("aria-label") ||
    node?.getAttribute?.("title") || node?.getAttribute?.("value") || "")
    .replace(/\s+/g, " ").trim();
  const controls = (root, selector) => [...(root || document).querySelectorAll(selector)];
  const buttons = (root = document) => controls(root,
    "button, [role='button'], input[type='submit'], input[type='button']");
  const isDisabled = (node) => Boolean(node?.disabled || node?.getAttribute?.("aria-disabled") === "true");
  const isVisible = (node) => Boolean(node && !node.hidden && node.getAttribute?.("aria-hidden") !== "true" &&
    (node.offsetParent !== null || node.getClientRects?.().length));

  function transactionMain() {
    return document.querySelector("main, [role='main']") || document.body;
  }

  function uniqueVisibleButton(root, pattern, label) {
    const matches = buttons(root).filter((node) => isVisible(node) && pattern.test(normalizedText(node)));
    if (matches.length !== 1) throw new Error(`Expected exactly one visible E-ZPass ${label} control; found ${matches.length}.`);
    return matches[0];
  }

  function mainButton(pattern, label) {
    return uniqueVisibleButton(transactionMain(), pattern, label);
  }

  function dateInputs(visibleOnly = false) {
    const inputs = controls(transactionMain(), "input").filter((node) => {
      const hint = `${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("placeholder") || ""}`;
      return /date|mm\/dd/i.test(hint);
    });
    return visibleOnly ? inputs.filter(isVisible) : inputs;
  }

  function requireVisibleDateInputs() {
    const inputs = dateInputs(true);
    if (inputs.length !== 2) throw new Error(`Expected exactly two visible E-ZPass date inputs; found ${inputs.length}.`);
    return inputs;
  }

  function commonAncestor(left, right) {
    const rightAncestors = new Set();
    for (let node = right; node; node = node.parentElement) rightAncestors.add(node);
    for (let node = left; node; node = node.parentElement) if (rightAncestors.has(node)) return node;
    return null;
  }

  function filterSearchButton(inputs) {
    const main = transactionMain();
    let container = commonAncestor(inputs?.[0], inputs?.[1]);
    // E-ZPass renders field labels in sibling component trees, so their text is
    // not guaranteed to be present on the inputs' shared ancestor. Starting at
    // that ancestor still proves proximity; walking only through `main` keeps
    // the portal header's unrelated Search controls out of scope.
    while (container) {
      const searches = buttons(container).filter((node) => isVisible(node) && /^search$/i.test(normalizedText(node)));
      if (searches.length > 1) throw new Error("E-ZPass transaction filter contains multiple visible Search controls.");
      if (searches.length === 1) {
        if (isDisabled(searches[0])) throw new Error("E-ZPass transaction-filter Search control is disabled.");
        return searches[0];
      }
      if (container === main) break;
      container = container.parentElement;
    }
    throw new Error("E-ZPass transaction-filter Search control was not found in the date-filter region.");
  }

  function setInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("E-ZPass date input is not editable.");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const currentPath = () => new URL(location.href).pathname.replace(/\/$/, "");
  function assertRoute(phase = "collection") {
    const path = currentPath();
    if (path !== TRANSACTIONS_PATH) throw new Error(`E-ZPass left the transactions page during ${phase} (${path || "/"}).`);
  }

  function samplePage(readDom, parseRecord) {
    const raw = [], records = [];
    readDom((candidate) => {
      raw.push(candidate);
      const parsed = parseRecord(candidate);
      if (parsed) records.push(parsed);
    });
    const active = buttons().find((node) => node.getAttribute?.("aria-current") === "page") ||
      buttons().find((node) => /^page \d+$/i.test(normalizedText(node)));
    const noTransactions = /\bno transactions found\b/i.test(document.body?.innerText || document.body?.textContent || "");
    const signature = JSON.stringify([normalizedText(active), ...raw.map((item) => [
      item.transactionId, item.timestamp, item.transactionDate, item.transactionTime, item.amount, item.tagOrPlate
    ])]);
    return { raw, records, noTransactions, signature };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate, timeoutMs, message) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      assertRoute(message);
      const value = predicate();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(message);
  }

  async function settledPage(readDom, parseRecord, previousSignature = null, expectedRange = null) {
    let stableSince = 0, last = null;
    return waitFor(() => {
      const sample = samplePage(readDom, parseRecord);
      const rangeText = buttons().map(normalizedText).find((text) => text.includes("-") && /\d+\/\d+\/\d+/.test(text)) || "";
      const rangeReady = !expectedRange || (rangeText.includes(compactPortalDate(expectedRange.startDate)) &&
        rangeText.includes(compactPortalDate(expectedRange.endDate)));
      const meaningful = sample.raw.length || sample.noTransactions;
      if (!rangeReady || !meaningful || previousSignature && sample.signature === previousSignature) {
        stableSince = 0; last = sample.signature; return null;
      }
      if (last !== sample.signature) { last = sample.signature; stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= SETTLE_MS ? sample : null;
    }, PAGE_TIMEOUT_MS, "E-ZPass results did not finish loading after filtering or pagination.");
  }

  async function applyRange(range, readDom, parseRecord) {
    assertRoute("filter setup");
    const transactionDate = mainButton(/^transaction date$/i, "Transaction Date");
    transactionDate.click();
    assertRoute("Transaction Date selection");
    let inputs = dateInputs(true);
    if (!inputs.length) {
      const filter = mainButton(/^filter$/i, "Filter");
      filter.click();
      assertRoute("filter-panel opening");
      inputs = await waitFor(() => {
        const found = dateInputs(true);
        if (found.length > 2) throw new Error(`Expected exactly two visible E-ZPass date inputs; found ${found.length}.`);
        return found.length === 2 ? found : null;
      }, 3000, "E-ZPass date filter controls were not found.");
    } else inputs = requireVisibleDateInputs();
    setInput(inputs[0], portalDate(range.startDate));
    setInput(inputs[1], portalDate(range.endDate));
    const search = await waitFor(() => {
      try { return filterSearchButton(inputs); }
      catch (error) {
        if (/disabled/.test(error.message)) return null;
        throw error;
      }
    }, 3000, "E-ZPass did not enable its Search control for the requested dates.");
    search.click();
    assertRoute("transaction-filter search");
    return settledPage(readDom, parseRecord, null, range);
  }

  function nextControl() {
    return buttons(transactionMain()).find((node) => /(?:go to )?next page/i.test(normalizedText(node)));
  }

  async function collect({ range, parseRecord, readDom }) {
    range = validateRange(range);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    const chunks = chunkDateRange(range);
    const records = new Map();
    let rawCount = 0, pageCount = 0, terminalReason = "empty_range";

    for (const chunk of chunks) {
      if (Date.now() >= deadline) throw new Error("E-ZPass collection exceeded its two-minute safety deadline.");
      let page = await applyRange(chunk, readDom, parseRecord);
      const pageSignatures = new Set();
      for (let chunkPages = 0; ; chunkPages += 1) {
        if (Date.now() >= deadline) throw new Error("E-ZPass collection exceeded its two-minute safety deadline.");
        if (chunkPages >= MAX_PAGES_PER_CHUNK || pageCount >= MAX_TOTAL_PAGES) {
          throw new Error("E-ZPass pagination safety cap reached; narrow the completed-trip range.");
        }
        if (pageSignatures.has(page.signature)) throw new Error("E-ZPass repeated a result page instead of advancing.");
        pageSignatures.add(page.signature);
        pageCount += 1;
        rawCount += page.raw.length;
        for (const record of page.records) {
          const key = record.id || JSON.stringify(record);
          const prior = records.get(key);
          if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error("E-ZPass returned conflicting duplicate transaction IDs.");
          records.set(key, record);
        }

        const next = nextControl();
        if (page.noTransactions && !page.records.length) { terminalReason = "empty_range"; break; }
        if (!next) throw new Error("E-ZPass pagination controls are missing from a nonempty result page.");
        if (isDisabled(next)) { terminalReason = "next_disabled"; break; }
        const previous = page.signature;
        next.click();
        assertRoute("pagination");
        page = await settledPage(readDom, parseRecord, previous);
      }
    }

    return {
      records: [...records.values()], complete: true, pageCount, rawCount,
      chunkCount: chunks.length, range, terminalReason
    };
  }

  globalThis.EzpassCollection = Object.freeze({
    validateRange, chunkDateRange, portalDate, collect,
    testing: Object.freeze({ uniqueVisibleButton, requireVisibleDateInputs, filterSearchButton, assertRoute }),
    constants: Object.freeze({ CHUNK_DAYS, MAX_TOTAL_PAGES, MAX_PAGES_PER_CHUNK })
  });
})();
