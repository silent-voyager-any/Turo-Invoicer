import { canonicalizeIdentifier, DEFAULT_TIME_ZONE, normalizeTrip, reconcileTolls, selectCompletedTrips, tripCollectionRange } from "./reconciler.js";
import { batchRevision, buildTripWorkspace, selectAllReady, setTollSelection, setTripApproval, setTripSelection, summarizeSelection } from "./workspace.js";
import { buildTripQueryJobs, flattenTripQueries } from "./trip_queries.js";
import { clearEvidenceBlobs, deleteEvidenceBlob, storePng } from "./evidence_store.js";

const STORAGE_KEY = "turoTollReconcilerState";
const PATTERNS = { turo: ["https://turo.com/*"], ezpass: ["https://www.e-zpassny.com/*", "https://e-zpassny.com/*"] };
const MAX_RECORDS = 5000;
const HISTORY_PATH = "/us/en/trips/history";
const TRANSACTIONS_PATH = "/ezpass/dashboard/transactions";
const EZPASS_COLLECTOR_REVISION = "0.5.3-trip-query-4";
const TURO_INVOICE_ADAPTER_REVISION = "0.4.7-invoice-dom-1";
const STANDARD_TOLL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const TRUSTED_PAGES = new Set(["popup.html", "dashboard.html"]);
const isTransactionsUrl = (url) => {
  try {
    const parsed = new URL(url);
    return ["https://www.e-zpassny.com", "https://e-zpassny.com"].includes(parsed.origin) &&
      parsed.pathname.replace(/\/$/, "") === TRANSACTIONS_PATH;
  } catch { return false; }
};
const isHistoryUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://turo.com" && parsed.pathname.replace(/\/$/, "") === HISTORY_PATH;
  } catch { return false; }
};
let operations = Promise.resolve();
const evidenceSessions = new Map();

const emptyState = () => ({
  version: 5,
  sources: {
    turo: { records: [], updatedAt: null },
    ezpass: { records: [], updatedAt: null }
  },
  settings: {
    timeZone: DEFAULT_TIME_ZONE, graceMinutes: 0
  },
  fleet: { vehicles: [], assignments: [] },
  uiDrafts: { vehicleAssignment: {} },
  collectionRuns: {
    turo: { complete: false, pageCount: 0, recordCount: 0, updatedAt: null, warning: "Not collected." },
    ezpass: { complete: false, pageCount: 0, recordCount: 0, updatedAt: null, warning: "Not collected." }
  },
  tripEligibility: {},
  invoiceDrafts: [],
  selectionSummary: { tripCount: 0, tollCount: 0, totalCents: 0 },
  evidence: [],
  batchApproval: null,
  submissionLedger: [],
  reconciliation: null,
  lastSync: null
});

// Content scripts have no direct access to persisted data.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
async function getState() {
  await storageReady;
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored?.version === 5) {
    const changed = hydrateCanonicalAssignments(stored);
    const state = reconcile(stored);
    if (changed) await save(state);
    return state;
  }
  if (stored?.version === 4) {
    const fresh = emptyState();
    Object.assign(fresh, stored, { version: 5, batchApproval: null });
    fresh.evidence = Array.isArray(stored.evidence) ? stored.evidence : [];
    hydrateCanonicalAssignments(fresh);
    const state = reconcile(fresh);
    await save(state);
    return state;
  }
  const fresh = emptyState();
  if (stored?.version === 3) {
    fresh.sources = stored.sources || fresh.sources;
    fresh.settings = { ...fresh.settings, ...(stored.settings || {}) };
    fresh.fleet = stored.fleet || fresh.fleet;
    fresh.uiDrafts = stored.uiDrafts || fresh.uiDrafts;
    fresh.evidence = Array.isArray(stored.evidence) ? stored.evidence : [];
    fresh.submissionLedger = Array.isArray(stored.submissionLedger) ? stored.submissionLedger : [];
    fresh.lastSync = stored.lastSync || null;
    // Schema 3 never proved pagination or invoice state, so migrated records
    // remain visible but blocked from batch selection until a complete refresh.
    return reconcile(fresh);
  }
  if ([1, 2].includes(stored?.version)) {
    // Version 2 keeps its verified history snapshot; version 1 retires its old
    // pre-history records. Both migrate flat mappings to dated assignments.
    if (stored.version === 2) {
      fresh.sources = stored.sources || fresh.sources;
      fresh.lastSync = stored.lastSync || null;
    }
    fresh.settings.timeZone = stored.settings?.timeZone || DEFAULT_TIME_ZONE;
    fresh.settings.graceMinutes = [0, 15, 30, 60].includes(stored.settings?.graceMinutes) ? stored.settings.graceMinutes : 0;
    try {
      const legacy = [];
      for (const [kind, values] of [["tag", cleanMapping(stored.settings?.vehicleByTag || {})], ["plate", cleanMapping(stored.settings?.vehicleByPlate || {})]]) {
        for (const [identifier, vehicleId] of Object.entries(values)) legacy.push({
          id: `legacy:${kind}:${identifier}`, kind, identifier, vehicleId, label: "", validFrom: null, validTo: null
        });
      }
      fresh.fleet.assignments = legacy;
      fresh.fleet.vehicles = [...new Set([
        ...(fresh.sources.turo?.records || []).map((trip) => String(trip.vehicleId || "")), ...legacy.map((item) => item.vehicleId)
      ].filter(Boolean))].map((vehicleId) => ({ vehicleId, label: "" }));
    } catch { /* Invalid legacy mappings fall back to an empty fleet. */ }
    return reconcile(fresh);
  }
  return fresh;
}

async function save(state) {
  await storageReady;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

function reconcile(state) {
  const { completed } = selectCompletedTrips(state.sources.turo.records, { timeZone: state.settings.timeZone });
  rebuildVehicles(state);
  state.reconciliation = reconcileTolls(
    state.sources.ezpass.records, completed, {
      ...state.settings, vehicleAssignments: state.fleet?.assignments || []
    }
  );
  const workspace = buildTripWorkspace({
    trips: completed,
    reconciliation: state.reconciliation,
    previousDrafts: state.invoiceDrafts,
    tripEligibility: state.tripEligibility,
    collectionRuns: state.collectionRuns,
    submissionLedger: state.submissionLedger,
    evidence: state.evidence,
    timeZone: state.settings.timeZone
  });
  state.invoiceDrafts = workspace.drafts;
  state.selectionSummary = workspace.summary;
  if (state.batchApproval?.revisionHash !== batchRevision(state.invoiceDrafts)) state.batchApproval = null;
  return state;
}

function scalar(value) {
  return (typeof value === "string" && value.length <= 250) ||
    (typeof value === "number" && Number.isFinite(value)) ? value : null;
}

// The page bridge is untrusted. Persist only allowlisted scalar fields.
function sanitizeRecords(source, raw) {
  if (!Array.isArray(raw) || raw.length > MAX_RECORDS) throw new Error("Invalid record batch.");
  const fields = source === "turo"
    ? ["id", "vehicleId", "start", "end", "vehicleLabel", "vehiclePlate", "invoiceStatus", "invoiceStatusReason", "invoiceDeadline"]
    : ["id", "timestamp", "plaza", "amount", "tagId", "plate", "tagOrPlate", "vehicleId",
      "queryId", "queryReservationId", "queryVehicleId", "queryKind", "queryIdentifier"];
  const records = new Map();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = Object.fromEntries(fields.map((key) => [key, scalar(candidate[key])]));
    if (source === "turo" ? record.start == null || record.end == null : record.timestamp == null) continue;
    const key = record.id || JSON.stringify(record);
    if (records.has(key) && JSON.stringify(records.get(key)) !== JSON.stringify(record)) {
      throw new Error("Conflicting duplicate IDs. Clear captures and reload the portal.");
    }
    records.set(key, record);
  }
  return [...records.values()];
}

async function tabRequest(tabId, message, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Portal tab timed out. Keep it open and try sync again.")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const hubUrl = (id) => `https://turo.com/us/en/reservation/${id}/invoice-hub`;
const selectIncidentalUrl = (id) => `https://turo.com/us/en/reservation/${id}/reimbursement/request/select-incidental`;

function validInvoiceUrl(raw, id) {
  try {
    const url = new URL(raw);
    const valid = url.origin === "https://turo.com" && !url.username && !url.password && !url.hash &&
      url.pathname.replace(/\/$/, "") === `/us/en/reservation/${id}/reimbursement/invoice` &&
      url.searchParams.getAll("invoiceId").length === 1 && /^\d{1,20}$/.test(url.searchParams.get("invoiceId") || "") &&
      [...url.searchParams.keys()].every((key) => key === "invoiceId");
    return valid ? url.href : null;
  } catch { return null; }
}

async function readManagedTuroPage(tabId, url, reservationId, expectedPhase) {
  const updated = await chrome.tabs.update(tabId, { url, active: false });
  if (updated?.id !== tabId) throw new Error("Turo status tab changed unexpectedly.");
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url === url && tab.status === "complete") {
      try {
        const response = await tabRequest(tabId, { type: "COLLECT_INVOICE_STATUS", reservationId }, 3000);
        if (response?.ok && response.phase === expectedPhase) return response;
        lastError = new Error(response?.error || "Turo invoice-status adapter returned an unexpected view.");
      } catch (error) { lastError = error; }
    } else if (tab?.url && !tab.url.startsWith("https://turo.com/")) {
      throw new Error("Turo invoice verification left the permitted origin.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Turo invoice verification timed out.");
}

async function verifyTuroInvoiceStatuses(records, timeZone) {
  if (!records.length) return records;
  const firstId = String(records[0].id || "");
  if (!/^\d{1,20}$/.test(firstId)) throw new Error("Turo history returned an invalid reservation ID for invoice verification.");
  let managedTab = null;
  const verified = [];
  try {
    managedTab = await chrome.tabs.create({ url: hubUrl(firstId), active: false });
    if (!Number.isInteger(managedTab?.id)) throw new Error("Could not create the temporary Turo status tab.");
    for (const trip of records) {
      const id = String(trip.id || "");
      const normalized = normalizeTrip(trip, timeZone);
      const deadlineMs = normalized?.endMs + STANDARD_TOLL_WINDOW_MS;
      const invoiceDeadline = Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
      if (!/^\d{1,20}$/.test(id) || !invoiceDeadline) {
        verified.push({ ...trip, invoiceStatus: "status_unknown", invoiceStatusReason: "invalid_trip_identity_or_end", invoiceDeadline });
        continue;
      }
      if (Date.now() > deadlineMs) {
        verified.push({ ...trip, invoiceStatus: "ineligible", invoiceStatusReason: "standard_window_expired", invoiceDeadline });
        continue;
      }
      try {
        const hub = await readManagedTuroPage(managedTab.id, hubUrl(id), id, "hub");
        let hasTolls = false;
        const invoiceUrls = [...new Set((hub.invoiceUrls || []).map((url) => validInvoiceUrl(url, id)).filter(Boolean))];
        for (const invoiceUrl of invoiceUrls) {
          const invoice = await readManagedTuroPage(managedTab.id, invoiceUrl, id, "invoice");
          if (invoice.hasTolls === true) { hasTolls = true; break; }
        }
        if (hasTolls) {
          verified.push({ ...trip, invoiceStatus: "already_charged", invoiceStatusReason: "existing_toll_invoice", invoiceDeadline });
          continue;
        }
        if (!hub.canCreate) throw new Error("Turo did not offer invoice creation for this completed trip.");
        const select = await readManagedTuroPage(managedTab.id, selectIncidentalUrl(id), id, "select");
        if (!select.tollOptionAvailable) throw new Error("Turo did not offer the toll incidental for this trip.");
        verified.push({ ...trip, invoiceStatus: "eligible_uncharged", invoiceStatusReason: "toll_request_available", invoiceDeadline });
      } catch {
        verified.push({ ...trip, invoiceStatus: "status_unknown", invoiceStatusReason: "invoice_view_unverified", invoiceDeadline });
      }
    }
  } finally {
    if (Number.isInteger(managedTab?.id)) await chrome.tabs.remove(managedTab.id).catch(() => {});
  }
  return verified;
}

async function collect(source, request = {}) {
  let tabs = await chrome.tabs.query({ url: PATTERNS[source] });
  if (source === "turo") tabs = tabs.filter((tab) => isHistoryUrl(tab.url));
  else tabs = tabs.filter((tab) => isTransactionsUrl(tab.url));
  // Avoid silently combining different accounts across tabs.
  if (tabs.length !== 1) {
    return {
      source, ok: false,
      error: source === "turo" ? (tabs.length ? "Keep exactly one Turo trip-history tab open." :
        "Open https://turo.com/us/en/trips/history. Other Turo pages are not collected.") :
        (tabs.length ? "Keep exactly one E-ZPass transactions tab open." : "Open https://www.e-zpassny.com/ezpass/dashboard/transactions and apply your filters.")
    };
  }
  try {
    // Turo detail reads share its 20s content deadline; allow 5s for the reply.
      const response = await tabRequest(tabs[0].id, {
        type: "COLLECT_NOW", ...(source === "ezpass" ? { range: request.range, queryJobs: request.queryJobs } : {})
      }, source === "ezpass" ? 305000 : 25000);
      if (source === "ezpass" && response?.collectorRevision !== EZPASS_COLLECTOR_REVISION) {
        throw new Error("The E-ZPass tab is running an older extension script. Reload that transactions tab, then sync again.");
      }
      if (response?.source !== source || !response.ok) throw new Error(response?.error || "Unexpected portal response.");
    if (source === "turo" && response.pagePath !== HISTORY_PATH) throw new Error("Reload the extension and Turo history tab; the history-only collector is not active.");
    if (source === "ezpass" && response.pagePath !== TRANSACTIONS_PATH) throw new Error("Reload the extension and E-ZPass transactions tab; the transactions collector is not active.");
    if (source === "turo" && response.complete !== true) {
      throw new Error("Turo history did not reach a stable terminal footer. Wait for the full history list to load, then sync again.");
    }
    const current = (await chrome.tabs.query({ url: PATTERNS[source] })).find((tab) => tab.id === tabs[0].id);
    if (!(source === "turo" ? isHistoryUrl(current?.url) : isTransactionsUrl(current?.url))) {
      throw new Error("Portal left the supported data page during sync. Return and retry.");
    }
    let records = sanitizeRecords(source, response.records);
    const verifiedEmpty = source === "ezpass" && response.complete === true && response.completeForRange === true;
    if (!records.length && !verifiedEmpty) throw new Error("No supported records captured. Open the data page and reload it.");
    let warning = response.warning || null;
    if (source === "turo") {
      const state = await getState();
      const filtered = selectCompletedTrips(records, { timeZone: state.settings.timeZone });
      records = filtered.completed;
      if (filtered.excludedCount) warning = [warning, `${filtered.excludedCount} upcoming, in-progress, or invalid trips excluded.`].filter(Boolean).join(" ");
      if (!records.length) throw new Error("No completed trips with valid full timestamps were found in history. Future and in-progress trips are excluded.");
    }
    return {
      source, ok: true, records, warning,
      complete: response.complete === true,
      pageCount: Number.isInteger(response.pageCount) && response.pageCount > 0 ? response.pageCount : 1,
      rawCount: Number.isInteger(response.rawCount) && response.rawCount >= records.length ? response.rawCount : records.length,
      range: source === "ezpass" ? request.range || null : null,
      chunkCount: Number.isInteger(response.chunkCount) && response.chunkCount > 0 ? response.chunkCount : 1,
      terminalReason: typeof response.terminalReason === "string" ? response.terminalReason.slice(0, 100) : null,
      completeForRange: response.completeForRange === true,
      observedRange: response.observedRange || null,
      ordering: ["descending", "unverified"].includes(response.ordering) ? response.ordering : "unverified",
      lastPage: Number.isInteger(response.lastPage) && response.lastPage > 0 ? response.lastPage : null,
      queryReports: Array.isArray(response.queryReports) ? response.queryReports.slice(0, 500) : []
    };
  } catch (error) {
    return { source, ok: false, error: error.message || "Reload the portal tab after installation." };
  }
}

async function runSync() {
  // Turo defines the local E-ZPass boundary. The portal list remains unfiltered;
  // its own transaction timestamps determine which normalized tolls are kept.
  const turo = await collect("turo");
  if (!turo.ok) return { state: await getState(), collection: { turo, ezpass: { ok: false, error: "E-ZPass was not started because Turo collection failed." } }, synced: false };
  const currentState = await getState();
  try {
    turo.records = await verifyTuroInvoiceStatuses(turo.records, currentState.settings.timeZone);
  } catch (error) {
    return { state: currentState, collection: { turo: { ...turo, ok: false, error: error.message },
      ezpass: { ok: false, error: "E-ZPass was not started because Turo invoice verification failed." } }, synced: false };
  }
  const verifiedUncharged = turo.records.filter((trip) => trip.invoiceStatus === "eligible_uncharged");
  const range = tripCollectionRange(verifiedUncharged, {
    timeZone: currentState.settings.timeZone, graceMinutes: currentState.settings.graceMinutes
  });
  if (!verifiedUncharged.length) {
    const ezpass = { source: "ezpass", ok: true, records: [], complete: true, completeForRange: true,
      pageCount: 0, rawCount: 0, chunkCount: 0, terminalReason: "no_eligible_trips", queryReports: [], range: null };
    return commitSync(currentState, turo, ezpass, null);
  }
  if (!range) return { state: currentState, collection: { turo, ezpass: { ok: false, error: "Eligible trips did not produce a valid E-ZPass date range." } }, synced: false };
  turo.range = range;
  const queryJobs = flattenTripQueries(buildTripQueryJobs({
    trips: turo.records,
    assignments: currentState.fleet?.assignments || [],
    graceMinutes: currentState.settings.graceMinutes,
    timeZone: currentState.settings.timeZone
  }));
  if (!queryJobs.length) {
    turo.warning = [turo.warning, "Eligible trips were loaded, but no confirmed identifiers are available for E-ZPass search."].filter(Boolean).join(" ");
    const ezpass = { source: "ezpass", ok: true, records: [], complete: true, completeForRange: true,
      pageCount: 0, rawCount: 0, chunkCount: 0, terminalReason: "no_confirmed_identifiers", queryReports: [], range };
    return commitSync(await getState(), turo, ezpass, range);
  }
  const coveredTrips = new Set(queryJobs.map((job) => job.reservationId));
  const missingMappings = verifiedUncharged.filter((trip) => !coveredTrips.has(String(trip.id))).length;
  if (missingMappings) turo.warning = [turo.warning, `${missingMappings} eligible trips have no active confirmed identifier and were not searched.`].filter(Boolean).join(" ");
  const ezpass = await collect("ezpass", { range, queryJobs });
  // Commit both sources together. A failed/empty extraction leaves the last
  // complete snapshot intact and visibly reports that it was NOT refreshed.
  if (!turo.ok || !ezpass.ok) {
    return { state: await getState(), collection: { turo, ezpass }, synced: false };
  }
  return commitSync(await getState(), turo, ezpass, range);
}

async function commitSync(state, turo, ezpass, range) {
  const now = new Date().toISOString();
  for (const result of [turo, ezpass]) {
    state.sources[result.source] = { records: result.records, updatedAt: now };
    state.collectionRuns[result.source] = {
      complete: result.complete,
      pageCount: result.pageCount,
      recordCount: result.records.length,
      rawCount: result.rawCount,
      updatedAt: now,
      warning: result.complete ? null : (result.warning || "Only records loaded by the current portal page were captured; pagination is incomplete."),
      range: result.range || null,
      requestedRange: result.source === "ezpass" ? range : result.range || null,
      chunkCount: result.chunkCount || 1,
      terminalReason: result.terminalReason || null,
      completeForRange: result.source === "ezpass" ? result.completeForRange === true : result.complete === true,
      observedRange: result.observedRange || null,
      ordering: result.ordering || null,
      lastPage: result.lastPage || null,
      queryReports: result.queryReports || []
    };
  }
  state.tripEligibility = Object.fromEntries(state.sources.turo.records.map((trip) => [String(trip.id), {
    status: ["eligible_uncharged", "already_charged", "ineligible", "status_unknown"].includes(trip.invoiceStatus)
      ? trip.invoiceStatus : "status_unknown",
    deadline: trip.invoiceDeadline || null,
    reason: trip.invoiceStatusReason || null,
    adapterRevision: TURO_INVOICE_ADAPTER_REVISION,
    checkedAt: now
  }]));
  state.lastSync = now;
  await save(reconcile(state));
  return {
    state, synced: true,
    collection: {
      turo: { ok: true, warning: turo.warning },
      ezpass: { ok: true, warning: ezpass.warning }
    }
  };
}

function cleanMapping(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 500) {
    throw new Error("Vehicle mappings must be JSON objects with at most 500 entries.");
  }
  const entries = Object.entries(raw);
  for (const [key, value] of entries) {
    if (!key || key.length > 100 || typeof value !== "string" || !value.trim() || value.length > 100 ||
        ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid vehicle mapping.");
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value.trim()]));
}

function cleanDate(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be a calendar date.`);
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
  return value;
}

function cleanAssignment(raw, existingId = null) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid vehicle assignment.");
  const kind = raw.kind;
  const identifier = typeof raw.identifier === "string" ? raw.identifier.trim() : "";
  const vehicleId = typeof raw.vehicleId === "string" ? raw.vehicleId.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!["tag", "plate"].includes(kind) || !identifier || identifier.length > 100 || !vehicleId || vehicleId.length > 100 || label.length > 100) {
    throw new Error("Assignment requires a vehicle, tag or plate, and valid values.");
  }
  const validFrom = cleanDate(raw.validFrom, "Start date");
  const validTo = cleanDate(raw.validTo, "End date");
  if (validFrom && validTo && validFrom > validTo) throw new Error("End date cannot precede start date.");
  const canonicalIdentifier = canonicalizeIdentifier(kind, identifier);
  if (!canonicalIdentifier) throw new Error("Tag or plate must contain letters or numbers.");
  return { id: existingId || crypto.randomUUID(), kind, identifier, canonicalIdentifier, vehicleId, label, validFrom, validTo };
}

function hydrateCanonicalAssignments(state) {
  let changed = false;
  const assignments = Array.isArray(state.fleet?.assignments) ? state.fleet.assignments : [];
  for (const assignment of assignments) {
    const canonical = canonicalizeIdentifier(assignment.kind, assignment.identifier);
    if (assignment.canonicalIdentifier !== canonical) {
      assignment.canonicalIdentifier = canonical;
      changed = true;
    }
  }
  return changed;
}

function rangesOverlap(left, right) {
  return (left.validFrom || "0000-00-00") <= (right.validTo || "9999-99-99") &&
    (right.validFrom || "0000-00-00") <= (left.validTo || "9999-99-99");
}

function assertNoAssignmentOverlap(assignments) {
  for (let index = 0; index < assignments.length; index++) {
    for (let other = index + 1; other < assignments.length; other++) {
      const left = assignments[index], right = assignments[other];
      const sameIdentifier = left.kind === right.kind &&
        (left.canonicalIdentifier || canonicalizeIdentifier(left.kind, left.identifier)) ===
        (right.canonicalIdentifier || canonicalizeIdentifier(right.kind, right.identifier));
      if (sameIdentifier && rangesOverlap(left, right)) {
        throw new Error(`Overlapping ${left.kind} assignments are not allowed.`);
      }
    }
  }
}

function rebuildVehicles(state) {
  const vehicles = new Map((state.fleet?.vehicles || []).map((vehicle) => [String(vehicle.vehicleId), {
    vehicleId: String(vehicle.vehicleId), label: String(vehicle.label || ""), sourcePlate: vehicle.sourcePlate || null
  }]));
  for (const trip of state.sources.turo.records) {
    const vehicleId = String(trip.vehicleId || "");
    if (!vehicleId) continue;
    const current = vehicles.get(vehicleId) || { vehicleId, label: "", sourcePlate: null };
    if (!current.label && trip.vehicleLabel) current.label = String(trip.vehicleLabel);
    if (!current.sourcePlate && trip.vehiclePlate) current.sourcePlate = String(trip.vehiclePlate);
    vehicles.set(vehicleId, current);
  }
  for (const assignment of state.fleet.assignments) {
    const current = vehicles.get(assignment.vehicleId) || { vehicleId: assignment.vehicleId, label: "", sourcePlate: null };
    if (assignment.label) current.label = assignment.label;
    vehicles.set(assignment.vehicleId, current);
  }
  for (const vehicle of vehicles.values()) {
    const source = canonicalizeIdentifier("plate", vehicle.sourcePlate);
    vehicle.sourcePlateConfirmed = Boolean(source && state.fleet.assignments.some((assignment) =>
      assignment.kind === "plate" && String(assignment.vehicleId) === vehicle.vehicleId &&
      (assignment.canonicalIdentifier || canonicalizeIdentifier("plate", assignment.identifier)) === source));
  }
  state.fleet.vehicles = [...vehicles.values()];
}

async function clearData() {
  const resets = await Promise.all(Object.values(PATTERNS).map(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return Promise.allSettled(tabs.map((tab) => tabRequest(tab.id, { type: "CLEAR_CAPTURE" })));
  }));
  await storageReady;
  await chrome.storage.local.remove(STORAGE_KEY);
  await clearEvidenceBlobs().catch(() => {});
  return { state: emptyState(), resetFailures: resets.flat().filter((r) => r.status === "rejected").length };
}

async function prepareBatchEvidence() {
  const state = await getState();
  const selected = state.invoiceDrafts.filter((draft) => draft.selected === true && draft.selectable === true);
  if (!selected.length) throw new Error("Select at least one ready trip first.");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!Number.isInteger(tab?.id) || !isTransactionsUrl(tab.url)) {
    throw new Error("Open the E-ZPass transactions tab, then click Prepare evidence from the extension popup.");
  }
  const selectedReservations = new Set(selected.map((draft) => String(draft.reservationId)));
  const allQueries = flattenTripQueries(buildTripQueryJobs({
    trips: state.sources.turo.records,
    tripEligibility: state.tripEligibility,
    assignments: state.fleet.assignments,
    graceMinutes: state.settings.graceMinutes,
    timeZone: state.settings.timeZone
  }));
  const queryMap = new Map(allQueries.filter((query) => selectedReservations.has(query.reservationId)).map((query) => [query.queryId, query]));
  const sourceById = new Map(state.sources.ezpass.records.map((toll) => [String(toll.id), toll]));
  const evidenceTargets = {};
  for (const draft of selected) {
    for (const tollId of draft.selectedTollIds) {
      const source = sourceById.get(String(tollId));
      if (!source) throw new Error("Selected toll is missing from the verified E-ZPass snapshot. Sync again before preparing evidence.");
      const matching = [...queryMap.values()].filter((query) => query.reservationId === String(draft.reservationId) &&
        [source.tagId, source.plate, source.tagOrPlate].some((value) => canonicalizeIdentifier(query.kind, value) === query.canonicalIdentifier));
      if (!matching.length) throw new Error("Selected toll no longer resolves to an exact active trip identifier. Sync again.");
      for (const query of matching) (evidenceTargets[query.queryId] ||= []).push(String(tollId));
    }
  }
  const queryJobs = [...queryMap.values()].filter((query) => evidenceTargets[query.queryId]?.length);
  if (!queryJobs.length) throw new Error("No selected toll rows are available for evidence capture.");
  const token = crypto.randomUUID();
  const session = { tabId: tab.id, windowId: tab.windowId, token, evidence: [], allowedQueries: new Set(queryJobs.map((query) => query.queryId)) };
  evidenceSessions.set(token, session);
  try {
    const response = await tabRequest(tab.id, { type: "COLLECT_NOW", queryJobs, evidenceTargets, evidenceToken: token }, 305000);
    if (!response?.ok || response.collectorRevision !== EZPASS_COLLECTOR_REVISION || response.complete !== true) {
      throw new Error(response?.error || "E-ZPass evidence searches did not complete.");
    }
    const covered = new Set(session.evidence.flatMap((item) => item.coveredTollIds || []));
    const missing = Object.values(evidenceTargets).flat().filter((id) => !covered.has(String(id)));
    if (missing.length) throw new Error(`${missing.length} selected toll rows were not visible in captured evidence.`);
    const old = state.evidence.filter((item) => selectedReservations.has(String(item.reservationId)));
    for (const item of old) await deleteEvidenceBlob(item.id).catch(() => {});
    state.evidence = state.evidence.filter((item) => !selectedReservations.has(String(item.reservationId))).concat(session.evidence);
    state.batchApproval = null;
    return { state: await save(reconcile(state)), captured: session.evidence.length };
  } catch (error) {
    for (const item of session.evidence) await deleteEvidenceBlob(item.id).catch(() => {});
    throw error;
  } finally {
    evidenceSessions.delete(token);
  }
}

async function captureEvidencePage(message, sender) {
  const session = evidenceSessions.get(String(message.token || ""));
  if (!session || sender.id !== chrome.runtime.id || sender.tab?.id !== session.tabId ||
      !isTransactionsUrl(sender.url) || !session.allowedQueries.has(String(message.queryId || ""))) {
    throw new Error("Evidence capture request was not authorized.");
  }
  const coveredTollIds = Array.isArray(message.coveredTollIds) ? [...new Set(message.coveredTollIds.map(String))].slice(0, 100) : [];
  if (!coveredTollIds.length) throw new Error("Evidence page did not identify selected toll rows.");
  const active = await chrome.tabs.get(session.tabId);
  if (!active?.active || !isTransactionsUrl(active.url)) throw new Error("Keep the E-ZPass transactions tab visible throughout evidence capture.");
  const dataUrl = await chrome.tabs.captureVisibleTab(session.windowId, { format: "png" });
  const capturedAt = new Date().toISOString();
  const metadata = await storePng(dataUrl, {
    reservationId: String(message.reservationId || ""), queryId: String(message.queryId || ""),
    kind: message.kind === "plate" ? "plate" : "tag", identifier: String(message.identifier || "").slice(0, 100),
    startDate: String(message.startDate || "").slice(0, 10), endDate: String(message.endDate || "").slice(0, 10),
    pageNumber: Number.isInteger(message.pageNumber) ? message.pageNumber : 1,
    coveredTollIds, capturedAt, sourceRoute: TRANSACTIONS_PATH, retentionDeadline: null
  });
  session.evidence.push(metadata);
  return { evidenceId: metadata.id };
}

async function cleanupExpiredEvidence() {
  const state = await getState();
  const now = Date.now();
  const expired = state.evidence.filter((item) => item.retentionDeadline && Date.parse(item.retentionDeadline) <= now);
  if (!expired.length) return;
  for (const item of expired) await deleteEvidenceBlob(item.id).catch(() => {});
  const ids = new Set(expired.map((item) => item.id));
  state.evidence = state.evidence.filter((item) => !ids.has(item.id));
  await save(reconcile(state));
}

async function handle(message) {
  switch (message?.type) {
    case "GET_STATE": return { state: await getState() };
    case "RUN_SYNC": return runSync();
    case "CLEAR_LOCAL_DATA": return clearData();
    case "UPDATE_SETTINGS": {
      const state = await getState();
      const supplied = message.settings || {};
      if ("vehicleByTag" in supplied || "vehicleByPlate" in supplied) {
        throw new Error("Use dated fleet assignments instead of legacy mapping objects.");
      }
      const timeZone = supplied.timeZone ?? state.settings.timeZone;
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      const graceMinutes = supplied.graceMinutes ?? state.settings.graceMinutes;
      if (!Number.isFinite(graceMinutes) || graceMinutes < 0 || graceMinutes > 120) throw new Error("Grace period must be 0–120 minutes.");
      state.settings = {
        timeZone, graceMinutes
      };
      return { state: await save(reconcile(state)) };
    }
    case "SAVE_UI_DRAFT": {
      const state = await getState();
      const draft = message.draft || {};
      state.uiDrafts.vehicleAssignment = {
        vehicleId: String(draft.vehicleId || "").slice(0, 100),
        label: String(draft.label || "").slice(0, 100),
        kind: ["tag", "plate"].includes(draft.kind) ? draft.kind : "tag",
        identifier: String(draft.identifier || "").slice(0, 100),
        validFrom: String(draft.validFrom || "").slice(0, 10),
        validTo: String(draft.validTo || "").slice(0, 10)
      };
      return { state: await save(state) };
    }
    case "UPSERT_ASSIGNMENT": {
      const state = await getState();
      const existing = message.assignment?.id && state.fleet.assignments.find((item) => item.id === message.assignment.id);
      const assignment = cleanAssignment(message.assignment, existing?.id || null);
      if (!existing && state.fleet.assignments.length >= 1000) throw new Error("Fleet assignment limit reached.");
      const assignments = existing
        ? state.fleet.assignments.map((item) => item.id === existing.id ? assignment : item)
        : [...state.fleet.assignments, assignment];
      assertNoAssignmentOverlap(assignments);
      state.fleet.assignments = assignments;
      state.uiDrafts.vehicleAssignment = {};
      rebuildVehicles(state);
      return { state: await save(reconcile(state)) };
    }
    case "DELETE_ASSIGNMENT": {
      const state = await getState();
      state.fleet.assignments = state.fleet.assignments.filter((item) => item.id !== message.id);
      rebuildVehicles(state);
      return { state: await save(reconcile(state)) };
    }
    case "SET_TOLL_SELECTION": {
      const state = await getState();
      state.invoiceDrafts = setTollSelection(
        state.invoiceDrafts, message.reservationId, message.tollId, message.selected === true
      );
      state.selectionSummary = summarizeSelection(state.invoiceDrafts);
      state.batchApproval = null;
      return { state: await save(reconcile(state)) };
    }
    case "SET_TRIP_SELECTION": {
      const state = await getState();
      state.invoiceDrafts = setTripSelection(
        state.invoiceDrafts, message.reservationId, message.selected === true
      );
      state.selectionSummary = summarizeSelection(state.invoiceDrafts);
      state.batchApproval = null;
      return { state: await save(reconcile(state)) };
    }
    case "SELECT_ALL_READY": {
      const state = await getState();
      state.invoiceDrafts = selectAllReady(state.invoiceDrafts, message.selected !== false);
      state.selectionSummary = summarizeSelection(state.invoiceDrafts);
      state.batchApproval = null;
      return { state: await save(state) };
    }
    case "PREPARE_BATCH": {
      return prepareBatchEvidence();
    }
    case "SET_TRIP_APPROVAL": {
      const state = await getState();
      state.invoiceDrafts = setTripApproval(state.invoiceDrafts, message.reservationId, message.approved === true);
      state.batchApproval = null;
      return { state: await save(state) };
    }
    case "APPROVE_BATCH": {
      const state = await getState();
      const selected = state.invoiceDrafts.filter((draft) => draft.selected);
      if (!selected.length || selected.some((draft) => !draft.batchReady || !draft.tripApproved)) {
        throw new Error("Every selected trip must have complete evidence and individual approval.");
      }
      state.batchApproval = { revisionHash: batchRevision(state.invoiceDrafts), approvedAt: new Date().toISOString() };
      return { state: await save(state) };
    }
    case "RUN_APPROVED_BATCH": {
      const state = await getState();
      if (!state.batchApproval || state.batchApproval.revisionHash !== batchRevision(state.invoiceDrafts)) {
        throw new Error("Approve the current unchanged batch before submission.");
      }
      throw new Error("Turo upload and final-send automation remains disabled until its authenticated fixtures pass. No invoice was submitted.");
    }
    case "DELETE_EVIDENCE": {
      const state = await getState();
      const item = state.evidence.find((entry) => entry.id === message.id);
      if (!item) throw new Error("Evidence was not found.");
      await deleteEvidenceBlob(item.id);
      state.evidence = state.evidence.filter((entry) => entry.id !== item.id);
      state.batchApproval = null;
      return { state: await save(reconcile(state)) };
    }
    default: throw new Error("Unknown extension operation.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EVIDENCE_PAGE_READY") {
    captureEvidencePage(message, sender).then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Evidence capture failed." }));
    return true;
  }
  // Only our exact extension UI pages can request privileged operations.
  const trustedPage = [...TRUSTED_PAGES].some((page) => sender.url === chrome.runtime.getURL(page));
  if (sender.id !== chrome.runtime.id || !trustedPage) {
    sendResponse({ ok: false, error: "Untrusted sender." });
    return false;
  }
  // Serialize read-modify-write operations. Portal collection is also ordered:
  // Turo establishes the E-ZPass date range before toll pagination begins.
  // Service-worker restarts simply reload the last persisted snapshot.
  const work = operations.then(() => handle(message));
  operations = work.catch(() => {});
  work.then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
    sendResponse({ ok: false, error: error.message || "Extension operation failed." });
  });
  return true;
});

chrome.runtime.onInstalled?.addListener(() => {
  chrome.alarms.create("evidence-retention", { periodInMinutes: 24 * 60 });
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === "evidence-retention") cleanupExpiredEvidence().catch(() => {});
});
