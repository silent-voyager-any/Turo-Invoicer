import { normalizeTrip } from "./reconciler.js";

export const ELIGIBILITY_STATES = new Set([
  "eligible_uncharged", "already_charged", "ineligible", "status_unknown"
]);

const text = (value) => value == null ? "" : String(value);
const runComplete = (runs, source) => runs?.[source]?.complete === true;

function previousByTrip(previous) {
  return new Map((Array.isArray(previous) ? previous : []).map((draft) => [text(draft.reservationId), draft]));
}

function confirmedMatches(reconciliation) {
  const byTrip = new Map();
  for (const match of reconciliation?.matched || []) {
    if (!match?.vehicleConfirmed || !match.trip?.id || !match.toll?.id) continue;
    const id = text(match.trip.id);
    if (!byTrip.has(id)) byTrip.set(id, []);
    byTrip.get(id).push({
      id: text(match.toll.id),
      timestampMs: match.toll.timestampMs,
      plaza: text(match.toll.plaza) || "Unknown plaza",
      amountCents: match.toll.amountCents,
      tagId: match.toll.tagId || null,
      plate: match.toll.plate || null,
      tagOrPlate: match.toll.tagOrPlate || null,
      withinGrace: match.withinGrace === true
    });
  }
  return byTrip;
}

function sentFingerprints(ledger) {
  return new Set((Array.isArray(ledger) ? ledger : []).flatMap((entry) =>
    entry?.status === "sent" && Array.isArray(entry.tollIds) ? entry.tollIds.map(text) : []));
}

export function buildTripWorkspace({
  trips = [], reconciliation = null, previousDrafts = [], tripEligibility = {},
  collectionRuns = {}, submissionLedger = [], timeZone = "America/New_York"
} = {}) {
  const old = previousByTrip(previousDrafts);
  const matches = confirmedMatches(reconciliation);
  const sent = sentFingerprints(submissionLedger);
  const drafts = [];

  for (const raw of trips) {
    const trip = normalizeTrip(raw, timeZone);
    if (!trip.id || !Number.isFinite(trip.startMs) || !Number.isFinite(trip.endMs)) continue;
    const reservationId = text(trip.id);
    const prior = old.get(reservationId);
    const eligibilityRecord = tripEligibility?.[reservationId] || {};
    const eligibility = ELIGIBILITY_STATES.has(eligibilityRecord.status)
      ? eligibilityRecord.status : "status_unknown";
    const tolls = (matches.get(reservationId) || []).filter((toll) => !sent.has(toll.id));
    const validIds = new Set(tolls.map((toll) => toll.id));
    const selectedTollIds = prior?.selectionTouched
      ? (prior.selectedTollIds || []).map(text).filter((id) => validIds.has(id))
      : tolls.map((toll) => toll.id);
    const selected = prior?.selected === true;
    const blockingReasons = [];
    if (!runComplete(collectionRuns, "turo")) blockingReasons.push("turo_collection_incomplete");
    if (!runComplete(collectionRuns, "ezpass")) blockingReasons.push("ezpass_collection_incomplete");
    if (eligibility !== "eligible_uncharged") blockingReasons.push(eligibility);
    if (!tolls.length) blockingReasons.push("no_matching_tolls");
    if (!selectedTollIds.length && tolls.length) blockingReasons.push("no_tolls_selected");
    const selectable = blockingReasons.length === 0;
    const totalCents = tolls.filter((toll) => selectedTollIds.includes(toll.id))
      .reduce((sum, toll) => sum + (Number.isInteger(toll.amountCents) ? toll.amountCents : 0), 0);
    drafts.push({
      id: `draft:${reservationId}`,
      reservationId,
      vehicleId: trip.vehicleId,
      startMs: trip.startMs,
      endMs: trip.endMs,
      eligibility,
      eligibilityReason: eligibilityRecord.reason || null,
      eligibilityDeadline: eligibilityRecord.deadline || null,
      tolls,
      selectedTollIds,
      selectionTouched: prior?.selectionTouched === true,
      selected: selectable && selected,
      selectable,
      blockingReasons,
      totalCents,
      status: selectable ? "needs_evidence" : eligibility === "already_charged" ? "already_charged" : "manual_review"
    });
  }

  drafts.sort((left, right) => right.endMs - left.endMs || left.reservationId.localeCompare(right.reservationId));
  return { drafts, summary: summarizeSelection(drafts) };
}

export function setTollSelection(drafts, reservationId, tollId, selected) {
  return drafts.map((draft) => {
    if (text(draft.reservationId) !== text(reservationId)) return draft;
    const valid = new Set((draft.tolls || []).map((toll) => text(toll.id)));
    if (!valid.has(text(tollId))) throw new Error("Toll is not attached to that trip.");
    const next = new Set((draft.selectedTollIds || []).map(text));
    if (selected) next.add(text(tollId)); else next.delete(text(tollId));
    const selectedTollIds = [...next].filter((id) => valid.has(id));
    const totalCents = (draft.tolls || []).filter((toll) => selectedTollIds.includes(text(toll.id)))
      .reduce((sum, toll) => sum + (Number.isInteger(toll.amountCents) ? toll.amountCents : 0), 0);
    const reasons = (draft.blockingReasons || []).filter((reason) => reason !== "no_tolls_selected");
    if (!selectedTollIds.length) reasons.push("no_tolls_selected");
    const selectable = reasons.length === 0;
    return { ...draft, selectedTollIds, selectionTouched: true, totalCents, blockingReasons: reasons, selectable, selected: selectable && draft.selected };
  });
}

export function setTripSelection(drafts, reservationId, selected) {
  let found = false;
  const next = drafts.map((draft) => {
    if (text(draft.reservationId) !== text(reservationId)) return draft;
    found = true;
    if (selected && !draft.selectable) throw new Error("Trip is not ready for selection.");
    return { ...draft, selected: selected === true };
  });
  if (!found) throw new Error("Trip draft was not found.");
  return next;
}

export function selectAllReady(drafts, selected = true) {
  return drafts.map((draft) => ({ ...draft, selected: selected === true && draft.selectable === true }));
}

export function summarizeSelection(drafts) {
  const selected = (Array.isArray(drafts) ? drafts : []).filter((draft) => draft.selected === true && draft.selectable === true);
  return {
    tripCount: selected.length,
    tollCount: selected.reduce((sum, draft) => sum + (draft.selectedTollIds?.length || 0), 0),
    totalCents: selected.reduce((sum, draft) => sum + (Number.isInteger(draft.totalCents) ? draft.totalCents : 0), 0)
  };
}
