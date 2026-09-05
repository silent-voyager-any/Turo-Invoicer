(() => {
  "use strict";

  const TURO_ORIGIN = "https://turo.com";
  const HISTORY_PATH = "/us/en/trips/history";
  const DETAIL_PATH = "/api/reservation/detail";
  const MAX_DETAILS = 50;
  const MAX_BYTES = 2_000_000;
  const CARD_LINKS = 'a[data-testid="baseTripCard"][href], [data-trip-id] a[href*="/reservation/"], [data-reservation-id] a[href*="/reservation/"]';

  function reservationLink(href) {
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/^\/us\/en\/reservation\/(\d{1,20})\/?$/);
      if (url.origin !== TURO_ORIGIN || url.username || url.password || !match) return null;
      // Query strings/fragments on a card are not allowed to influence the API request.
      return { id: match[1] };
    } catch { return null; }
  }

  function detailUrl(id) {
    if (!/^\d{1,20}$/.test(String(id))) return null;
    const url = new URL(DETAIL_PATH, TURO_ORIGIN);
    url.searchParams.set("oppTermsAware", "true");
    url.searchParams.set("reservationId", String(id));
    return url.href;
  }

  function isExpectedDetailUrl(rawUrl, id) {
    try {
      const url = new URL(rawUrl);
      if (url.origin !== TURO_ORIGIN || url.username || url.password || url.hash || url.pathname !== DETAIL_PATH) return false;
      const allowed = new Set(["oppTermsAware", "reservationId"]);
      if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return false;
      return url.searchParams.getAll("oppTermsAware").length === 1 &&
        url.searchParams.get("oppTermsAware") === "true" &&
        url.searchParams.getAll("reservationId").length === 1 &&
        url.searchParams.get("reservationId") === String(id);
    } catch { return false; }
  }

  function hasClock(value) {
    // Month/day labels and date-only values must never become midnight trips.
    return typeof value === "number" && Number.isFinite(value) ||
      typeof value === "string" && (/^\d{10}(?:\d{3})?$/.test(value) ||
        /\b\d{4}\b/.test(value) && /\d{1,2}:\d{2}/.test(value));
  }

  const complete = (record) => record && (record._remove ||
    record.id != null && record.vehicleId != null && hasClock(record.start) && hasClock(record.end));

  function parsePayload(payload, id, parseTrip) {
    if (!payload || typeof payload !== "object") return null;
    // The observed endpoint returns the reservation at the root. A small set of
    // explicit wrappers tolerates harmless envelope changes without walking
    // unrelated guest, payment, message, or location objects.
    const candidates = [
      payload,
      payload.data,
      payload.reservation,
      payload.reservationDetail,
      payload.result,
      payload.data?.reservation,
      payload.data?.reservationDetail
    ];
    const matches = new Map();
    for (const candidate of candidates) {
      const record = parseTrip(candidate);
      if (complete(record) && String(record.id) === String(id)) matches.set(JSON.stringify(record), record);
    }
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

  function create(parseTrip) {
    let jobs = new Map();
    let generation = 0;
    let running = 0;
    const onHistory = () => location.origin === TURO_ORIGIN &&
      new URL(location.href).pathname.replace(/\/$/, "") === HISTORY_PATH;

    async function load(job, signal) {
      if (!onHistory()) throw new Error("Return to Turo trip history and sync again.");
      const url = detailUrl(job.id);
      if (!url) throw new Error("History contained an invalid reservation identifier.");

      // Isolated-world same-origin GET: Chrome attaches the active session.
      // No cookie or authorization header is inspected or constructed here.
      const response = await fetch(url, {
        method: "GET", credentials: "same-origin", mode: "same-origin",
        redirect: "error", cache: "no-store", signal, headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Reservation detail request failed (HTTP ${response.status}). Open Turo and check your session.`);
      }
      if (!isExpectedDetailUrl(response.url, job.id)) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Reservation detail request returned an unexpected URL or redirect.");
      }
      const contentType = response.headers.get("content-type") || "";
      if (!/^(?:application\/(?:[\w.-]+\+)?json|text\/json)(?:\s*;|$)/i.test(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Reservation detail request did not return JSON. Open Turo and check your session.");
      }

      const text = await readBody(response, signal);
      signal.throwIfAborted();
      if (!onHistory()) throw new Error("Return to Turo trip history and sync again.");
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error("Reservation detail response contained malformed JSON."); }
      const record = parsePayload(payload, job.id, parseTrip);
      if (!record) throw new Error("Reservation detail JSON has no supported full timestamps and vehicle ID. Turo may have changed its response schema; no dates were guessed.");
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
            error instanceof TypeError ? "Reservation detail request was blocked, redirected, or unavailable. Open Turo and check your session." : error.message;
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
          const record = captured.find((item) => String(item.id) === target.id && complete(item));
          jobs.set(target.id, { ...target, state: record ? "done" : "queued", record });
        }
        if (!jobs.size) return { records: captured };
        // Visible history IDs scope the output; unrelated prefetched trips cannot
        // leak into this batch. Every discovered card must resolve before success.
        for (const job of jobs.values()) {
          const record = captured.find((item) => String(item.id) === job.id && complete(item));
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

  globalThis.TuroDetails = Object.freeze({ create, reservationLink, detailUrl, isExpectedDetailUrl, parsePayload, hasClock });
})();
