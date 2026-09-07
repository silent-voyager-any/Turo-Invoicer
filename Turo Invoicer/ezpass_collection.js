(() => {
  "use strict";

  const TRANSACTIONS_PATH = "/ezpass/dashboard/transactions";
  const MAX_TOTAL_PAGES = 500;
  const RUN_TIMEOUT_MS = 300000;
  const PAGE_TIMEOUT_MS = 10000;
  const SETTLE_MS = 350;
  const EMPTY_SETTLE_MS = 1800;

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

  function paginationRoot() {
    const candidates = controls(transactionMain(), 'nav[aria-label="pagination navigation"], nav[aria-label="Pagination navigation"]')
      .filter(isVisible);
    if (candidates.length > 1) throw new Error("E-ZPass pagination controls are ambiguous.");
    return candidates[0] || null;
  }

  function activePageNumber() {
    const root = paginationRoot();
    if (!root) return null;
    const candidates = buttons(root).filter((node) => isVisible(node) &&
      (node.getAttribute?.("aria-current") === "true" || node.getAttribute?.("aria-current") === "page"));
    if (candidates.length !== 1) return null;
    const match = String(candidates[0].getAttribute?.("aria-label") || "").match(/^page (\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  function controlHint(node) {
    const labels = [...(node?.labels || [])].map(normalizedText).join(" ");
    return [node?.getAttribute?.("aria-label"), node?.getAttribute?.("placeholder"),
      node?.getAttribute?.("name"), node?.getAttribute?.("id"), labels].filter(Boolean).join(" ");
  }

  function hasActivePortalFilters() {
    return controls(transactionMain(), "input").some((node) => {
      if (!isVisible(node) || !/(?:date|mm\/dd|tag|plate)/i.test(controlHint(node))) return false;
      return String(node.value || "").trim().length > 0;
    });
  }

  function hasDescendingTransactionSort() {
    return controls(transactionMain(), "th, [role='columnheader']").some((node) =>
      /(?:transaction|exit|passage).*date|date.*(?:transaction|exit|passage)/i.test(normalizedText(node)) &&
      node.getAttribute?.("aria-sort") === "descending");
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
    const pageNumber = activePageNumber();
    const noTransactions = /\bno transactions found\b/i.test(document.body?.innerText || document.body?.textContent || "");
    const signature = JSON.stringify([pageNumber, ...raw.map((item) => [
      item.transactionId, item.timestamp, item.transactionDate, item.transactionTime, item.amount, item.tagOrPlate
    ])]);
    return { raw, records, noTransactions, signature, pageNumber, hasPager: Boolean(paginationRoot()) };
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

  async function settledPage(readDom, parseRecord, previousSignature = null, expectedPageNumber = null) {
    let stableSince = 0, last = null;
    return waitFor(() => {
      const sample = samplePage(readDom, parseRecord);
      const pageAdvanced = expectedPageNumber == null || sample.pageNumber === expectedPageNumber;
      // The live portal briefly removes the table and renders "No transactions
      // found" after a pager click. Never accept that placeholder while an
      // expected page transition is pending.
      const genuineEmpty = expectedPageNumber == null && sample.noTransactions && !sample.hasPager;
      const meaningful = pageAdvanced && (sample.raw.length || genuineEmpty);
      if (!meaningful || previousSignature && sample.signature === previousSignature) {
        stableSince = 0; last = sample.signature; return null;
      }
      if (last !== sample.signature) { last = sample.signature; stableSince = Date.now(); return null; }
      const requiredSettle = sample.raw.length ? SETTLE_MS : EMPTY_SETTLE_MS;
      return Date.now() - stableSince >= requiredSettle ? sample : null;
    }, PAGE_TIMEOUT_MS, "E-ZPass results did not finish loading after filtering or pagination.");
  }

  function localTimestampKey(value) {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().replace(/\D/g, "").slice(0, 14);
    const text = String(value || "").trim();
    let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?\s*(AM|PM)?)?/i);
    if (match) {
      let [, month, day, year, hour = "0", minute = "0", second = "0", meridiem] = match;
      year = year.length === 2 ? `20${year}` : year;
      hour = Number(hour);
      const minuteNumber = Number(minute), secondNumber = Number(second);
      if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        hour = hour % 12 + (/pm/i.test(meridiem) ? 12 : 0);
      } else if (hour < 0 || hour > 23) return null;
      if (minuteNumber > 59 || secondNumber > 59) return null;
      const parts = [Number(year), Number(month), Number(day), hour, minuteNumber, secondNumber];
      const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
      if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() + 1 !== parts[1] ||
          check.getUTCDate() !== parts[2] || check.getUTCHours() !== parts[3]) return null;
      return parts.map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("");
    }
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
    const parts = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)];
    const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
    if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() + 1 !== parts[1] ||
        check.getUTCDate() !== parts[2] || check.getUTCHours() !== parts[3] ||
        check.getUTCMinutes() !== parts[4] || check.getUTCSeconds() !== parts[5]) return null;
    return `${year}${month}${day}${hour}${minute}${second}`;
  }

  function nextControl() {
    const root = paginationRoot();
    const matches = root ? buttons(root).filter((node) => isVisible(node) &&
      /^go to next page$/i.test(String(node.getAttribute?.("aria-label") || normalizedText(node)))) : [];
    if (matches.length > 1) throw new Error("E-ZPass Next pagination control is ambiguous.");
    return matches[0] || null;
  }

  function previousControl() {
    const root = paginationRoot();
    const matches = root ? buttons(root).filter((node) => isVisible(node) &&
      /^go to previous page$/i.test(String(node.getAttribute?.("aria-label") || normalizedText(node)))) : [];
    if (matches.length > 1) throw new Error("E-ZPass Previous pagination control is ambiguous.");
    return matches[0] || null;
  }

  async function maximizePageSize(page, readDom, parseRecord) {
    // A single-page result cannot benefit from changing the page size. Skipping
    // the control also avoids waiting for a signature change the portal will
    // never produce when every row already fits on page 1.
    const currentNext = nextControl();
    if (currentNext && isDisabled(currentNext)) return page;
    const combos = controls(transactionMain(), '[role="combobox"][aria-label="View"]')
      .filter(isVisible);
    if (combos.length !== 1 || /\b100\b/.test(normalizedText(combos[0]))) return page;
    combos[0].click();
    const option = await waitFor(() => {
      const matches = controls(document, '[role="option"]')
        .filter((node) => isVisible(node) && /^100$/.test(normalizedText(node)));
      return matches.length === 1 ? matches[0] : null;
    }, 2000, "E-ZPass page-size menu did not expose a unique 100-row option.");
    option.click();
    assertRoute("page-size selection");
    return settledPage(readDom, parseRecord, page.signature, 1);
  }

  function rawTimestamp(item) {
    return item?.timestamp || item?.transactionDateTime ||
      [item?.transactionDate, item?.transactionTime].filter(Boolean).join(" ");
  }

  function pageChronology(page, previousOldest = null) {
    const keys = page.raw.map((item) => localTimestampKey(rawTimestamp(item))).filter(Boolean);
    const complete = keys.length === page.raw.length && keys.length > 0;
    const descending = complete && keys.every((key, index) => index === 0 || key <= keys[index - 1]);
    const newest = keys.length ? [...keys].sort().at(-1) : null;
    const oldest = keys.length ? [...keys].sort()[0] : null;
    return { keys, complete, descending: descending && (!previousOldest || newest <= previousOldest), newest, oldest };
  }

  async function rewindToFirstPage(page, readDom, parseRecord, deadline) {
    const signatures = new Set([page.signature]);
    for (let count = 0; count < MAX_TOTAL_PAGES; count += 1) {
      if (Date.now() >= deadline) throw new Error("E-ZPass collection exceeded its five-minute safety deadline.");
      const previous = previousControl();
      if (!previous) throw new Error("E-ZPass Previous pagination control is missing.");
      if (isDisabled(previous)) {
        if (page.pageNumber !== 1) throw new Error("E-ZPass disabled Previous before reaching page 1.");
        return page;
      }
      if (!Number.isInteger(page.pageNumber) || page.pageNumber <= 1) throw new Error("E-ZPass current page number is unavailable while rewinding.");
      const expected = page.pageNumber - 1;
      previous.click();
      assertRoute("pagination rewind");
      page = await settledPage(readDom, parseRecord, page.signature, expected);
      if (signatures.has(page.signature)) throw new Error("E-ZPass repeated a result page while rewinding.");
      signatures.add(page.signature);
    }
    throw new Error("E-ZPass pagination rewind reached its safety cap.");
  }

  async function collect({ range, parseRecord, readDom }) {
    range = validateRange(range);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    if (hasActivePortalFilters()) {
      throw new Error("E-ZPass has an active date, tag, or plate filter. Clear the portal filters, reload the transactions page, and sync again.");
    }
    const records = new Map();
    let rawCount = 0, pageCount = 0, terminalReason = "empty_range";
    let ordering = hasDescendingTransactionSort() ? "descending" : "unverified";
    let observedStart = null, observedEnd = null, previousOldest = null;
    let page = await settledPage(readDom, parseRecord);
    if (!page.noTransactions) page = await rewindToFirstPage(page, readDom, parseRecord, deadline);
    if (!page.noTransactions) page = await maximizePageSize(page, readDom, parseRecord);
    const signatures = new Set();
    for (;;) {
      if (Date.now() >= deadline) throw new Error("E-ZPass collection exceeded its five-minute safety deadline.");
      if (pageCount >= MAX_TOTAL_PAGES) throw new Error("E-ZPass pagination safety cap reached.");
      if (signatures.has(page.signature)) throw new Error("E-ZPass repeated a result page instead of advancing.");
      signatures.add(page.signature);
      pageCount += 1;
      rawCount += page.raw.length;
      const chronology = pageChronology(page, previousOldest);
      if (!chronology.descending) ordering = "unverified";
      if (chronology.oldest) {
        const oldestDate = `${chronology.oldest.slice(0, 4)}-${chronology.oldest.slice(4, 6)}-${chronology.oldest.slice(6, 8)}`;
        const newestDate = `${chronology.newest.slice(0, 4)}-${chronology.newest.slice(4, 6)}-${chronology.newest.slice(6, 8)}`;
        observedStart = !observedStart || oldestDate < observedStart ? oldestDate : observedStart;
        observedEnd = !observedEnd || newestDate > observedEnd ? newestDate : observedEnd;
        previousOldest = chronology.oldest;
      }
      for (const record of page.records) {
        const stamp = localTimestampKey(record.timestamp);
        const date = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : null;
        if (!date || date < range.startDate || date > range.endDate) continue;
        const key = record.id || JSON.stringify(record);
        const prior = records.get(key);
        if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error("E-ZPass returned conflicting duplicate transaction IDs.");
        records.set(key, record);
      }

      if (page.noTransactions && !page.records.length) { terminalReason = "empty_range"; break; }
      if (ordering === "descending" && chronology.complete && chronology.newest.slice(0, 8) < range.startDate.replace(/-/g, "")) {
        terminalReason = "older_than_required_range";
        break;
      }
      const next = nextControl();
      if (!next) throw new Error("E-ZPass Next pagination control is missing from a nonempty result page.");
      if (isDisabled(next)) { terminalReason = "next_disabled"; break; }
      if (!Number.isInteger(page.pageNumber)) throw new Error("E-ZPass current page number is unavailable before advancing.");
      const expected = page.pageNumber + 1;
      next.click();
      assertRoute("pagination");
      page = await settledPage(readDom, parseRecord, page.signature, expected);
    }

    return {
      records: [...records.values()], complete: true, pageCount, rawCount,
      completeForRange: true, chunkCount: 1, range, requestedRange: range,
      observedRange: observedStart && observedEnd ? { startDate: observedStart, endDate: observedEnd } : null,
      ordering, terminalReason, lastPage: page.pageNumber || pageCount
    };
  }

  globalThis.EzpassCollection = Object.freeze({
    validateRange, collect,
    testing: Object.freeze({ hasActivePortalFilters, hasDescendingTransactionSort, localTimestampKey, pageChronology,
      paginationRoot, activePageNumber, nextControl, previousControl, maximizePageSize, rewindToFirstPage, assertRoute }),
    constants: Object.freeze({ MAX_TOTAL_PAGES })
  });
})();
