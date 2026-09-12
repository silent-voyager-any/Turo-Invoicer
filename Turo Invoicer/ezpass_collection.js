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
  let collectionActive = false;
  let sessionContinuation = null;

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

  function sessionExpiryDialogs() {
    return controls(document, '[role="dialog"]').filter((dialog) => {
      if (!isVisible(dialog)) return false;
      const text = normalizedText(dialog);
      return /session will expire soon/i.test(text) && /automatically logged out/i.test(text);
    });
  }

  async function continueActiveSessionIfNeeded(force = false) {
    if (!collectionActive && !force) return false;
    if (sessionContinuation) return sessionContinuation;
    const dialogs = sessionExpiryDialogs();
    if (!dialogs.length) return false;
    if (dialogs.length !== 1) throw new Error("E-ZPass exposed multiple session-expiry dialogs during sync.");
    const dialog = dialogs[0];
    const matches = buttons(dialog).filter((node) => isVisible(node) && !isDisabled(node) &&
      /^continue working$/i.test(normalizedText(node)));
    if (matches.length !== 1) throw new Error("E-ZPass session-expiry dialog has an unavailable or ambiguous Continue working control.");
    sessionContinuation = (async () => {
      matches[0].click();
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        assertRoute("session continuation");
        if (!sessionExpiryDialogs().length) return true;
        await sleep(100);
      }
      throw new Error("E-ZPass session-expiry dialog did not close after continuing the session.");
    })();
    try { return await sessionContinuation; }
    finally { sessionContinuation = null; }
  }

  async function portalAction(node, phase) {
    assertRoute(phase);
    await continueActiveSessionIfNeeded();
    assertRoute(phase);
    node.click();
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
      await continueActiveSessionIfNeeded();
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
      // A real one-page filtered result omits the pager entirely. Give the
      // portal its longer empty/no-pager settle window so a late pager cannot
      // be mistaken for proof that all results fit on one page.
      const requiredSettle = sample.raw.length && sample.hasPager ? SETTLE_MS : EMPTY_SETTLE_MS;
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
    if (!paginationRoot()) return page;
    const currentNext = nextControl();
    if (currentNext && isDisabled(currentNext)) return page;
    const combos = controls(transactionMain(), '[role="combobox"][aria-label="View"]')
      .filter(isVisible);
    if (combos.length !== 1 || /\b100\b/.test(normalizedText(combos[0]))) return page;
    try {
      // MUI mounts its listbox outside the table and opens it on pointer-style
      // interaction. Dispatching mousedown before click mirrors that contract.
      await continueActiveSessionIfNeeded();
      combos[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await portalAction(combos[0], "page-size menu");
      const option = await waitFor(() => {
        const matches = controls(document, '[role="option"]')
          .filter((node) => isVisible(node) && /^100$/.test(normalizedText(node)));
        return matches.length === 1 ? matches[0] : null;
      }, 2000, "page-size option unavailable");
      await portalAction(option, "page-size selection");
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
      // E-ZPass does not render pagination for a result set that fits on one
      // page. This is distinct from a malformed pager missing Previous.
      if (!paginationRoot()) return page;
      const previous = previousControl();
      if (!previous) throw new Error("E-ZPass Previous pagination control is missing.");
      if (isDisabled(previous)) {
        if (page.pageNumber !== 1) throw new Error("E-ZPass disabled Previous before reaching page 1.");
        return page;
      }
      if (!Number.isInteger(page.pageNumber) || page.pageNumber <= 1) throw new Error("E-ZPass current page number is unavailable while rewinding.");
      const expected = page.pageNumber - 1;
      await portalAction(previous, "pagination rewind");
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
      if (!paginationRoot()) { terminalReason = "single_page_no_pager"; break; }
      const next = nextControl();
      if (!next) throw new Error("E-ZPass Next pagination control is missing from a nonempty result page.");
      if (isDisabled(next)) { terminalReason = "next_disabled"; break; }
      if (!Number.isInteger(page.pageNumber)) throw new Error("E-ZPass current page number is unavailable before advancing.");
      const expected = page.pageNumber + 1;
      await portalAction(next, "pagination");
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

  const DATE_FORMATTING_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const normalizedDateInputText = (value) => String(value || "").replace(DATE_FORMATTING_MARKS, "").trim();
  const inputDate = (value) => {
    const match = normalizedDateInputText(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!match) return null;
    const year = match[3].length === 2 ? Number(`20${match[3]}`) : Number(match[3]);
    const candidate = `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
    return isoParts(candidate) ? candidate : null;
  };

  const dateInputHint = (node) => [node?.getAttribute?.("aria-label"), node?.getAttribute?.("name"),
    ...(node?.labels || [])].map((item) => normalizedText(item)).join(" ");
  const dateInputRole = (node) => /start/i.test(dateInputHint(node)) ? "start" :
    /end/i.test(dateInputHint(node)) ? "end" : null;

  function visibleDateInputs() {
    const inputs = controls(transactionMain(), "input").filter((node) => isVisible(node) &&
      /date|mm\/dd/i.test([node.getAttribute?.("aria-label"), node.getAttribute?.("placeholder"),
        node.getAttribute?.("name"), ...(node.labels || [])].map((item) => normalizedText(item)).join(" ")));
    if (inputs.length !== 2) throw new Error(`Expected exactly two visible E-ZPass date inputs; found ${inputs.length}.`);
    const start = inputs.find((node) => dateInputRole(node) === "start");
    const end = inputs.find((node) => dateInputRole(node) === "end");
    return start && end && start !== end ? [start, end] : inputs;
  }

  function dateInputIdentity(input) {
    const role = dateInputRole(input);
    if (role) return { role, index: role === "start" ? 0 : 1 };
    const index = visibleDateInputs().indexOf(input);
    if (index < 0) throw new Error("E-ZPass date input could not be identified.");
    return { role: null, index };
  }

  function reacquireDateInput(identity) {
    let inputs;
    try { inputs = visibleDateInputs(); } catch { return null; }
    return identity.role ? inputs.find((node) => dateInputRole(node) === identity.role) || null :
      inputs[identity.index] || null;
  }

  async function ensureFilterOpen() {
    if (controls(transactionMain(), "input").some((node) => isVisible(node) && /startdate|start date/i.test(controlHint(node)))) return;
    const matches = buttons(transactionMain()).filter((node) => isVisible(node) && /^filter$/i.test(normalizedText(node)));
    if (matches.length !== 1) throw new Error("E-ZPass transaction Filter control is missing or ambiguous.");
    await portalAction(matches[0], "transaction filter open");
    await waitFor(() => {
      try { return visibleDateInputs(); } catch { return null; }
    }, 3000, "E-ZPass transaction filters did not open.");
  }

  const portalDate = (iso) => {
    const target = isoParts(iso);
    if (!target) throw new Error("E-ZPass received an invalid date for its transaction filter.");
    return `${String(target.month).padStart(2, "0")}/${String(target.day).padStart(2, "0")}/${String(target.year).slice(-2)}`;
  };
  const normalizedDateDigits = (value) => normalizedDateInputText(value).replace(/\D/g, "");
  const maskedDatePrefix = (digits) => [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)]
    .filter(Boolean).join("/");

  function nativeInputSetter(input) {
    const prototype = globalThis.HTMLInputElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("E-ZPass date input does not expose a native value setter.");
    return setter;
  }

  function dispatchInputEvent(input, type, init = {}) {
    let event;
    try {
      event = type === "input" || type === "beforeinput"
        ? new InputEvent(type, { bubbles: true, cancelable: type === "beforeinput", ...init })
        : type.startsWith("key")
          ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
          : new Event(type, { bubbles: true, ...init });
    } catch {
      event = new Event(type, { bubbles: true, cancelable: type === "beforeinput" });
    }
    input.dispatchEvent(event);
  }

  function dateInputDiagnostics(input, identity) {
    return JSON.stringify({
      field: identity?.role || "unknown",
      type: String(input?.getAttribute?.("type") || input?.type || "text").slice(0, 20),
      format: /mm\/dd\/yy/i.test(input?.getAttribute?.("placeholder") || "") ? "MM/DD/YY" : "unknown",
      digitCount: Math.min(8, normalizedDateDigits(input?.value).length),
      valid: input?.checkValidity?.() !== false,
      disabled: isDisabled(input),
      readOnly: Boolean(input?.readOnly || input?.getAttribute?.("aria-readonly") === "true")
    });
  }

  async function editDateInput(input, digits) {
    if (typeof document.execCommand !== "function") return false;
    input.focus?.();
    input.select?.();
    input.setSelectionRange?.(0, String(input.value || "").length);
    try {
      document.execCommand("delete", false);
      for (const digit of digits) {
        if (!document.execCommand("insertText", false, digit)) return false;
        await Promise.resolve();
      }
      return true;
    } catch { return false; }
  }

  function clearDateInput(input, setter) {
    input.focus?.();
    input.setSelectionRange?.(0, String(input.value || "").length);
    dispatchInputEvent(input, "beforeinput", { inputType: "deleteContentBackward", data: null });
    setter.call(input, "");
    dispatchInputEvent(input, "input", { inputType: "deleteContentBackward", data: null });
  }

  async function commitDateInput(input, iso) {
    if (inputDate(input.value) === iso && input.checkValidity?.() !== false) return input;
    const identity = dateInputIdentity(input);
    const digits = normalizedDateDigits(portalDate(iso));
    if (isDisabled(input) || input.readOnly || input.getAttribute?.("aria-readonly") === "true") {
      throw new Error(`E-ZPass date input is not editable. Diagnostics: ${dateInputDiagnostics(input, identity)}`);
    }
    await continueActiveSessionIfNeeded();
    let candidate = input;
    let edited = await editDateInput(candidate, digits);
    candidate = reacquireDateInput(identity) || candidate;
    if (!edited || normalizedDateDigits(candidate.value) !== digits) {
      const setter = nativeInputSetter(candidate);
      clearDateInput(candidate, setter);
      let typedDigits = "";
      for (const digit of digits) {
        dispatchInputEvent(candidate, "keydown", { key: digit, code: `Digit${digit}` });
        dispatchInputEvent(candidate, "keypress", { key: digit, code: `Digit${digit}` });
        dispatchInputEvent(candidate, "beforeinput", { inputType: "insertText", data: digit });
        typedDigits += digit;
        setter.call(candidate, maskedDatePrefix(typedDigits));
        dispatchInputEvent(candidate, "input", { inputType: "insertText", data: digit });
        dispatchInputEvent(candidate, "keyup", { key: digit, code: `Digit${digit}` });
        await Promise.resolve();
        candidate = reacquireDateInput(identity) || candidate;
      }
    }
    dispatchInputEvent(candidate, "change");
    candidate.blur?.();
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      assertRoute("typed date confirmation");
      await continueActiveSessionIfNeeded();
      candidate = reacquireDateInput(identity) || candidate;
      if (inputDate(candidate.value) === iso && candidate.checkValidity?.() !== false) return candidate;
      await sleep(100);
    }
    throw new Error(`E-ZPass rejected a typed date. Diagnostics: ${dateInputDiagnostics(candidate, identity)}`);
  }

  const compactText = (value) => String(value || "").replace(/\s+/g, " ").trim();

  // E-ZPass currently names its Type and Tag/Plate combobox inputs with
  // native <label for="..."> elements. Keep the full accessible-name order
  // so minor framework markup changes do not force us back to CSS classes.
  function accessibleControlName(node) {
    const direct = compactText(node?.getAttribute?.("aria-label"));
    if (direct) return direct;

    const labelledBy = compactText(node?.getAttribute?.("aria-labelledby"));
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) =>
        compactText(document.getElementById?.(id)?.textContent)).filter(Boolean).join(" ");
      if (text) return text;
    }

    const native = [...(node?.labels || [])].map((label) => compactText(label?.textContent)).filter(Boolean).join(" ");
    if (native) return native;

    const id = String(node?.id || "");
    if (id) {
      const text = controls(document, "label").filter((label) => String(label?.htmlFor || "") === id)
        .map((label) => compactText(label?.textContent)).filter(Boolean).join(" ");
      if (text) return text;
    }
    return "";
  }

  const namedCombos = (root, label) => controls(root, '[role="combobox"]').filter((node) =>
    isVisible(node) && accessibleControlName(node).toLowerCase() === String(label).toLowerCase());

  function transactionFilterControls(inputs = visibleDateInputs()) {
    const boundary = transactionMain();
    let root = inputs[0]?.parentElement;
    let maxType = 0, maxIdentifier = 0, maxSearch = 0;
    while (root) {
      if (root.contains?.(inputs[1])) {
        const type = namedCombos(root, "Type");
        const identifier = namedCombos(root, "Tag/Plate #");
        const search = buttons(root).filter((node) => isVisible(node) && /^search$/i.test(normalizedText(node)));
        maxType = Math.max(maxType, type.length);
        maxIdentifier = Math.max(maxIdentifier, identifier.length);
        maxSearch = Math.max(maxSearch, search.length);
        if (type.length === 1 && identifier.length === 1 && search.length === 1) {
          return { root, type: type[0], identifier: identifier[0], search: search[0] };
        }
      }
      if (root === boundary || root === document.body) break;
      root = root.parentElement;
    }

    if (!maxType) throw new Error("E-ZPass Type filter was not found in the transaction filter panel.");
    if (maxType > 1) throw new Error("E-ZPass transaction filter contains multiple Type controls.");
    if (!maxIdentifier) throw new Error("E-ZPass Tag/Plate # filter was not found in the transaction filter panel.");
    if (maxIdentifier > 1) throw new Error("E-ZPass transaction filter contains multiple Tag/Plate # controls.");
    if (!maxSearch) throw new Error("E-ZPass transaction-filter Search control was not found.");
    if (maxSearch > 1) throw new Error("E-ZPass transaction filter contains multiple Search controls.");
    throw new Error("E-ZPass transaction filter controls do not share a supported container.");
  }

  async function selectCombo(combo, matcher, label) {
    await continueActiveSessionIfNeeded();
    combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await portalAction(combo, `${label} menu`);
    const option = await waitFor(() => {
      const matches = controls(document, '[role="option"]').filter((node) => isVisible(node) && matcher(normalizedText(node)));
      return matches.length === 1 ? matches[0] : null;
    }, 2500, `E-ZPass ${label} option is unavailable.`);
    await portalAction(option, `${label} selection`);
    await sleep(80);
  }

  function optionIdentifierCandidates(node, kind) {
    const values = [normalizedText(node), node?.value, node?.getAttribute?.("value"),
      node?.getAttribute?.("data-value"), node?.getAttribute?.("aria-label"), node?.getAttribute?.("title")];
    const candidates = new Set();
    for (const value of values) {
      const compact = compactText(value);
      if (!compact) continue;
      const withoutLabels = compact.replace(/\b(?:e-?zpass|transponder|tag|license|plate|number|no)\b/gi, " ");
      for (const part of [compact, withoutLabels, ...compact.split(/[|\u2022\u00b7(),;]+/),
        ...withoutLabels.split(/\s+/)]) {
        const canonical = portalCanonical(kind, part);
        if (canonical) candidates.add(canonical);
      }
    }
    return candidates;
  }

  function uniqueIdentifierOption(query) {
    const expected = String(query.canonicalIdentifier || "");
    const matches = controls(document, '[role="option"]').filter((node) =>
      isVisible(node) && optionIdentifierCandidates(node, query.kind).has(expected));
    if (matches.length > 1) throw new Error("E-ZPass exact tag/plate option is ambiguous.");
    return matches[0] || null;
  }

  function identifierInput(combo) {
    if (globalThis.HTMLInputElement && combo instanceof globalThis.HTMLInputElement) return combo;
    const nested = combo?.querySelector?.("input");
    return globalThis.HTMLInputElement && nested instanceof globalThis.HTMLInputElement ? nested : null;
  }

  async function typeIdentifierFilter(combo, query) {
    const input = identifierInput(combo);
    if (!input || isDisabled(input) || input.readOnly || input.getAttribute?.("aria-readonly") === "true") return false;
    const value = String(query.canonicalIdentifier || "");
    input.focus?.();
    input.select?.();
    input.setSelectionRange?.(0, String(input.value || "").length);
    if (typeof document.execCommand === "function") {
      try {
        document.execCommand("delete", false);
        if (document.execCommand("insertText", false, value)) return true;
      } catch { /* Fall through to the native setter. */ }
    }
    const setter = nativeInputSetter(input);
    dispatchInputEvent(input, "beforeinput", { inputType: "deleteContentBackward", data: null });
    setter.call(input, "");
    dispatchInputEvent(input, "input", { inputType: "deleteContentBackward", data: null });
    dispatchInputEvent(input, "beforeinput", { inputType: "insertText", data: value });
    setter.call(input, value);
    dispatchInputEvent(input, "input", { inputType: "insertText", data: value });
    dispatchInputEvent(input, "change");
    return true;
  }

  async function selectIdentifier(combo, query) {
    await continueActiveSessionIfNeeded();
    combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await portalAction(combo, "exact tag/plate menu");
    await sleep(80);
    let option = uniqueIdentifierOption(query);
    if (!option) {
      const typed = await typeIdentifierFilter(combo, query);
      option = await waitFor(() => uniqueIdentifierOption(query), typed ? 5000 : 2500,
        "E-ZPass exact tag/plate option is unavailable.");
    }
    await portalAction(option, "exact tag/plate selection");
    await waitFor(() => {
      let candidate = combo;
      try { candidate = transactionFilterControls(visibleDateInputs()).identifier; } catch { /* Use the original node. */ }
      return optionIdentifierCandidates(candidate, query.kind).has(String(query.canonicalIdentifier || ""));
    }, 2500, "E-ZPass did not accept the exact tag/plate selection.");
    await sleep(80);
  }

  function clearFilterButton() {
    const matches = buttons(transactionMain()).filter((node) => isVisible(node) && /^clear all$/i.test(normalizedText(node)));
    if (matches.length !== 1) throw new Error("E-ZPass Clear All control is missing or ambiguous.");
    return matches[0];
  }

  function snapshotFilters() {
    const inputs = visibleDateInputs();
    const filters = transactionFilterControls(inputs);
    const view = controls(transactionMain(), '[role="combobox"][aria-label="View"]').filter(isVisible)[0];
    return { startDate: inputDate(inputs[0].value), endDate: inputDate(inputs[1].value),
      type: compactText(filters.type.value) || normalizedText(filters.type),
      identifier: compactText(filters.identifier.value) || normalizedText(filters.identifier),
      view: view ? normalizedText(view) : null };
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
    const endIdentity = dateInputIdentity(inputs[1]);
    await commitDateInput(inputs[0], query.startDate);
    await sleep(100);
    await commitDateInput(reacquireDateInput(endIdentity) || inputs[1], query.endDate);
    let filters = transactionFilterControls(visibleDateInputs());
    await selectCombo(filters.type, (value) => /^toll$/i.test(value), "Toll type");
    filters = transactionFilterControls(visibleDateInputs());
    await selectIdentifier(filters.identifier, query);
    filters = transactionFilterControls(visibleDateInputs());
    const search = filters.search;
    await waitFor(() => !isDisabled(search) && search, 5000, "E-ZPass Search remained disabled after applying trip filters.");
    await portalAction(search, "trip filter search");
    assertRoute("trip filter search");
    let page = await settledPage(readDom, parseRecord, null);
    const fits = (candidate) => candidate.noTransactions || candidate.records.every((record) => {
      const stamp = localTimestampKey(rawTimestamp(record));
      const date = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : null;
      return recordMatchesQuery(record, query) &&
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
    await portalAction(clearFilterButton(), "filter restoration clear");
    await sleep(150);
    if (!snapshot.startDate || !snapshot.endDate) { await restoreViewSize(snapshot.view); return; }
    const inputs = visibleDateInputs();
    const endIdentity = dateInputIdentity(inputs[1]);
    await commitDateInput(inputs[0], snapshot.startDate);
    await sleep(100);
    await commitDateInput(reacquireDateInput(endIdentity) || inputs[1], snapshot.endDate);
    let filters = transactionFilterControls(visibleDateInputs());
    if (snapshot.type && !/^all$/i.test(snapshot.type)) {
      await selectCombo(filters.type, (value) => value === snapshot.type, "restored Type");
      filters = transactionFilterControls(visibleDateInputs());
    }
    if (snapshot.identifier && !/^all tags$/i.test(snapshot.identifier)) {
      await selectCombo(filters.identifier, (value) => value === snapshot.identifier, "restored tag/plate");
      filters = transactionFilterControls(visibleDateInputs());
    }
    const search = filters.search;
    await waitFor(() => !isDisabled(search) && search, 5000, "E-ZPass Search remained disabled while restoring filters.");
    await portalAction(search, "filter restoration search");
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

  function recordMatchesQuery(record, query) {
    const values = query.kind === "tag" ? [record.tagId, record.tagOrPlate] : [record.plate, record.tagOrPlate];
    return values.some((value) => portalCanonical(query.kind, value) === String(query.canonicalIdentifier || ""));
  }

  function queryNeutralRecord(record) {
    const copy = { ...record };
    for (const key of ["queryId", "queryReservationId", "queryVehicleId", "queryKind", "queryIdentifier"]) delete copy[key];
    return copy;
  }

  function mergeQueryRecord(records, record, query) {
    const next = { ...record, queryId: query.queryId, queryReservationId: query.reservationId, queryVehicleId: query.vehicleId,
      queryKind: query.kind, queryIdentifier: query.identifier };
    const key = String(next.id || "");
    if (!key) throw new Error("E-ZPass filtered result is missing Lane Txn ID.");
    const prior = records.get(key);
    if (prior && JSON.stringify(queryNeutralRecord(prior)) !== JSON.stringify(queryNeutralRecord(next))) {
      throw new Error("E-ZPass returned conflicting duplicate Lane Txn IDs.");
    }
    if (!prior) records.set(key, next);
    return !prior;
  }

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
      if (!paginationRoot()) break;
      const next = nextControl();
      if (!next) throw new Error("E-ZPass Next control is missing from filtered results.");
      if (isDisabled(next)) break;
      const expected = page.pageNumber + 1;
      await portalAction(next, "filtered pagination");
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
          if (!recordMatchesQuery(record, query)) continue;
          mergeQueryRecord(records, record, query);
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
    if (collectionActive) throw new Error("E-ZPass collection is already running in this tab.");
    collectionActive = true;
    try {
      await continueActiveSessionIfNeeded();
      return await (options.queryJobs ? collectQueries(options) : collectRange(options));
    } finally {
      collectionActive = false;
      sessionContinuation = null;
    }
  }

  globalThis.EzpassCollection = Object.freeze({
    validateRange, validateQueries, collect,
    testing: Object.freeze({ hasActivePortalFilters, hasDescendingTransactionSort, localTimestampKey, pageChronology,
      paginationRoot, activePageNumber, nextControl, previousControl, maximizePageSize, rewindToFirstPage, assertRoute,
      normalizedDateInputText, inputDate, dateInputRole, visibleDateInputs, reacquireDateInput,
      portalDate, normalizedDateDigits, maskedDatePrefix, dateInputDiagnostics, commitDateInput,
      sessionExpiryDialogs, continueActiveSessionIfNeeded,
      accessibleControlName, namedCombos, transactionFilterControls,
      optionIdentifierCandidates, uniqueIdentifierOption, typeIdentifierFilter, selectIdentifier,
      recordMatchesQuery, mergeQueryRecord, collectFilteredPages,
      snapshotFilters, applyQuery, restoreFilters }),
    constants: Object.freeze({ MAX_TOTAL_PAGES })
  });
})();
