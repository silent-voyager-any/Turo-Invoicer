/**
 * Pure reconciliation helpers. This module has no Chrome API dependencies and
 * can be tested in Node or imported by the MV3 service worker.
 */

export const DEFAULT_TIME_ZONE = "America/New_York";

const OFFSET_FORMATTERS = new Map();

function formatterFor(timeZone) {
  if (!OFFSET_FORMATTERS.has(timeZone)) {
    OFFSET_FORMATTERS.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      })
    );
  }
  return OFFSET_FORMATTERS.get(timeZone);
}

function partsAt(instantMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function timeZoneOffsetMs(instantMs, timeZone) {
  const p = partsAt(instantMs, timeZone);
  const displayedAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  return displayedAsUtc - Math.trunc(instantMs / 1000) * 1000;
}

function localPartsFromString(value) {
  const normalized = value.trim().replace(/\s+/g, " ");

  // ISO-like portal values without an explicit offset.
  let match = normalized.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?)?$/i
  );
  if (match) {
    let hour = Number(match[4] || 0);
    const meridiem = match[8]?.toUpperCase();
    if (meridiem && (hour < 1 || hour > 12)) return null;
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour,
      minute: Number(match[5] || 0),
      second: Number(match[6] || 0),
      millisecond: Number((match[7] || "0").padEnd(3, "0"))
    };
  }

  // Common US statement format: MM/DD/YYYY hh:mm[:ss] AM/PM.
  match = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
  );
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    let hour = Number(match[4] || 0);
    const meridiem = match[7]?.toUpperCase();
    if (meridiem && (hour < 1 || hour > 12)) return null;
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return {
      year,
      month: Number(match[1]),
      day: Number(match[2]),
      hour,
      minute: Number(match[5] || 0),
      second: Number(match[6] || 0),
      millisecond: 0
    };
  }

  return null;
}

/**
 * Interprets zone-less portal timestamps in the supplied IANA time zone.
 * Explicit ISO offsets and epoch values are preserved as absolute instants.
 */
export function toEpochMs(value, timeZone = DEFAULT_TIME_ZONE) {
  if (value instanceof Date) {
    const epoch = value.getTime();
    return Number.isFinite(epoch) ? epoch : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(epoch).getTime()) ? epoch : null;
  }

  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{10}$|^\d{13}$/.test(text)) return toEpochMs(Number(text), timeZone);

  // Explicit ISO offsets preserve the absolute instant. Validate the calendar
  // first because Date.parse silently rolls February 30 into March.
  const explicit = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (explicit) {
    const parts = explicit.slice(1).map((value) => Number(value || 0));
    const calendar = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
    if (calendar.getUTCFullYear() !== parts[0] || calendar.getUTCMonth() + 1 !== parts[1] ||
        calendar.getUTCDate() !== parts[2] || calendar.getUTCHours() !== parts[3] ||
        calendar.getUTCMinutes() !== parts[4] || calendar.getUTCSeconds() !== parts[5]) return null;
    const epoch = Date.parse(text);
    return Number.isFinite(epoch) ? epoch : null;
  }

  const local = localPartsFromString(text);
  // Never fall back to machine-local Date.parse for zone-less input. Date-only
  // statements lack a toll instant; DST folds/gaps also require host review.
  if (!local || !/\d{1,2}:\d{2}/.test(text)) return null;

  const wallClockAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.millisecond
  );

  // Sample offsets on both sides of the date, then round-trip every candidate.
  // Zero candidates means a nonexistent time; two means a repeated DST hour.
  const offsets = new Set([-2, -1, 0, 1, 2].map((days) =>
    timeZoneOffsetMs(wallClockAsUtc + days * 86_400_000, timeZone)
  ));
  const candidates = [...offsets].map((offset) => wallClockAsUtc - offset).filter((epoch) => {
    const p = partsAt(epoch, timeZone);
    return ["year", "month", "day", "hour", "minute", "second"].every((key) => p[key] === local[key]);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function normalizeAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.startsWith("(") !== text.endsWith(")")) return null;
  if (!/^\(?-?\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?\)?$/.test(text)) return null;
  const cleaned = text.replace(/[$,\s()]/g, "");
  const amount = Number(cleaned) * (text.startsWith("(") ? -1 : 1);
  return Number.isFinite(amount) ? amount : null;
}

function stableKey(prefix, fields) {
  return `${prefix}:${JSON.stringify(fields)}`;
}

export function normalizeToll(toll, timeZone = DEFAULT_TIME_ZONE) {
  toll = toll && typeof toll === "object" ? toll : {};
  const timestamp = toll.timestamp ?? toll.transactionTime ?? toll.date;
  const timestampMs = toEpochMs(timestamp, timeZone);
  const plaza = String(toll.plaza ?? toll.location ?? "Unknown plaza").trim();
  const amount = normalizeAmount(toll.amount);
  return {
    id: toll.id || stableKey("toll", [timestampMs, plaza, amount, toll.tagId]),
    timestamp,
    timestampMs,
    plaza,
    amount,
    amountCents: amount == null ? null : Math.round(amount * 100),
    tagId: toll.tagId ? String(toll.tagId) : null,
    plate: toll.plate ? String(toll.plate) : null,
    vehicleId: toll.vehicleId ? String(toll.vehicleId) : null
  };
}

export function normalizeTrip(trip, timeZone = DEFAULT_TIME_ZONE) {
  trip = trip && typeof trip === "object" ? trip : {};
  const start = trip.start ?? trip.startTime;
  const end = trip.end ?? trip.endTime;
  const startMs = toEpochMs(start, timeZone);
  const endMs = toEpochMs(end, timeZone);
  const vehicleId = String(trip.vehicleId ?? trip.vehicle ?? "Unknown vehicle").trim();
  return {
    id: trip.id || stableKey("trip", [vehicleId, startMs, endMs]),
    vehicleId,
    start,
    end,
    startMs,
    endMs
  };
}

/**
 * Matches a toll instant against inclusive trip intervals. A match is only
 * automatic when exactly one trip qualifies; overlaps are returned as
 * ambiguous so a host is never silently charged against the wrong trip.
 */
export function reconcileTolls(tolls = [], trips = [], options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const graceMs = Math.max(0, Number(options.graceMinutes) || 0) * 60_000;
  const vehicleByTag = options.vehicleByTag || {};
  const vehicleByPlate = options.vehicleByPlate || {};
  const normalizedTolls = tolls.map((toll) => normalizeToll(toll, timeZone));
  const normalizedTrips = trips.map((trip) => normalizeTrip(trip, timeZone));

  const validTrips = normalizedTrips.filter(
    (trip) =>
      Number.isFinite(trip.startMs) &&
      Number.isFinite(trip.endMs) &&
      trip.vehicleId !== "Unknown vehicle" &&
      trip.startMs <= trip.endMs
  );
  const invalidTrips = normalizedTrips.filter((trip) => !validTrips.includes(trip));
  const matched = [];
  const ambiguous = [];
  const unmatchedTolls = [];
  const matchedTripIds = new Set();

  for (const toll of normalizedTolls) {
    if (!Number.isFinite(toll.timestampMs)) {
      unmatchedTolls.push({ toll, reason: "invalid_timestamp" });
      continue;
    }
    if (!Number.isFinite(toll.amount) || toll.amount <= 0) {
      unmatchedTolls.push({ toll, reason: "invalid_or_nonpositive_amount" });
      continue;
    }

    const identities = [toll.vehicleId,
      toll.tagId && Object.hasOwn(vehicleByTag, toll.tagId) && vehicleByTag[toll.tagId],
      toll.plate && Object.hasOwn(vehicleByPlate, toll.plate) && vehicleByPlate[toll.plate]
    ].filter(Boolean).map(String);
    if (new Set(identities).size > 1) {
      unmatchedTolls.push({ toll, reason: "conflicting_vehicle_mapping" });
      continue;
    }
    const mappedVehicle = identities[0];
    const candidates = validTrips.filter((trip) => {
      const inWindow =
        toll.timestampMs >= trip.startMs - graceMs &&
        toll.timestampMs <= trip.endMs + graceMs;
      const sameVehicle = !mappedVehicle || trip.vehicleId === String(mappedVehicle);
      return inWindow && sameVehicle;
    });

    if (candidates.length === 1) {
      const trip = candidates[0];
      matchedTripIds.add(trip.id);
      matched.push({
        toll,
        trip,
        vehicleConfirmed: Boolean(mappedVehicle),
        withinGrace:
          toll.timestampMs < trip.startMs || toll.timestampMs > trip.endMs
      });
    } else if (candidates.length > 1) {
      ambiguous.push({ toll, candidates, reason: "overlapping_trips" });
    } else {
      unmatchedTolls.push({ toll, reason: "no_trip_in_time_range" });
    }
  }

  return {
    matched,
    ambiguous,
    unmatchedTolls,
    unmatchedTrips: validTrips.filter((trip) => !matchedTripIds.has(trip.id)),
    invalidTrips,
    stats: {
      tollCount: normalizedTolls.length,
      tripCount: normalizedTrips.length,
      matchedCount: matched.length,
      ambiguousCount: ambiguous.length,
      unmatchedTollCount: unmatchedTolls.length
    },
    options: { timeZone, graceMinutes: graceMs / 60_000 }
  };
}
