import { DEFAULT_TIME_ZONE, reconcileTolls } from "./reconciler.js";

const STORAGE_KEY = "turoTollReconcilerState";
const PATTERNS = { turo: ["https://turo.com/*"], ezpass: ["https://www.e-zpassny.com/*", "https://e-zpassny.com/*"] };
const MAX_RECORDS = 5000;
let operations = Promise.resolve();

const emptyState = () => ({
  version: 1,
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
  return stored?.version === 1 ? stored : emptyState();
}

async function save(state) {
  await storageReady;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

function reconcile(state) {
  state.reconciliation = reconcileTolls(
    state.sources.ezpass.records, state.sources.turo.records, state.settings
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
    : ["id", "timestamp", "plaza", "amount", "tagId", "plate", "vehicleId"];
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

async function tabRequest(tabId, message) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Portal tab timed out.")), 5000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(source) {
  const tabs = await chrome.tabs.query({ url: PATTERNS[source] });
  // Avoid silently combining different accounts across tabs.
  if (tabs.length !== 1) {
    return {
      source, ok: false,
      error: tabs.length ? "Keep exactly one " + source + " portal tab open." : "Open a signed-in " + source + " portal tab."
    };
  }
  try {
    const response = await tabRequest(tabs[0].id, { type: "COLLECT_NOW" });
    if (response?.source !== source || !response.ok) throw new Error(response?.error || "Unexpected portal response.");
    const records = sanitizeRecords(source, response.records);
    if (!records.length) throw new Error("No supported records captured. Open the data page and reload it.");
    return { source, ok: true, records, warning: response.warning || null };
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
