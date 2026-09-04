(() => {
  "use strict";
  const { scalar, pick, timestamp, textOf, tableValues, createCapture } = TollCapture;

  const HISTORY_PATH = "/us/en/trips/history";
  // Fallback candidates for trip history. Prefer semantic attributes and
  // links over hashed CSS classes; actual live markup still needs fixture QA.
  const CARD_SELECTOR = [
    "[data-trip-id]", "[data-reservation-id]",
    '[data-testid*="trip-card" i]', '[data-testid*="tripcard" i]',
    '[data-test*="trip-card" i]', '[data-testid*="reservation-card" i]',
    '[data-testid*="history-trip" i]', '[data-testid*="past-trip" i]',
    '[class*="trip-card" i]', '[class*="tripCard"]', "table tbody tr"
  ].join(", ");
  const TRIP_LINK_SELECTOR = [
    'a[href*="/host/trips/"]', 'a[href*="/trips/"]',
    'a[href*="/trip/"]', 'a[href*="/reservation/"]', 'a[href*="/reservations/"]'
  ].join(", ");
  const VEHICLE_LINK_SELECTOR = 'a[href*="/vehicles/"], a[href*="/vehicle/"], a[href*="-rental/"]';

  function linkId(link, kind) {
    if (!link) return null;
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      if (url.origin !== location.origin) return null;
      const path = url.pathname;
      if (kind === "vehicle") {
        return path.match(/\/(?:vehicles?|listings)\/(\d+)(?:\/|$)/i)?.[1] ||
          path.match(/\/(?:car|suv|truck|van|minivan)-rental\/.+\/(\d+)\/?$/i)?.[1] || null;
      }
      const id = path.match(/\/(?:trips?|reservations?)\/([a-z0-9_-]+)(?:\/|$)/i)?.[1];
      return id && !/^(upcoming|past|history|current|booked|details)$/i.test(id) ? id : null;
    } catch { return null; }
  }

  // These are defensive schema adapters, not verified private API contracts.
  function parseTrip(value) {
    const status = String(pick(value, ["status", "tripStatus", "reservationStatus"]) || "");
    if (/cancel|declin|reject/i.test(status)) {
      const id = scalar(pick(value, ["tripId", "reservationId", "bookingId", "id"]));
      return id == null ? null : { id, _remove: true };
    }
    const start = timestamp(value,
      ["start", "startDateTime", "startAt", "startsAt", "tripStart", "pickupAt"],
      ["startDate", "tripStartDate", "pickupDate"], ["startTime", "pickupTime"]);
    const end = timestamp(value,
      ["end", "endDateTime", "endAt", "endsAt", "tripEnd", "returnAt"],
      ["endDate", "tripEndDate", "returnDate"], ["endTime", "returnTime"]);
    // Some APIs expose epoch/ISO instants in startTime/endTime.
    const startValue = start ?? scalar(pick(value, ["startTime"]));
    const endValue = end ?? scalar(pick(value, ["endTime"]));
    const vehicle = pick(value, ["vehicle", "car", "listing"]);
    const vehicleId = scalar(pick(value, ["vehicleId", "listingId"])) ?? scalar(pick(vehicle, ["id", "vehicleId"]));
    if (startValue == null || endValue == null || vehicleId == null) return null;
    return {
      id: scalar(pick(value, ["tripId", "reservationId", "bookingId", "id"])),
      vehicleId: String(vehicleId), start: startValue, end: endValue
    };
  }

  function readDom(add) {
    if (new URL(location.href).pathname.replace(/\/$/, "") !== HISTORY_PATH) return;
    const rows = new Set(document.querySelectorAll(CARD_SELECTOR));
    // Some host layouts use a link-wrapped card or an unlabelled list item.
    for (const link of document.querySelectorAll(TRIP_LINK_SELECTOR)) {
      if (!linkId(link, "trip")) continue;
      rows.add(link.closest(CARD_SELECTOR + ', article, li, [role="listitem"]') || link);
    }
    for (const row of rows) {
      const times = [...row.querySelectorAll("time[datetime]")].map((time) => time.dateTime);
      const cell = tableValues(row);
      const links = [...row.querySelectorAll(TRIP_LINK_SELECTOR)];
      if (row.matches(TRIP_LINK_SELECTOR)) links.unshift(row);
      const tripIds = new Set(links.map((link) => linkId(link, "trip")).filter(Boolean));
      // Never combine times/identity from different cards in a list container.
      if (tripIds.size > 1) continue;
      const vehicleIds = new Set([...row.querySelectorAll(VEHICLE_LINK_SELECTOR)]
        .map((link) => linkId(link, "vehicle")).filter(Boolean));
      if (vehicleIds.size > 1) continue;
      const vehicle = row.querySelector("[data-vehicle-id], [data-listing-id]");
      // Only use positional <time>s when exactly two exist in the same card.
      // Labelled fields win over other timestamps such as booking/return updates.
      add({
        tripId: row.dataset.tripId || row.dataset.reservationId || [...tripIds][0] || cell([/^trip id$/, /^reservation id$/]),
        vehicleId: row.dataset.vehicleId || row.dataset.listingId || vehicle?.dataset.vehicleId ||
          vehicle?.dataset.listingId || [...vehicleIds][0] || cell([/^vehicle id$/, /^listing id$/]),
        start: row.dataset.start || row.dataset.startTime || row.dataset.startDateTime ||
          textOf(row, ['[data-testid="trip-start"]', '[data-testid="trip-start-date"]',
            '[data-testid="tripStartDate"]', '[data-field="start"]', 'time[itemprop="startDate"]']) ||
          cell([/^start(?: date time)?$/, /^trip start$/]) || (times.length === 2 ? times[0] : null),
        end: row.dataset.end || row.dataset.endTime || row.dataset.endDateTime ||
          textOf(row, ['[data-testid="trip-end"]', '[data-testid="trip-end-date"]',
            '[data-testid="tripEndDate"]', '[data-field="end"]', 'time[itemprop="endDate"]']) ||
          cell([/^end(?: date time)?$/, /^trip end$/]) || (times.length === 2 ? times[1] : null),
        status: row.dataset.status || cell([/^status$/])
      });
    }
  }

  // The shared MutationObserver wraps readDom and wakes COLLECT_NOW when a
  // complete trip (vehicle ID + both times), not a skeleton, becomes available.
  // Network responses can satisfy the same pending request during SPA loading.
  createCapture("turo", parseTrip, readDom, {
    isPageAllowed: (path) => path === HISTORY_PATH,
    pageMessage: "Turo collection is restricted to /us/en/trips/history. Open that page and sync again.",
    waitTimeoutMs: 20000,
    settleMs: 300,
    observeThrottleMs: 100,
    emptyMessage: "Timed out after 20 seconds waiting for complete Turo history records. Open /us/en/trips/history and load past trips. Visible cards still need a stable vehicle ID and full start/end timestamps; unsupported fields need an adapter update."
  });
})();
