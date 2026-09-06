import { canonicalizeIdentifier, DEFAULT_TIME_ZONE, reconcileTolls, selectCompletedTrips } from "./reconciler.js";
import { buildTripWorkspace, selectAllReady, setTollSelection, setTripSelection, summarizeSelection } from "./workspace.js";

const STORAGE_KEY = "turoTollReconcilerState";
const PATTERNS = { turo: ["https://turo.com/*"], ezpass: ["https://www.e-zpassny.com/*", "https://e-zpassny.com/*"] };
const MAX_RECORDS = 5000;
const HISTORY_PATH = "/us/en/trips/history";
const TRANSACTIONS_PATH = "/ezpass/dashboard/transactions";
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

const emptyState = () => ({
  version: 4,
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
  submissionLedger: [],
  reconciliation: null,
  lastSync: null
});

// Content scripts have no direct access to persisted data.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
async function getState() {
  await storageReady;
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored?.version === 4) {
    const changed = hydrateCanonicalAssignments(stored);
    const state = reconcile(stored);
    if (changed) await save(state);
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
    timeZone: state.settings.timeZone
  });
  state.invoiceDrafts = workspace.drafts;
  state.selectionSummary = workspace.summary;
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
    ? ["id", "vehicleId", "start", "end", "vehicleLabel", "vehiclePlate", "invoiceStatus", "invoiceDeadline"]
    : ["id", "timestamp", "plaza", "amount", "tagId", "plate", "tagOrPlate", "vehicleId"];
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

async function collect(source) {
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
    const response = await tabRequest(tabs[0].id, { type: "COLLECT_NOW" }, 25000);
    if (response?.source !== source || !response.ok) throw new Error(response?.error || "Unexpected portal response.");
    if (source === "turo" && response.pagePath !== HISTORY_PATH) throw new Error("Reload the extension and Turo history tab; the history-only collector is not active.");
    if (source === "ezpass" && response.pagePath !== TRANSACTIONS_PATH) throw new Error("Reload the extension and E-ZPass transactions tab; the transactions collector is not active.");
    const current = (await chrome.tabs.query({ url: PATTERNS[source] })).find((tab) => tab.id === tabs[0].id);
    if (!(source === "turo" ? isHistoryUrl(current?.url) : isTransactionsUrl(current?.url))) {
      throw new Error("Portal left the supported data page during sync. Return and retry.");
    }
    let records = sanitizeRecords(source, response.records);
    if (!records.length) throw new Error("No supported records captured. Open the data page and reload it.");
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
      rawCount: Number.isInteger(response.rawCount) && response.rawCount >= records.length ? response.rawCount : records.length
    };
  } catch (error) {
    return { source, ok: false, error: error.message || "Reload the portal tab after installation." };
  }
}

async function runSync() {
  const [turo, ezpass] = await Promise.all([collect("turo"), collect("ezpass")]);
  // Commit both sources together. A failed/empty extraction leaves the last
  // complete snapshot intact and visibly reports that it was NOT refreshed.
  if (!turo.ok || !ezpass.ok) {
    return { state: await getState(), collection: { turo, ezpass }, synced: false };
  }
  const state = await getState();
  const now = new Date().toISOString();
  for (const result of [turo, ezpass]) {
    state.sources[result.source] = { records: result.records, updatedAt: now };
    state.collectionRuns[result.source] = {
      complete: result.complete,
      pageCount: result.pageCount,
      recordCount: result.records.length,
      rawCount: result.rawCount,
      updatedAt: now,
      warning: result.complete ? null : (result.warning || "Only records loaded by the current portal page were captured; pagination is incomplete.")
    };
  }
  state.tripEligibility = Object.fromEntries(state.sources.turo.records.map((trip) => [String(trip.id), {
    status: ["eligible_uncharged", "already_charged", "ineligible", "status_unknown"].includes(trip.invoiceStatus)
      ? trip.invoiceStatus : "status_unknown",
    deadline: trip.invoiceDeadline || null,
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
  return { state: emptyState(), resetFailures: resets.flat().filter((r) => r.status === "rejected").length };
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
      return { state: await save(state) };
    }
    case "SET_TRIP_SELECTION": {
      const state = await getState();
      state.invoiceDrafts = setTripSelection(
        state.invoiceDrafts, message.reservationId, message.selected === true
      );
      state.selectionSummary = summarizeSelection(state.invoiceDrafts);
      return { state: await save(state) };
    }
    case "SELECT_ALL_READY": {
      const state = await getState();
      state.invoiceDrafts = selectAllReady(state.invoiceDrafts, message.selected !== false);
      state.selectionSummary = summarizeSelection(state.invoiceDrafts);
      return { state: await save(state) };
    }
    case "PREPARE_BATCH": {
      const state = await getState();
      if (!state.selectionSummary?.tripCount) throw new Error("Select at least one ready trip first.");
      throw new Error("Evidence capture is not enabled in this collector release. No invoice was submitted.");
    }
    default: throw new Error("Unknown extension operation.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our exact extension UI pages can request privileged operations.
  const trustedPage = [...TRUSTED_PAGES].some((page) => sender.url === chrome.runtime.getURL(page));
  if (sender.id !== chrome.runtime.id || !trustedPage) {
    sendResponse({ ok: false, error: "Untrusted sender." });
    return false;
  }
  // Serialize read-modify-write operations; the two portal reads stay parallel.
  // Service-worker restarts simply reload the last persisted snapshot.
  const work = operations.then(() => handle(message));
  operations = work.catch(() => {});
  work.then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
    sendResponse({ ok: false, error: error.message || "Extension operation failed." });
  });
  return true;
});
