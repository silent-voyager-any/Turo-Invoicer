const ids = [
  "syncButton", "clearButton", "graceMinutes", "status", "statusDot", "tripCount", "tollCount", "draftCount", "selectedTotal",
  "turoCompleteness", "ezpassCompleteness", "lastSync", "assignmentForm", "vehicleId", "vehicleLabel", "identifierKind", "identifier",
  "validFrom", "validTo", "vehicleOptions", "assignmentList", "tripsList", "reviewList", "batchList", "selectAllButton", "prepareButton",
  "batchTrips", "batchTolls", "batchTotal", "navReviewCount", "navBatchCount", "navVehicles", "navTrips", "navReview", "navBatch",
  "vehiclesView", "tripsView", "reviewView", "batchView"
];
const el = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));
const views = { vehicles: el.vehiclesView, trips: el.tripsView, review: el.reviewView, batch: el.batchView };
const navs = { vehicles: el.navVehicles, trips: el.navTrips, review: el.navReview, batch: el.navBatch };
let draftTimer;
let activeView = "vehicles";

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
    return response;
  });
}
function setStatus(message, kind = "good") {
  el.status.textContent = message;
  el.status.className = `status${kind === "error" ? " error" : ""}`;
  el.statusDot.className = `status-dot ${kind}`;
}
const moneyCents = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);
const formatTime = (epoch, zone) => Number.isFinite(epoch)
  ? new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(epoch)) : "Invalid date";
const identifier = (toll) => toll.tagId || toll.plate || toll.tagOrPlate || "Identifier unavailable";
const reasonLabel = (reason) => ({
  turo_collection_incomplete: "Turo pagination is incomplete",
  ezpass_collection_incomplete: "E-ZPass pagination is incomplete",
  status_unknown: "Turo toll-invoice status is unverified",
  already_charged: "Turo already shows a toll invoice",
  ineligible: "Trip is not eligible",
  no_matching_tolls: "No uniquely vehicle-confirmed tolls",
  no_tolls_selected: "No tolls selected",
  invalid_timestamp: "Invalid or ambiguous toll timestamp",
  invalid_or_nonpositive_amount: "Invalid toll amount",
  conflicting_vehicle_mapping: "Vehicle assignments conflict",
  no_trip_in_time_range: "No trip in range"
}[reason] || String(reason || "Requires review").replaceAll("_", " "));

function element(name, className, value) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}
function fill(container, nodes, empty) {
  container.replaceChildren(...nodes);
  container.classList.toggle("empty", !nodes.length);
  if (!nodes.length) container.textContent = empty;
}
function showView(name) {
  activeView = views[name] ? name : "vehicles";
  for (const [key, view] of Object.entries(views)) view.hidden = key !== activeView;
  for (const [key, nav] of Object.entries(navs)) nav.classList.toggle("active", key === activeView);
}
function draftValue() {
  return { vehicleId: el.vehicleId.value, label: el.vehicleLabel.value, kind: el.identifierKind.value, identifier: el.identifier.value, validFrom: el.validFrom.value, validTo: el.validTo.value };
}
function restoreDraft(draft = {}) {
  el.vehicleId.value = draft.vehicleId || ""; el.vehicleLabel.value = draft.label || ""; el.identifierKind.value = draft.kind || "tag";
  el.identifier.value = draft.identifier || ""; el.validFrom.value = draft.validFrom || ""; el.validTo.value = draft.validTo || "";
}
function removeButton(id) {
  const button = element("button", "danger", "Remove"); button.type = "button"; button.dataset.assignmentId = id; return button;
}
function assignmentCard(assignment) {
  const card = element("article", "card"); const row = element("div", "card-row");
  row.append(element("strong", "", `${assignment.label || `Vehicle ${assignment.vehicleId}`} · ${assignment.kind} ${assignment.identifier}`), removeButton(assignment.id));
  card.append(row, element("p", "", `${assignment.validFrom || "Any past date"} through ${assignment.validTo || "Any future date"} · Turo vehicle ${assignment.vehicleId}`));
  return card;
}
function collectionLabel(source, run) {
  const name = source === "turo" ? "Turo" : "E-ZPass";
  return run?.complete ? `${name} complete · ${run.pageCount || 0} pages · ${run.recordCount || 0} records`
    : `${name} incomplete · ${run?.recordCount || 0} loaded`;
}
function checkbox(action, reservationId, checked, disabled, tollId = null) {
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked; input.disabled = disabled;
  input.dataset.action = action; input.dataset.reservationId = reservationId; if (tollId) input.dataset.tollId = tollId; return input;
}
function tripCard(draft, state) {
  const zone = state.settings?.timeZone || "America/New_York";
  const vehicle = (state.fleet?.vehicles || []).find((item) => String(item.vehicleId) === String(draft.vehicleId));
  const card = element("article", `card trip-card${draft.selectable ? "" : " blocked"}${draft.selected ? " selected" : ""}`);
  const heading = element("div", "trip-heading"); const title = element("div", "trip-title");
  title.append(checkbox("trip", draft.reservationId, draft.selected, !draft.selectable), element("strong", "", `${vehicle?.label || `Vehicle ${draft.vehicleId}`} · Trip ${draft.reservationId}`));
  heading.append(title, element("span", `pill ${draft.selectable ? "ready" : "warning"}`, draft.selectable ? "Ready for evidence" : reasonLabel(draft.eligibility)));
  const dates = element("p", "", `${formatTime(draft.startMs, zone)} — ${formatTime(draft.endMs, zone)}`);
  const tolls = element("div", "tolls");
  for (const toll of draft.tolls || []) {
    const row = element("label", "toll-row"); const left = element("span", "toll-main");
    left.append(checkbox("toll", draft.reservationId, draft.selectedTollIds.includes(toll.id), false, toll.id), element("span", "", `${formatTime(toll.timestampMs, zone)} · ${toll.plaza}`));
    row.append(left, element("strong", "", moneyCents(toll.amountCents)));
    row.append(element("span", "muted", `${identifier(toll)}${toll.withinGrace ? " · grace" : ""}`)); tolls.append(row);
  }
  if (!draft.tolls?.length) tolls.append(element("p", "muted", "No uniquely matched tolls found."));
  card.append(heading, dates, tolls, element("p", "", `${draft.selectedTollIds.length} selected · ${moneyCents(draft.totalCents)}`));
  if (draft.blockingReasons?.length) card.append(element("p", "muted", draft.blockingReasons.map(reasonLabel).join(" · ")));
  return card;
}
function reviewCard(title, detail) { const card = element("article", "card"); card.append(element("strong", "", title), element("p", "", detail)); return card; }

function render(state, { restore = false } = {}) {
  const trips = state.sources?.turo?.records || [], tolls = state.sources?.ezpass?.records || [], drafts = state.invoiceDrafts || [];
  const summary = state.selectionSummary || { tripCount: 0, tollCount: 0, totalCents: 0 };
  el.tripCount.textContent = trips.length; el.tollCount.textContent = tolls.length; el.draftCount.textContent = drafts.length; el.selectedTotal.textContent = moneyCents(summary.totalCents);
  el.batchTrips.textContent = `${summary.tripCount} trips`; el.batchTolls.textContent = `${summary.tollCount} tolls`; el.batchTotal.textContent = moneyCents(summary.totalCents);
  el.navBatchCount.textContent = summary.tripCount; el.graceMinutes.value = String(state.settings?.graceMinutes || 0);
  el.lastSync.textContent = state.lastSync ? `Synced ${new Date(state.lastSync).toLocaleString()}` : "Never synced";
  for (const [source, target] of [["turo", el.turoCompleteness], ["ezpass", el.ezpassCompleteness]]) {
    const run = state.collectionRuns?.[source]; target.textContent = collectionLabel(source, run); target.className = run?.complete ? "complete" : "incomplete";
  }
  el.vehicleOptions.replaceChildren(...(state.fleet?.vehicles || []).map((vehicle) => { const option = document.createElement("option"); option.value = vehicle.vehicleId; option.label = [vehicle.label || vehicle.vehicleId, vehicle.sourcePlate].filter(Boolean).join(" · "); return option; }));
  fill(el.assignmentList, (state.fleet?.assignments || []).map(assignmentCard), "No vehicle assignments yet.");
  fill(el.tripsList, drafts.map((draft) => tripCard(draft, state)), "No completed trips loaded yet.");

  const review = [];
  for (const draft of drafts.filter((item) => !item.selectable)) review.push(reviewCard(`Trip ${draft.reservationId} · vehicle ${draft.vehicleId}`, draft.blockingReasons.map(reasonLabel).join(" · ")));
  for (const { toll, reason } of state.reconciliation?.unmatchedTolls || []) review.push(reviewCard(`${moneyCents(toll.amountCents)} · ${toll.plaza}`, `${formatTime(toll.timestampMs, state.settings?.timeZone)} · ${reasonLabel(reason)}`));
  for (const match of (state.reconciliation?.matched || []).filter((item) => !item.vehicleConfirmed)) review.push(reviewCard(`${moneyCents(match.toll.amountCents)} · ${match.toll.plaza}`, "Time-only suggestion · configure the matching tag or plate before invoicing"));
  for (const { toll, candidates } of state.reconciliation?.ambiguous || []) review.push(reviewCard(`${moneyCents(toll.amountCents)} · ${toll.plaza}`, `Overlaps ${candidates.length} trips`));
  fill(el.reviewList, review, "Nothing needs review."); el.navReviewCount.textContent = review.length;
  fill(el.batchList, drafts.filter((draft) => draft.selected).map((draft) => reviewCard(`Trip ${draft.reservationId}`, `${draft.selectedTollIds.length} tolls · ${moneyCents(draft.totalCents)}`)), "No trips selected.");
  el.prepareButton.disabled = summary.tripCount === 0;
  if (restore) restoreDraft(state.uiDrafts?.vehicleAssignment);
}
function scheduleDraftSave() { clearTimeout(draftTimer); draftTimer = setTimeout(() => send({ type: "SAVE_UI_DRAFT", draft: draftValue() }).catch((error) => setStatus(error.message, "error")), 250); }
for (const input of [el.vehicleId, el.vehicleLabel, el.identifierKind, el.identifier, el.validFrom, el.validTo]) input.addEventListener("input", scheduleDraftSave);
for (const [name, nav] of Object.entries(navs)) nav.addEventListener("click", () => showView(name));
el.assignmentForm.addEventListener("submit", async (event) => { event.preventDefault(); clearTimeout(draftTimer); try { const { state } = await send({ type: "UPSERT_ASSIGNMENT", assignment: draftValue() }); render(state); restoreDraft({}); showView("vehicles"); setStatus("Vehicle assignment saved; trip matches recalculated."); } catch (error) { setStatus(error.message, "error"); } });
el.assignmentList.addEventListener("click", async (event) => { const id = event.target?.dataset?.assignmentId; if (!id) return; try { const { state } = await send({ type: "DELETE_ASSIGNMENT", id }); render(state); setStatus("Assignment removed."); } catch (error) { setStatus(error.message, "error"); } });
el.tripsList.addEventListener("change", async (event) => { const action = event.target?.dataset?.action; if (!action) return; try { const message = action === "trip" ? { type: "SET_TRIP_SELECTION", reservationId: event.target.dataset.reservationId, selected: event.target.checked } : { type: "SET_TOLL_SELECTION", reservationId: event.target.dataset.reservationId, tollId: event.target.dataset.tollId, selected: event.target.checked }; const { state } = await send(message); render(state); } catch (error) { setStatus(error.message, "error"); } });
el.selectAllButton.addEventListener("click", async () => { try { const { state } = await send({ type: "SELECT_ALL_READY", selected: true }); render(state); setStatus("All ready trips selected."); } catch (error) { setStatus(error.message, "error"); } });
el.graceMinutes.addEventListener("change", async () => { try { const { state } = await send({ type: "UPDATE_SETTINGS", settings: { graceMinutes: Number(el.graceMinutes.value) } }); render(state); setStatus("Grace period updated; selections were revalidated."); } catch (error) { setStatus(error.message, "error"); } });
el.syncButton.addEventListener("click", async () => { el.syncButton.disabled = true; setStatus("Collecting signed-in portal records…", "busy"); try { const response = await send({ type: "RUN_SYNC" }); render(response.state); showView(response.state.fleet?.assignments?.length ? "trips" : "vehicles"); const errors = Object.entries(response.collection).filter(([, value]) => !value.ok).map(([key, value]) => `${key}: ${value.error}`); setStatus(response.synced ? "Loaded records. Review completeness and invoice-status blockers." : `Not refreshed; prior results retained. ${errors.join(" ")}`, response.synced ? "good" : "error"); } catch (error) { setStatus(error.message, "error"); } finally { el.syncButton.disabled = false; } });
el.prepareButton.addEventListener("click", async () => { try { await send({ type: "PREPARE_BATCH" }); } catch (error) { setStatus(error.message, "error"); } });
el.clearButton.addEventListener("click", async () => { try { const { state } = await send({ type: "CLEAR_LOCAL_DATA" }); render(state, { restore: true }); showView("vehicles"); setStatus("Local records, fleet assignments, and drafts cleared."); } catch (error) { setStatus(error.message, "error"); } });
send({ type: "GET_STATE" }).then(({ state }) => { render(state, { restore: true }); showView(state.fleet?.assignments?.length ? "trips" : "vehicles"); setStatus("Ready."); }).catch((error) => setStatus(error.message, "error"));
