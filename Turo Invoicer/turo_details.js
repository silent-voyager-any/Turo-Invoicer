(() => {
  "use strict";
  const HISTORY_PATH = "/us/en/trips/history";
  const MAX_DETAILS = 50;
  const MAX_BYTES = 2000000;
  const CARD_LINKS = 'a[data-testid="baseTripCard"][href], [data-trip-id] a[href*="/reservation/"], [data-reservation-id] a[href*="/reservation/"]';

  function reservationLink(href) {
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/^\/us\/en\/reservation\/(\d+)\/?$/);
      if (url.origin !== "https://turo.com" || url.username || url.password || !match) return null;
      // Query strings/fragments are not needed for a read-only detail page.
      return { id: match[1], url: url.origin + url.pathname };
    } catch { return null; }
  }

  function hasClock(value) {
    // Month/day card labels and date-only values must never become midnight trips.
    return typeof value === "number" && Number.isFinite(value) ||
      typeof value === "string" && (/^\d{10}(?:\d{3})?$/.test(value) ||
        /\b\d{4}\b/.test(value) && /\d{1,2}:\d{2}/.test(value));
  }
  const complete = (record) => record && (record._remove ||
    record.id != null && record.vehicleId != null && hasClock(record.start) && hasClock(record.end));

  function parseDocument(root, id, parseTrip, readDom) {
    const matches = new Map();
    const add = (candidate) => {
      const record = parseTrip(candidate);
      if (complete(record) && String(record.id) === id) matches.set(JSON.stringify(record), record);
    };
    // Only JSON script bodies are parsed. Never evaluate bootstrapping JavaScript
    // or merge identity/time fields from unrelated objects in a response tree.
    let visited = 0;
    for (const script of root.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__')) {
      const source = script.textContent || "";
      if (source.length > MAX_BYTES) continue;
      let payload;
      try { payload = JSON.parse(source); } catch { continue; }
      const queue = [{ value: payload, depth: 0 }];
      for (let index = 0; index < queue.length && visited < 20000; index++, visited++) {
        const { value, depth } = queue[index];
        if (!value || typeof value !== "object") continue;
        if (!Array.isArray(value)) add(value);
        if (depth >= 12) continue;
        for (const child of Object.values(value)) {
          if (queue.length >= 20000) break;
          if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    // Semantic HTML is useful when the server renders details without JSON.
    // JSON takes precedence; DOM formatting can represent the same instant differently.
    if (!matches.size) readDom(add, root, id);
    if (matches.size > 1) throw new Error("Reservation details contain conflicting records. Review that reservation manually.");
    return [...matches.values()][0] || null;
  }

  async function readBody(response, signal) {
    if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Reservation detail response is empty or exceeds the size limit.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("Reservation detail response exceeds the size limit.");
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  function create(parseTrip, readDom) {
    let jobs = new Map();
    let generation = 0;
    let running = 0;
    const onHistory = () => location.origin === "https://turo.com" &&
      new URL(location.href).pathname.replace(/\/$/, "") === HISTORY_PATH;

    async function load(job, signal) {
      if (!onHistory()) throw new Error("Return to Turo trip history and sync again.");
      // Isolated-world same-origin GET: Chrome attaches the session itself.
      // No cookies/authorization headers are inspected, and redirects are refused.
      const response = await fetch(job.url, {
        method: "GET", credentials: "same-origin", mode: "same-origin",
        redirect: "error", cache: "no-store", signal, headers: { Accept: "text/html" }
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Reservation detail request failed (HTTP ${response.status}). Open the linked reservation in Turo and check your session.`);
      }
      if (response.url !== job.url || !/text\/html/i.test(response.headers.get("content-type") || "")) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Reservation did not return the expected HTML page. Open it in Turo and check your session.");
      }
      const html = await readBody(response, signal);
      signal.throwIfAborted();
      if (!onHistory()) throw new Error("Return to Turo trip history and sync again.");
      // A detached template is inert: no scripts execute or resources are loaded.
      // It is never attached to the host page, popup, or another active document.
      const template = document.createElement("template");
      template.innerHTML = html;
      const record = parseDocument(template.content, job.id, parseTrip, readDom);
      if (!record) throw new Error("Reservation page has no supported full timestamps and vehicle ID (it may be an app shell or sign-in/challenge page). Open a linked reservation and provide redacted date/vehicle markup for an adapter update; no dates were guessed.");
      return record;
    }

    function pump(notify) {
      const epoch = generation;
      for (const job of jobs.values()) {
        if (running >= 3) break;
        if (job.state !== "queued") continue;
        job.state = "loading";
        job.controller = new AbortController();
        running++;
        job.timeout = setTimeout(() => job.controller.abort(), 6000);
        load(job, job.controller.signal).then((record) => {
          if (epoch === generation) { job.record = record; job.state = "done"; }
        }).catch((error) => {
          if (epoch !== generation) return;
          job.state = "failed";
          job.error = job.controller.signal.aborted ? "Reservation detail request timed out. Keep history open and try again." :
            error instanceof TypeError ? "Reservation detail request was blocked, redirected, or unavailable. Open the linked reservation and check your session." : error.message;
        }).finally(() => {
          clearTimeout(job.timeout);
          if (epoch !== generation) return;
          running--;
          notify();
        });
      }
    }

    return {
      refresh(captured, notify) {
        if (!onHistory()) return { records: [], error: "Return to Turo trip history and sync again." };
        for (const link of document.querySelectorAll(CARD_LINKS)) {
          const target = reservationLink(link.getAttribute("href"));
          if (!target || jobs.has(target.id)) continue;
          if (jobs.size >= MAX_DETAILS) return { records: [], error: "More than 50 history reservations are loaded. Narrow the history range before syncing." };
          const record = captured.find((record) => String(record.id) === target.id && complete(record));
          jobs.set(target.id, { ...target, state: record ? "done" : "queued", record });
        }
        if (!jobs.size) return { records: captured };
        // Visible history IDs scope the output; unrelated prefetched trips cannot
        // leak into this batch. All discovered cards must resolve before success.
        for (const job of jobs.values()) {
          const record = captured.find((record) => String(record.id) === job.id && complete(record));
          if (job.state === "queued" && record) { job.record = record; job.state = "done"; }
        }
        const failed = [...jobs.values()].find((job) => job.state === "failed");
        if (failed) return { records: [], error: failed.error };
        pump(notify);
        const remaining = [...jobs.values()].filter((job) => job.state !== "done").length;
        return {
          records: [...jobs.values()].filter((job) => job.state === "done" && !job.record._remove).map((job) => job.record),
          pending: remaining > 0,
          timeoutError: `Reservation details are incomplete (${jobs.size - remaining}/${jobs.size} resolved within 20 seconds). Keep history open, load a smaller history range, and retry. Prior results were preserved.`
        };
      },
      reset() {
        generation++;
        for (const job of jobs.values()) {
          clearTimeout(job.timeout);
          job.controller?.abort();
        }
        jobs.clear();
        running = 0;
      }
    };
  }
  globalThis.TuroDetails = Object.freeze({ create, reservationLink, parseDocument, hasClock });
})();
