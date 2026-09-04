import { DEFAULT_TIME_ZONE, reconcileTolls, selectCompletedTrips } from "./reconciler.js";

const STORAGE_KEY = "turoTollReconcilerState";
const PATTERNS = { turo: ["https://turo.com/*"], ezpass: ["https://www.e-zpassny.com/*", "https://e-zpassny.com/*"] };
const MAX_RECORDS = 5000;
const HISTORY_PATH = "/us/en/trips/history";
const TRANSACTIONS_PATH = "/ezpass/dashboard/transactions";
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
  version: 2,
  sources: {
    turo: { records: [], updatedAt: null },
    ezpass: { records: [], updatedAt: null }
  },
  settings: {
    timeZone: DEFAULT_TIME_ZONE, graceMinutes: 0, vehicleByTag: {}, vehicleByPlate: {}
  },
  reconciliation: null,
  lastSync: null
});

// Content scripts have no direct access to persisted data.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
async function getState() {
  await storageReady;
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored?.version === 2) return stored;
  const fresh = emptyState();
  if (stored?.version === 1) {
    // Retire pre-history snapshots, but preserve valid user vehicle mappings.
    try {
      fresh.settings = {
        ...fresh.settings,
        vehicleByTag: cleanMapping(stored.settings?.vehicleByTag || {}),
        vehicleByPlate: cleanMapping(stored.settings?.vehicleByPlate || {}),
        graceMinutes: [0, 15, 30, 60].includes(stored.settings?.graceMinutes) ? stored.settings.graceMinutes : 0
      };
    } catch { /* Invalid legacy settings fall back to defaults. */ }
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
  state.reconciliation = reconcileTolls(
    state.sources.ezpass.records, completed, state.settings
  );
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
    ? ["id", "vehicleId", "start", "end"]
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
    return { source, ok: true, records, warning };
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
  }
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
      const timeZone = supplied.timeZone ?? state.settings.timeZone;
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      const graceMinutes = supplied.graceMinutes ?? state.settings.graceMinutes;
      if (!Number.isFinite(graceMinutes) || graceMinutes < 0 || graceMinutes > 120) throw new Error("Grace period must be 0–120 minutes.");
      state.settings = {
        timeZone, graceMinutes,
        vehicleByTag: cleanMapping(supplied.vehicleByTag ?? state.settings.vehicleByTag),
        vehicleByPlate: cleanMapping(supplied.vehicleByPlate ?? state.settings.vehicleByPlate)
      };
      return { state: await save(reconcile(state)) };
    }
    default: throw new Error("Unknown extension operation.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our popup can request privileged operations, not a content script.
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) {
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
