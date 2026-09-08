import { normalizeTrip } from "./reconciler.js";

const text = (value) => value == null ? "" : String(value);

function localDate(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(epochMs));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const value = `${get("year")}-${get("month")}-${get("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function overlaps(assignment, startDate, endDate) {
  return (assignment.validFrom || "0000-00-00") <= endDate &&
    startDate <= (assignment.validTo || "9999-99-99");
}

export function buildTripQueryJobs({ trips = [], tripEligibility = {}, assignments = [], graceMinutes = 0,
  timeZone = "America/New_York" } = {}) {
  const graceMs = Math.max(0, Math.min(120, Number(graceMinutes) || 0)) * 60000;
  const jobs = [];
  for (const trip of trips) {
    const reservationId = text(trip.id);
    const vehicleId = text(trip.vehicleId);
    const normalized = normalizeTrip(trip, timeZone);
    const startMs = normalized?.startMs;
    const endMs = normalized?.endMs;
    if (!reservationId || !vehicleId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
    if (tripEligibility?.[reservationId]?.status !== "eligible_uncharged" && trip.invoiceStatus !== "eligible_uncharged") continue;
    const startDate = localDate(startMs - graceMs, timeZone);
    const endDate = localDate(endMs + graceMs, timeZone);
    if (!startDate || !endDate) continue;
    const seen = new Set();
    const identifiers = [];
    for (const assignment of assignments) {
      if (text(assignment.vehicleId) !== vehicleId || !["tag", "plate"].includes(assignment.kind) ||
          !assignment.canonicalIdentifier || !overlaps(assignment, startDate, endDate)) continue;
      const key = `${assignment.kind}:${assignment.canonicalIdentifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identifiers.push({
        kind: assignment.kind,
        identifier: text(assignment.identifier),
        canonicalIdentifier: text(assignment.canonicalIdentifier)
      });
    }
    if (identifiers.length) jobs.push({ reservationId, vehicleId, startDate, endDate, startMs, endMs, identifiers });
  }
  jobs.sort((a, b) => a.startMs - b.startMs || a.reservationId.localeCompare(b.reservationId));
  return jobs;
}

export function flattenTripQueries(jobs = []) {
  return jobs.flatMap((job) => job.identifiers.map((identifier) => ({
    queryId: `${job.reservationId}:${identifier.kind}:${identifier.canonicalIdentifier}`,
    reservationId: job.reservationId,
    vehicleId: job.vehicleId,
    startDate: job.startDate,
    endDate: job.endDate,
    startMs: job.startMs,
    endMs: job.endMs,
    ...identifier
  })));
}
