const elements = {
  syncButton: document.querySelector("#syncButton"),
  clearButton: document.querySelector("#clearButton"),
  graceMinutes: document.querySelector("#graceMinutes"),
  status: document.querySelector("#status"),
  statusDot: document.querySelector("#statusDot"),
  tripCount: document.querySelector("#tripCount"),
  tollCount: document.querySelector("#tollCount"),
  matchedCount: document.querySelector("#matchedCount"),
  unmatchedCount: document.querySelector("#unmatchedCount"),
  matchedList: document.querySelector("#matchedList"),
  unmatchedList: document.querySelector("#unmatchedList"),
  lastSync: document.querySelector("#lastSync")
};
elements.vehicleMappings = document.querySelector("#vehicleMappings");
elements.saveMappings = document.querySelector("#saveMappings");
elements.vehicleMappingForm = document.querySelector("#vehicleMappingForm");
elements.vehicleIdInput = document.querySelector("#vehicleIdInput");
elements.tagIdInput = document.querySelector("#tagIdInput");
elements.plateInput = document.querySelector("#plateInput");
elements.capturedVehicles = document.querySelector("#capturedVehicles");
elements.savedMappings = document.querySelector("#savedMappings");

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
    return response;
  });
}

function setStatus(message, kind = "good") {
  elements.status.textContent = message;
  elements.status.className = `status${kind === "error" ? " error" : ""}`;
  elements.statusDot.className = `status-dot ${kind}`;
}

function formatMoney(amount) {
  if (!Number.isFinite(amount)) return "Amount unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatTime(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return "Invalid date";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(epochMs));
}

function card(title, detail) {
  const wrapper = document.createElement("article");
  wrapper.className = "result-card";
  const heading = document.createElement("strong");
  const body = document.createElement("p");
  heading.textContent = title;
  body.textContent = detail;
  wrapper.append(heading, body);
  return wrapper;
}

function fillList(container, cards, emptyText) {
  container.replaceChildren(...cards);
  container.classList.toggle("empty", cards.length === 0);
  if (!cards.length) container.textContent = emptyText;
}

function render(state) {
  const trips = state.sources?.turo?.records || [];
  const tolls = state.sources?.ezpass?.records || [];
  const result = state.reconciliation || {
    matched: [], ambiguous: [], unmatchedTolls: [], stats: {}
  };
  const timeZone = state.settings?.timeZone || "America/New_York";

  elements.tripCount.textContent = trips.length;
  elements.tollCount.textContent = tolls.length;
  elements.graceMinutes.value = String(state.settings?.graceMinutes || 0);
  elements.vehicleMappings.value = JSON.stringify({
    tags: state.settings?.vehicleByTag || {}, plates: state.settings?.vehicleByPlate || {}
  }, null, 2);
  elements.capturedVehicles.replaceChildren(...[...new Set(trips.map((trip) => trip.vehicleId))].map((id) => {
    const option = document.createElement("option");
    option.value = id;
    return option;
  }));
  const labels = [];
  for (const [kind, mappings] of [["Tag", state.settings?.vehicleByTag], ["Plate", state.settings?.vehicleByPlate]]) {
    for (const [key, vehicle] of Object.entries(mappings || {})) {
      const label = document.createElement("p");
      label.textContent = `${kind} ${key} → vehicle ${vehicle}`;
      labels.push(label);
    }
  }
  elements.savedMappings.replaceChildren(...labels);
  elements.matchedCount.textContent = result.matched?.length || 0;
  const reviewCount = (result.unmatchedTolls?.length || 0) + (result.ambiguous?.length || 0);
  elements.unmatchedCount.textContent = reviewCount;

  const matchedCards = (result.matched || []).map(({ toll, trip, withinGrace, vehicleConfirmed }) =>
    card(
      `${formatMoney(toll.amount)} · ${toll.plaza}`,
      `${formatTime(toll.timestampMs, timeZone)} → vehicle ${trip.vehicleId}, trip ${trip.id}${withinGrace ? " (grace period)" : ""}${vehicleConfirmed ? "" : " · Confirm vehicle"}`
    )
  );
  fillList(elements.matchedList, matchedCards, "No matches yet.");

  const unmatchedCards = (result.unmatchedTolls || []).map(({ toll, reason }) =>
    card(
      `${formatMoney(toll.amount)} · ${toll.plaza}`,
      `${formatTime(toll.timestampMs, timeZone)} · ${reason === "invalid_timestamp" ? "Missing, invalid, or ambiguous timestamp" : reason === "invalid_or_nonpositive_amount" ? "Amount requires review" : reason === "conflicting_vehicle_mapping" ? "Vehicle mappings conflict" : "No trip in range"}${toll.tagId ? " · tag " + toll.tagId : ""}${toll.plate ? " · plate " + toll.plate : ""}`
    )
  );
  for (const { toll, candidates } of result.ambiguous || []) {
    unmatchedCards.push(
      card(
        `${formatMoney(toll.amount)} · ${toll.plaza}`,
        `${formatTime(toll.timestampMs, timeZone)} · overlaps ${candidates.length} trips`
      )
    );
  }
  fillList(elements.unmatchedList, unmatchedCards, "No unmatched tolls.");

  elements.lastSync.textContent = state.lastSync
    ? `Synced ${new Date(state.lastSync).toLocaleString()}`
    : "Never synced";
}

async function load() {
  try {
    const { state } = await send({ type: "GET_STATE" });
    render(state);
    setStatus("Ready.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

elements.syncButton.addEventListener("click", async () => {
  elements.syncButton.disabled = true;
  setStatus("Waiting up to 20 seconds for completed Turo history and E-ZPass activity…", "busy");
  try {
    const response = await send({ type: "RUN_SYNC" });
    render(response.state);
    const errors = Object.entries(response.collection).filter(([, result]) => !result.ok)
      .map(([source, result]) => `${source}: ${result.error}`);
    const invalidCount = response.state.reconciliation?.invalidTrips?.length || 0;
    const warnings = [...new Set(Object.values(response.collection).map((result) => result.warning).filter(Boolean))];
    setStatus(response.synced
      ? `Loaded records synced. ${warnings.join(" ")}${invalidCount ? ` ${invalidCount} trips have invalid/ambiguous dates and were excluded.` : ""}`
      : `Not refreshed; displaying prior results. ${errors.join(" ")}`, response.synced ? "good" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.syncButton.disabled = false;
  }
});

elements.graceMinutes.addEventListener("change", async () => {
  try {
    const { state } = await send({
      type: "UPDATE_SETTINGS",
      settings: { graceMinutes: Number(elements.graceMinutes.value) }
    });
    render(state);
    setStatus("Grace period updated.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.clearButton.addEventListener("click", async () => {
  try {
    const { state, resetFailures } = await send({ type: "CLEAR_LOCAL_DATA" });
    render(state);
    setStatus(resetFailures ? "Stored data cleared. Reload portal tabs to clear remaining page captures." : "Stored data and page captures cleared.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.saveMappings.addEventListener("click", async () => {
  try {
    const mappings = JSON.parse(elements.vehicleMappings.value);
    const { state } = await send({ type: "UPDATE_SETTINGS", settings: {
      vehicleByTag: mappings.tags || {}, vehicleByPlate: mappings.plates || {}
    } });
    render(state);
    setStatus("Vehicle mappings saved; suggestions recalculated.");
  } catch (error) { setStatus(error.message, "error"); }
});

elements.vehicleMappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const vehicleId = elements.vehicleIdInput.value.trim();
  const tag = elements.tagIdInput.value.trim();
  const plate = elements.plateInput.value.trim();
  if (!vehicleId || (!tag && !plate)) {
    setStatus("Enter a Turo vehicle ID and at least one tag or plate.", "error");
    return;
  }
  try {
    const { state: current } = await send({ type: "GET_STATE" });
    const { state } = await send({ type: "UPDATE_SETTINGS", settings: {
      vehicleByTag: { ...current.settings.vehicleByTag, ...(tag ? { [tag]: vehicleId } : {}) },
      vehicleByPlate: { ...current.settings.vehicleByPlate, ...(plate ? { [plate]: vehicleId } : {}) }
    } });
    render(state);
    elements.vehicleMappingForm.reset();
    setStatus("Vehicle mapping saved. Leading zeros are preserved.");
  } catch (error) { setStatus(error.message, "error"); }
});

load();
