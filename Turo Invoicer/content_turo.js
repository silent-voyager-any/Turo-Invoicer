(() => {
  "use strict";
  const { scalar, pick, timestamp, textOf, tableValues, createCapture } = TollCapture;

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
    // Require a stable vehicle identifier; a display name is not an ID.
    const rows = document.querySelectorAll(
      '[data-trip-id], [data-testid*="trip-card" i], [data-test*="trip-card" i], table tbody tr'
    );
    for (const row of rows) {
      const times = [...row.querySelectorAll("time[datetime]")].map((time) => time.dateTime);
      const cell = tableValues(row);
      const tripLink = row.querySelector('a[href*="/trips/"], a[href*="/reservation/"]');
      const vehicleLink = row.querySelector('a[href*="/vehicles/"]');
      add({
        tripId: row.dataset.tripId || tripLink?.getAttribute("href")?.match(/(?:trips|reservation)\/([^/?#]+)/i)?.[1] || cell([/^trip id$/, /^reservation id$/]),
        vehicleId: row.dataset.vehicleId || row.querySelector("[data-vehicle-id]")?.dataset.vehicleId ||
          vehicleLink?.getAttribute("href")?.match(/vehicles\/(\d+)/)?.[1] || cell([/^vehicle id$/, /^listing id$/]),
        start: row.dataset.start || row.dataset.startTime || times[0] ||
          textOf(row, ['[data-testid="trip-start"]', '[data-field="start"]']) || cell([/^start(?: date\/time)?$/, /^trip start$/]),
        end: row.dataset.end || row.dataset.endTime || times[1] ||
          textOf(row, ['[data-testid="trip-end"]', '[data-field="end"]']) || cell([/^end(?: date\/time)?$/, /^trip end$/]),
        status: row.dataset.status || cell([/^status$/])
      });
    }
  }

  createCapture("turo", parseTrip, readDom);
})();
