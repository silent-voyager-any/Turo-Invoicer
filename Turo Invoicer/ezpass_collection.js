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
    try {
      // MUI mounts its listbox outside the table and opens it on pointer-style
      // interaction. Dispatching mousedown before click mirrors that contract.
      combos[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      combos[0].click();
      const option = await waitFor(() => {
        const matches = controls(document, '[role="option"]')
          .filter((node) => isVisible(node) && /^100$/.test(normalizedText(node)));
        return matches.length === 1 ? matches[0] : null;
      }, 2000, "page-size option unavailable");
      option.click();
      assertRoute("page-size selection");
      return await settledPage(readDom, parseRecord, page.signature, 1);
    } catch {
      // Page size is an optimization, never a completeness requirement. The
      // pager below still proves and collects every result page.
      assertRoute("page-size selection");
      return page;
    }
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

  async function collectRange({ range, parseRecord, readDom }) {
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

  const inputDate = (value) => {
    const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!match) return null;
    const year = match[3].length === 2 ? Number(`20${match[3]}`) : Number(match[3]);
    const candidate = `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
    return isoParts(candidate) ? candidate : null;
  };

  function visibleDateInputs() {
    const inputs = controls(transactionMain(), "input").filter((node) => isVisible(node) &&
      /date|mm\/dd/i.test([node.getAttribute?.("aria-label"), node.getAttribute?.("placeholder"),
        node.getAttribute?.("name"), ...(node.labels || [])].map((item) => normalizedText(item)).join(" ")));
    if (inputs.length !== 2) throw new Error(`Expected exactly two visible E-ZPass date inputs; found ${inputs.length}.`);
    const hint = (node) => [node.getAttribute?.("aria-label"), node.getAttribute?.("name"),
      ...(node.labels || [])].map((item) => normalizedText(item)).join(" ");
    const start = inputs.find((node) => /start/i.test(hint(node)));
    const end = inputs.find((node) => /end/i.test(hint(node)));
    return start && end && start !== end ? [start, end] : inputs;
  }

  async function ensureFilterOpen() {
    if (controls(transactionMain(), "input").some((node) => isVisible(node) && /startdate|start date/i.test(controlHint(node)))) return;
    const matches = buttons(transactionMain()).filter((node) => isVisible(node) && /^filter$/i.test(normalizedText(node)));
    if (matches.length !== 1) throw new Error("E-ZPass transaction Filter control is missing or ambiguous.");
    matches[0].click();
    await waitFor(() => {
      try { return visibleDateInputs(); } catch { return null; }
    }, 3000, "E-ZPass transaction filters did not open.");
  }

  function datePickerButton(input) {
    for (let root = input.parentElement; root && root !== transactionMain(); root = root.parentElement) {
      const matches = buttons(root).filter((node) => isVisible(node) && /^choose date$/i.test(normalizedText(node)));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) break;
    }
    throw new Error("E-ZPass calendar button is missing beside a date input.");
  }

  const monthIndex = (name) => ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"].indexOf(String(name).toLowerCase());

  function dialogMonth(dialog) {
    for (const node of controls(dialog, "*")) {
      const match = normalizedText(node).match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
      if (match) return { month: monthIndex(match[1]), year: Number(match[2]) };
    }
    return null;
  }

  async function setCalendarDate(input, iso) {
    if (inputDate(input.value) === iso) return;
    const target = isoParts(iso);
    datePickerButton(input).click();
    const dialog = await waitFor(() => controls(document, '[role="dialog"]').find(isVisible), 3000,
      "E-ZPass calendar did not open.");
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const shown = dialogMonth(dialog);
      if (!shown) throw new Error("E-ZPass calendar month heading is unavailable.");
      const delta = (target.year - shown.year) * 12 + target.month - 1 - shown.month;
      if (!delta) break;
      const direction = delta > 0 ? /next month/i : /previous month/i;
      const nav = buttons(dialog).filter((node) => isVisible(node) && direction.test(normalizedText(node)));
      if (nav.length !== 1 || isDisabled(nav[0])) throw new Error("E-ZPass calendar cannot reach the requested trip date.");
      nav[0].click();
      await sleep(80);
    }
    const days = buttons(dialog).filter((node) => isVisible(node) && !isDisabled(node) &&
      normalizedText(node) === String(target.day));
    if (days.length !== 1) throw new Error("E-ZPass calendar day is missing or ambiguous.");
    days[0].click();
    await waitFor(() => inputDate(input.value) === iso, 2000, "E-ZPass did not accept a calendar date.");
  }

  function labelledCombo(label) {
    const matches = controls(transactionMain(), '[role="combobox"]')
      .filter((node) => isVisible(node) && new RegExp(`^${label}$`, "i").test(String(node.getAttribute?.("aria-label") || "")));
    if (matches.length !== 1) throw new Error(`E-ZPass ${label} filter is missing or ambiguous.`);
    return matches[0];
  }

  async function selectCombo(combo, matcher, label) {
    combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    combo.click();
    const option = await waitFor(() => {
      const matches = controls(document, '[role="option"]').filter((node) => isVisible(node) && matcher(normalizedText(node)));
      return matches.length === 1 ? matches[0] : null;
    }, 2500, `E-ZPass ${label} option is unavailable.`);
    option.click();
    await sleep(80);
  }

  function filterSearch(inputs) {
    let root = inputs[0].parentElement;
    while (root && root !== document.body) {
      if (root.contains(inputs[1])) {
        const matches = buttons(root).filter((node) => isVisible(node) && /^search$/i.test(normalizedText(node)));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error("E-ZPass transaction filter contains multiple Search controls.");
      }
      root = root.parentElement;
    }
    throw new Error("E-ZPass transaction-filter Search control was not found.");
  }

  function clearFilterButton() {
    const matches = buttons(transactionMain()).filter((node) => isVisible(node) && /^clear all$/i.test(normalizedText(node)));
    if (matches.length !== 1) throw new Error("E-ZPass Clear All control is missing or ambiguous.");
    return matches[0];
  }

  function snapshotFilters() {
    const inputs = visibleDateInputs();
    const type = labelledCombo("Type"), identifier = labelledCombo("Tag/Plate #"), view = controls(transactionMain(), '[role="combobox"][aria-label="View"]').filter(isVisible)[0];
    return { startDate: inputDate(inputs[0].value), endDate: inputDate(inputs[1].value),
      type: normalizedText(type), identifier: normalizedText(identifier), view: view ? normalizedText(view) : null };
  }

  async function restoreViewSize(value) {
    if (!value) return;
    const combos = controls(transactionMain(), '[role="combobox"][aria-label="View"]').filter(isVisible);
    if (combos.length !== 1 || normalizedText(combos[0]) === value) return;
    await selectCombo(combos[0], (option) => option === value, "restored page size");
    await sleep(200);
  }

  async function applyQuery(query, readDom, parseRecord) {
    assertRoute("trip filter setup");
    await ensureFilterOpen();
    const inputs = visibleDateInputs();
    await setCalendarDate(inputs[0], query.startDate);
    await setCalendarDate(inputs[1], query.endDate);
    await selectCombo(labelledCombo("Type"), (value) => /^toll$/i.test(value), "Toll type");
    const expected = String(query.canonicalIdentifier || "");
    await selectCombo(labelledCombo("Tag/Plate #"), (value) => portalCanonical(query.kind, value) === expected,
      "exact tag/plate");
    const search = filterSearch(inputs);
    await waitFor(() => !isDisabled(search) && search, 5000, "E-ZPass Search remained disabled after applying trip filters.");
    search.click();
    assertRoute("trip filter search");
    let page = await settledPage(readDom, parseRecord, null);
    const fits = (candidate) => candidate.noTransactions || candidate.records.every((record) => {
      const stamp = localTimestampKey(rawTimestamp(record));
      const date = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : null;
      return portalCanonical(query.kind, record.tagId || record.plate || record.tagOrPlate) === expected &&
        date >= query.startDate && date <= query.endDate;
    });
    if (!fits(page)) page = await settledPage(readDom, parseRecord, page.signature);
    if (!fits(page)) {
      throw new Error("E-ZPass results did not confirm the requested trip filters.");
    }
    return page;
  }

  async function restoreFilters(snapshot) {
    assertRoute("filter restoration");
    await ensureFilterOpen();
    clearFilterButton().click();
    await sleep(150);
    if (!snapshot.startDate || !snapshot.endDate) { await restoreViewSize(snapshot.view); return; }
    const inputs = visibleDateInputs();
    await setCalendarDate(inputs[0], snapshot.startDate);
    await setCalendarDate(inputs[1], snapshot.endDate);
    if (snapshot.type && !/^all$/i.test(snapshot.type)) await selectCombo(labelledCombo("Type"), (value) => value === snapshot.type, "restored Type");
    if (snapshot.identifier && !/^all tags$/i.test(snapshot.identifier)) {
      await selectCombo(labelledCombo("Tag/Plate #"), (value) => value === snapshot.identifier, "restored tag/plate");
    }
    const search = filterSearch(inputs);
    await waitFor(() => !isDisabled(search) && search, 5000, "E-ZPass Search remained disabled while restoring filters.");
    search.click();
    await sleep(350);
    await restoreViewSize(snapshot.view);
  }

  function validateQueries(queryJobs) {
    if (!Array.isArray(queryJobs) || !queryJobs.length || queryJobs.length > 500) throw new Error("E-ZPass requires 1-500 trip identifier searches.");
    return queryJobs.map((query) => {
      validateRange(query);
      if (!/^\d{1,20}$/.test(String(query.reservationId || "")) || !["tag", "plate"].includes(query.kind) ||
          !/^[A-Z0-9]+$/.test(String(query.canonicalIdentifier || ""))) throw new Error("E-ZPass received an invalid trip query.");
      return query;
    });
  }

  const portalCanonical = (kind, value) => {
    let text = String(value || "").trim().toUpperCase();
    if (kind === "plate") text = text.replace(/^[A-Z]{2}\s*[:|]\s*/, "");
    return text.replace(/[^A-Z0-9]/g, "");
  };

  async function collectFilteredPages(firstPage, query, readDom, parseRecord, onEvidencePage) {
    let page = firstPage;
    if (!page.noTransactions) page = await rewindToFirstPage(page, readDom, parseRecord, Date.now() + RUN_TIMEOUT_MS);
    if (!page.noTransactions) page = await maximizePageSize(page, readDom, parseRecord);
    const records = [], signatures = new Set();
    let pageCount = 0, rawCount = 0;
    for (;;) {
      if (signatures.has(page.signature)) throw new Error("E-ZPass repeated a filtered result page.");
      signatures.add(page.signature); pageCount += 1; rawCount += page.raw.length;
      records.push(...page.records);
      if (onEvidencePage && page.records.length) await onEvidencePage(query, page.records, pageCount);
      if (page.noTransactions && !page.records.length) break;
      const next = nextControl();
      if (!next) throw new Error("E-ZPass Next control is missing from filtered results.");
      if (isDisabled(next)) break;
      const expected = page.pageNumber + 1;
      next.click();
      page = await settledPage(readDom, parseRecord, page.signature, expected);
    }
    return { records, pageCount, rawCount };
  }

  async function collectQueries({ queryJobs, parseRecord, readDom, onEvidencePage }) {
    const queries = validateQueries(queryJobs);
    await ensureFilterOpen();
    const original = snapshotFilters();
    const records = new Map(), reports = [];
    let pages = 0, rawCount = 0, primaryError = null;
    try {
      for (const query of queries) {
        let first;
        try { first = await applyQuery(query, readDom, parseRecord); }
        catch (error) { throw new Error(`Trip ${query.reservationId} ${query.kind} search failed: ${error.message}`); }
        const result = await collectFilteredPages(first, query, readDom, parseRecord, onEvidencePage);
        pages += result.pageCount; rawCount += result.rawCount;
        let accepted = 0;
        for (const record of result.records) {
          const actual = portalCanonical(query.kind, record.tagId || record.plate || record.tagOrPlate);
          if (actual !== query.canonicalIdentifier) continue;
          const next = { ...record, queryId: query.queryId, queryReservationId: query.reservationId, queryVehicleId: query.vehicleId,
            queryKind: query.kind, queryIdentifier: query.identifier };
          const key = String(next.id || "");
          if (!key) throw new Error("E-ZPass filtered result is missing Lane Txn ID.");
          const prior = records.get(key);
          if (prior && JSON.stringify({ ...prior, queryReservationId: null, queryVehicleId: null, queryKind: null, queryIdentifier: null }) !==
              JSON.stringify({ ...next, queryReservationId: null, queryVehicleId: null, queryKind: null, queryIdentifier: null })) {
            throw new Error("E-ZPass returned conflicting duplicate Lane Txn IDs.");
          }
          if (!prior) records.set(key, next);
          accepted += 1;
        }
        reports.push({ queryId: query.queryId, reservationId: query.reservationId, kind: query.kind,
          pageCount: result.pageCount, rawCount: result.rawCount, recordCount: accepted, complete: true });
      }
    } catch (error) { primaryError = error; }
    try { await restoreFilters(original); }
    catch (error) { throw new Error(`E-ZPass filter restoration failed: ${error.message}`); }
    if (primaryError) throw primaryError;
    return { records: [...records.values()], complete: true, completeForRange: true, pageCount: pages,
      rawCount, chunkCount: queries.length, terminalReason: "all_trip_queries_complete", queryReports: reports };
  }

  async function collect(options) {
    return options.queryJobs ? collectQueries(options) : collectRange(options);
  }

  globalThis.EzpassCollection = Object.freeze({
    validateRange, validateQueries, collect,
    testing: Object.freeze({ hasActivePortalFilters, hasDescendingTransactionSort, localTimestampKey, pageChronology,
      paginationRoot, activePageNumber, nextControl, previousControl, maximizePageSize, rewindToFirstPage, assertRoute,
      inputDate, visibleDateInputs, snapshotFilters, applyQuery, restoreFilters }),
    constants: Object.freeze({ MAX_TOTAL_PAGES })
  });
})();
