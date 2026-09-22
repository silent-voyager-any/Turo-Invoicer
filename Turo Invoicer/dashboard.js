const ids = [
  "syncButton", "clearButton", "graceMinutes", "status", "statusDot", "tripCount", "tollCount", "draftCount", "selectedTotal",
  "turoCompleteness", "ezpassCompleteness", "coverageStatus", "lastSync", "assignmentForm", "vehicleId", "vehicleLabel", "identifierKind", "identifier",
  "validFrom", "validTo", "vehicleOptions", "assignmentList", "tripsList", "tollReviewList", "tripBlockerList", "batchList", "selectAllButton", "goEvidenceButton",
  "accountIdentifier", "manualIdentifierButton", "manualIdentifierFields", "identifierPreview", "inventoryStatus", "refreshIdentifiersButton",
  "batchTrips", "batchTolls", "batchTotal", "navReviewCount", "navBatchCount", "navVehicles", "navTrips", "navReview", "navBatch", "approveBatchButton",
  "vehiclesView", "tripsView", "reviewView", "batchView", "hiddenVehicleList", "tripDateForm", "tripStartDate", "tripEndDate", "tripDateStatus", "sendBatchButton", "previewBatchButton", "submissionPreview"
];
const el = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));
const views = { vehicles: el.vehiclesView, trips: el.tripsView, review: el.reviewView, batch: el.batchView };
const navs = { vehicles: el.navVehicles, trips: el.navTrips, review: el.navReview, batch: el.navBatch };
let draftTimer;
let activeView = "vehicles";
let latestState = null;
const confirmRemoval = (name, restorable) => globalThis.confirm(
  `Are you sure you want to remove this?\n\n${name}\n\n${restorable ? "You can restore it later." : "This removal cannot be undone."}`);

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
const canonicalIdentifier = (kind, value) => {
  let normalized = String(value || "").trim().toUpperCase();
  if (kind === "plate") normalized = normalized.replace(/^[A-Z]{2}\s*[:|]\s*/, "");
  normalized = normalized.replace(/[^A-Z0-9]/g, "");
  return normalized || null;
};
const reasonLabel = (reason) => ({
  turo_collection_incomplete: "Turo pagination is incomplete",
  ezpass_collection_incomplete: "E-ZPass pagination is incomplete",
  search_incomplete: "E-ZPass search incomplete for this trip; retry sync",
  status_unknown: "Turo toll-invoice status is unverified",
  already_charged: "Turo already shows a toll invoice",
  ineligible: "Trip is not eligible",
  existing_toll_invoice: "An existing Turo invoice already contains tolls",
  standard_window_expired: "Standard 90-day invoice window expired; contact Turo support",
  invoice_view_unverified: "Turo invoice pages could not be verified",
  toll_request_available: "Turo toll request is available",
  no_matching_tolls: "No uniquely vehicle-confirmed tolls",
  no_tolls_selected: "No tolls selected",
  date_range_not_synced: "Date range changed; run Find uncharged trips before batching",
  invalid_timestamp: "Invalid or ambiguous toll timestamp",
  invalid_or_nonpositive_amount: "Invalid toll amount",
  conflicting_vehicle_mapping: "Vehicle assignments conflict",
  identifier_not_mapped: "Identifier is not mapped to a vehicle",
  identifier_unavailable: "Configured tag or plate is not available in E-ZPass; update it on Vehicles",
  mapped_vehicle_no_trip: "Personal/unassigned — no completed trip for this vehicle",
  overlapping_trips: "Overlapping trips require review",
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
  const choice = el.accountIdentifier.value;
  const [kind, identifier] = choice ? choice.split(":") : [el.identifierKind.value, el.identifier.value];
  return { vehicleId: el.vehicleId.value, label: el.vehicleLabel.value, kind, identifier,
    validFrom: el.validFrom.value, validTo: el.validTo.value };
}
function setManualIdentifierMode(manual) {
  el.manualIdentifierFields.hidden = !manual;
  el.identifier.required = manual;
}
function restoreDraft(draft = {}) {
  el.vehicleId.value = draft.vehicleId || ""; el.vehicleLabel.value = draft.label || ""; el.identifierKind.value = draft.kind || "tag";
  el.identifier.value = draft.identifier || ""; el.validFrom.value = draft.validFrom || ""; el.validTo.value = draft.validTo || "";
  const key = draft.identifier ? `${draft.kind || "tag"}:${canonicalIdentifier(draft.kind || "tag", draft.identifier)}` : "";
  const hasInventoryChoice = [...(el.accountIdentifier.children || [])].some((option) => option.value === key);
  el.accountIdentifier.value = hasInventoryChoice ? key : "";
  setManualIdentifierMode(Boolean(draft.identifier && !hasInventoryChoice));
  updateIdentifierPreview();
}
function removeButton(id) {
  const button = element("button", "danger", "Remove"); button.type = "button"; button.dataset.assignmentId = id; return button;
}
function assignmentCard(assignment) {
  const card = element("article", "card"); const row = element("div", "card-row");
  row.append(element("strong", "", `${assignment.kind === "tag" ? "E-ZPass tag" : "Plate"} ${assignment.identifier}`), removeButton(assignment.id));
  card.append(row, element("p", "", `${assignment.validFrom || "Any past date"} through ${assignment.validTo || "Any future date"}`));
  return card;
}
function prefillButton(label, vehicle, kind, value) {
  const button = element("button", "secondary mapping-button", label); button.type = "button";
  button.dataset.mapVehicleId = vehicle.vehicleId; button.dataset.mapVehicleLabel = vehicle.label || "";
  button.dataset.mapKind = kind; button.dataset.mapIdentifier = value; return button;
}
function quickLinkButton(label, vehicle, kind, value) {
  const button = prefillButton(label, vehicle, kind, value);
  button.dataset.quickLink = "true";
  return button;
}
function inventoryRefreshButton(label = "Load E-ZPass list") {
  const button = element("button", "secondary", label); button.type = "button";
  button.dataset.refreshIdentifiers = "true"; return button;
}
function vehicleCard(vehicle, assignments, state) {
  const card = element("article", "card vehicle-card"); const heading = element("div", "card-row");
  const removeVehicle = element("button", "danger", "Remove vehicle");
  removeVehicle.type = "button"; removeVehicle.dataset.vehicleId = vehicle.vehicleId;
  heading.append(element("strong", "", vehicle.label || "Unnamed Turo vehicle"),
    assignments.length ? element("span", "pill ready", "Configured") : element("span", "pill warning", "Mapping needed"), removeVehicle);
  card.append(heading);
  if (vehicle.sourcePlate) {
    const plate = element("div", "source-plate");
    plate.append(element("span", "", `Turo registration: ${vehicle.sourcePlate}`));
    if (vehicle.sourcePlateConfirmed) plate.append(element("span", "pill ready", "Plate linked"));
    else {
      const wanted = canonicalIdentifier("plate", vehicle.sourcePlate);
      const inventory = state.fleet?.identifierInventory?.items || [];
      const available = inventory.find((item) => item.kind === "plate" && item.canonicalIdentifier === wanted);
      if (available) plate.append(quickLinkButton("Link verified plate", vehicle, "plate", available.canonicalIdentifier));
      else if (inventory.length) plate.append(element("span", "pill warning", "Not found in E-ZPass"),
        prefillButton("Review manually", vehicle, "plate", vehicle.sourcePlate));
      else plate.append(inventoryRefreshButton());
    }
    card.append(plate);
  }
  card.append(element("p", "internal-id", `Turo internal vehicle ID: ${vehicle.vehicleId} — not an E-ZPass tag`));
  const list = element("div", "assignment-items");
  list.append(...assignments.map(assignmentCard));
  if (!assignments.length) list.append(element("p", "muted", "No confirmed plate or tag assignments."));
  card.append(list, prefillButton("Add E-ZPass tag", vehicle, "tag", ""));
  return card;
}
function collectionLabel(source, run) {
  const name = source === "turo" ? "Turo" : "E-ZPass";
  const requested = run?.requestedRange || run?.range;
  const observed = run?.observedRange;
  const requestedText = requested?.startDate && requested?.endDate ? ` · requested ${requested.startDate}–${requested.endDate}` : "";
  const observedText = observed?.startDate && observed?.endDate ? ` · observed ${observed.startDate}–${observed.endDate}` : "";
  const lastPage = source === "ezpass" && run?.lastPage ? ` · last page ${run.lastPage}` : "";
  const ranges = source === "ezpass" ? requestedText + observedText : requestedText;
  const completed = source === "ezpass" ? (run?.queryReports || []).filter((report) => report.status === "complete").length : 0;
  const incomplete = source === "ezpass" ? (run?.queryReports || []).filter((report) => report.status === "search_incomplete").length : 0;
  const queries = source === "ezpass" && Array.isArray(run?.queryReports)
    ? ` · ${completed} completed · ${incomplete} search-incomplete` : "";
  return run?.complete ? `${name} complete · ${run.pageCount || 0} pages · ${run.recordCount || 0} records${queries}${lastPage}${ranges}`
    : `${name} incomplete · ${run?.recordCount || 0} loaded${lastPage}${ranges}`;
}
function coverageLabel(runs = {}) {
  const ezpass = runs.ezpass;
  if (!ezpass) return { text: "Trip searches unavailable", warning: true };
  if (ezpass.complete !== true || ezpass.completeForRange !== true) {
    const unavailable = (ezpass.queryReports || []).filter((report) => report.status === "identifier_unavailable").length;
    const incomplete = (ezpass.queryReports || []).filter((report) => report.status === "search_incomplete").length;
    return { text: incomplete ? `${incomplete} trip identifier search${incomplete === 1 ? " is" : "es are"} incomplete; verified trips remain reviewable` : unavailable
      ? `${unavailable} configured tag/plate ${unavailable === 1 ? "assignment is" : "assignments are"} unavailable in E-ZPass; affected trips need review`
      : "One or more trip identifier searches are incomplete", warning: true };
  }
  return Number(ezpass.recordCount) > 0
    ? { text: "All configured trip identifiers searched", warning: false }
    : { text: "All configured trip identifiers searched; no tolls found", warning: false };
}
function checkbox(action, reservationId, checked, disabled, tollId = null) {
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked; input.disabled = disabled;
  input.dataset.action = action; input.dataset.reservationId = reservationId; if (tollId) input.dataset.tollId = tollId; return input;
}
function batchToggle(draft) {
  const button = element("button", draft.selected ? "secondary batch-toggle selected" : "secondary batch-toggle",
    draft.selected ? "Remove from batch" : "Add to batch");
  button.type = "button"; button.disabled = !draft.selectable;
  button.dataset.action = "trip"; button.dataset.reservationId = draft.reservationId;
  button.dataset.selected = String(!draft.selected);
  return button;
}
function tripCard(draft, state) {
  const zone = state.settings?.timeZone || "America/New_York";
  const vehicle = (state.fleet?.vehicles || []).find((item) => String(item.vehicleId) === String(draft.vehicleId));
  const card = element("article", `card trip-card${draft.selectable ? "" : " blocked"}${draft.selected ? " selected" : ""}`);
  const heading = element("div", "trip-heading"); const title = element("div", "trip-title");
  const vehicleTitle = [vehicle?.label || "Unnamed Turo vehicle", vehicle?.sourcePlate].filter(Boolean).join(" · ");
  title.append(element("strong", "", `${vehicleTitle} · Trip ${draft.reservationId}`));
  const tripState = draft.tripApproved ? "Trip approved" : draft.evidenceComplete ? "Ready for approval" : draft.selectable ? "Needs evidence" : reasonLabel(draft.eligibility);
  const actions = element("div", "trip-actions");
  actions.append(element("span", `pill ${draft.selectable ? "ready" : "warning"}`, tripState), batchToggle(draft));
  heading.append(title, actions);
  const dates = element("p", "", `${formatTime(draft.startMs, zone)} — ${formatTime(draft.endMs, zone)}`);
  const tolls = element("div", "tolls");
  for (const toll of draft.tolls || []) {
    const row = element("label", "toll-row"); const left = element("span", "toll-main");
    left.append(checkbox("toll", draft.reservationId, draft.selectedTollIds.includes(toll.id), false, toll.id), element("span", "", `${formatTime(toll.timestampMs, zone)} · ${toll.plaza}`));
    row.append(left, element("strong", "", moneyCents(toll.amountCents)));
    row.append(element("span", "muted", `${identifier(toll)}${toll.withinGrace ? " · grace" : ""}`)); tolls.append(row);
  }
  if (!draft.tolls?.length) tolls.append(element("p", "muted", "No uniquely matched tolls found."));
  const reports = state.collectionRuns?.ezpass?.queryReports || [];
  const tripReports = reports.filter((report) => String(report.reservationId) === String(draft.reservationId) &&
    (!draft.activeQueryIds || draft.activeQueryIds.includes(report.queryId)));
  const unavailableQueries = tripReports.filter((report) => report.status === "identifier_unavailable").length;
  const incompleteQueries = tripReports.filter((report) => report.status === "search_incomplete").length;
  const completedQueries = tripReports.filter((report) => report.complete === true).length;
  const queryText = tripReports.length
    ? `${completedQueries}/${tripReports.length} identifiers searched · ${tripReports.reduce((sum, item) => sum + (item.pageCount || 0), 0)} result pages · ${tripReports.reduce((sum, item) => sum + (item.recordCount || 0), 0)} filtered toll rows · ${draft.tolls.length} matched toll${draft.tolls.length === 1 ? "" : "s"} · ${incompleteQueries} search-incomplete · ${unavailableQueries} unavailable`
    : "No confirmed identifier search completed";
  card.append(heading, element("p", "internal-id", `Turo internal vehicle ID: ${draft.vehicleId} — not an E-ZPass tag`), dates,
    element("p", "muted", queryText), tolls, element("p", "", `${draft.selectedTollIds.length} selected · ${moneyCents(draft.totalCents)} · ${draft.evidenceIds?.length || 0} evidence images`));
  for (const report of tripReports.filter((item) => item.status === "identifier_unavailable")) {
    const assignment = (state.fleet?.assignments || []).find((item) =>
      String(item.vehicleId) === String(draft.vehicleId) && item.kind === report.kind &&
      `${draft.reservationId}:${item.kind}:${item.canonicalIdentifier}` === report.queryId);
    card.append(element("p", "muted", `E-ZPass does not list configured ${report.kind} ${assignment?.identifier || "(assignment unavailable)"}. Update it on Vehicles.`));
  }
  for (const report of tripReports.filter((item) => item.status === "search_incomplete")) {
    card.append(element("p", "muted", `E-ZPass ${report.kind} search incomplete (${report.reason || "unconfirmed results"}). Retry sync; this trip cannot be selected.`));
  }
  if (draft.blockingReasons?.length) {
    const reasons = draft.blockingReasons.map((reason) =>
      reason === draft.eligibility && draft.eligibilityReason ? reasonLabel(draft.eligibilityReason) : reasonLabel(reason));
    card.append(element("p", "muted", reasons.join(" · ")));
    const destination = draft.blockingReasons.includes("identifier_unavailable") ? "vehicles" :
      draft.blockingReasons.includes("no_matching_tolls") ? "review" : "vehicles";
    const action = element("button", "text-button blocker-link", destination === "review" ? "Review unresolved tolls" : "Check vehicle setup");
    action.type = "button"; action.dataset.navigateView = destination; card.append(action);
  }
  return card;
}
function batchCard(draft, state) {
  const card = element("article", "card batch-card");
  const row = element("div", "card-row");
  const approval = checkbox("approve-trip", draft.reservationId, draft.tripApproved, !draft.batchReady);
  const label = element("label", "trip-title"); label.append(approval, element("strong", "", `Trip ${draft.reservationId}`));
  const remove = element("button", "danger", "Remove from batch"); remove.type = "button";
  remove.dataset.removeBatchTrip = draft.reservationId;
  row.append(label, element("span", `pill ${draft.tripApproved ? "ready" : "warning"}`, draft.tripApproved ? "Approved" : draft.batchReady ? "Approval required" : "Evidence incomplete"), remove);
  card.append(row, element("p", "", `${draft.selectedTollIds.length} tolls · ${moneyCents(draft.totalCents)} · revision ${draft.revisionHash}`));
  const evidence = (state.evidence || []).filter((item) => String(item.reservationId) === String(draft.reservationId) && item.status !== "stale" && item.status !== "deleted");
  const gallery = element("div", "evidence-gallery");
  for (const item of evidence) {
    const figure = element("figure", "evidence-item");
    const image = document.createElement("img"); image.alt = `${item.kind} evidence page ${item.pageNumber}`; image.dataset.evidencePreview = item.id;
    const caption = element("figcaption", "muted", `${item.kind} ${item.identifier} · ${item.startDate}–${item.endDate} · ${item.coveredTollIds?.length || 0} tolls`);
    const remove = element("button", "danger", "Remove evidence"); remove.type = "button"; remove.dataset.evidenceId = item.id;
    figure.append(image, caption, remove); gallery.append(figure);
  }
  if (!evidence.length) gallery.append(element("p", "muted", "No evidence captured."));
  card.append(gallery);
  const sendOne = element("button", "secondary", "Send this invoice");
  sendOne.type = "button"; sendOne.disabled = true; sendOne.title = "Turo submission is disabled until the authenticated send flow is verified.";
  const preview = element("button", "secondary", "Review this invoice"); preview.type = "button";
  preview.disabled = !draft.tripApproved; preview.dataset.previewTrip = draft.reservationId;
  card.append(preview, sendOne);
  return card;
}
async function hydrateEvidencePreviews() {
  if (typeof indexedDB === "undefined") return;
  const { getEvidenceBlob } = await import("./evidence_store.js");
  for (const image of document.querySelectorAll("img[data-evidence-preview]")) {
    const blob = await getEvidenceBlob(image.dataset.evidencePreview).catch(() => null);
    if (!blob || !image.isConnected) continue;
    const url = URL.createObjectURL(blob); image.src = url;
    image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
  }
}
function reviewCard(title, detail, actions = []) {
  const card = element("article", "card"); card.append(element("strong", "", title), element("p", "", detail));
  if (actions.length) { const row = element("div", "review-actions"); row.append(...actions); card.append(row); }
  return card;
}
function mappingActions(toll, trip, state) {
  const vehicle = (state.fleet?.vehicles || []).find((item) => String(item.vehicleId) === String(trip.vehicleId)) ||
    { vehicleId: String(trip.vehicleId), label: "" };
  const values = [];
  if (toll.tagId) values.push(["tag", toll.tagId]);
  if (toll.plate) values.push(["plate", toll.plate]);
  if (!values.length && toll.tagOrPlate) values.push(["tag", toll.tagOrPlate], ["plate", toll.tagOrPlate]);
  return values.map(([kind, value]) => prefillButton(
    values.length > 1 ? `Review as ${kind}` : `Review for ${vehicle.label || "this vehicle"}`, vehicle, kind, value
  ));
}

function reviewMappingEditor(button) {
  const data = button.dataset;
  const card = button.parentElement?.parentElement;
  if (!card) return;
  card.querySelector?.(".review-mapping-editor")?.remove();
  const form = element("form", "review-mapping-editor");
  const fields = {};
  for (const [key, title, type, value] of [
    ["identifier", "Tag or plate", "text", data.mapIdentifier || ""],
    ["validFrom", "Effective from (optional)", "date", ""],
    ["validTo", "Effective through (optional)", "date", ""]
  ]) {
    const label = element("label", "", title);
    const input = document.createElement("input"); input.type = type; input.value = value;
    if (key === "identifier") input.required = true;
    fields[key] = input; label.append(input); form.append(label);
  }
  form.append(element("p", "muted", `Link as ${data.mapKind} to ${data.mapVehicleLabel || "this Turo vehicle"}. Verify the identifier and dates before saving.`));
  const feedback = element("p", "review-feedback");
  const save = element("button", "primary", "Save mapping and recalculate"); save.type = "submit";
  const cancel = element("button", "secondary", "Cancel"); cancel.type = "button";
  cancel.addEventListener("click", () => form.remove());
  form.append(feedback, save, cancel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const assignment = { vehicleId: data.mapVehicleId, label: data.mapVehicleLabel || "", kind: data.mapKind,
      identifier: fields.identifier.value, validFrom: fields.validFrom.value, validTo: fields.validTo.value };
    if (!canonicalIdentifier(assignment.kind, assignment.identifier)) {
      feedback.textContent = "Enter a complete tag or plate before saving."; return;
    }
    save.disabled = true;
    try {
      const { state } = await send({ type: "UPSERT_ASSIGNMENT", assignment });
      render(state); setStatus("Mapping saved; unresolved tolls, trips, and Batch recalculated.");
    } catch (error) { feedback.textContent = error.message; save.disabled = false; }
  });
  card.append(form); fields.identifier.focus?.();
}

function renderIdentifierInventory(state) {
  const inventory = state.fleet?.identifierInventory || { items: [], updatedAt: null };
  const placeholder = document.createElement("option"); placeholder.value = "";
  placeholder.textContent = inventory.items?.length ? "Choose a verified tag or plate" : "Refresh the E-ZPass list first";
  const options = (inventory.items || []).map((item) => {
    const option = document.createElement("option");
    option.value = `${item.kind}:${item.canonicalIdentifier}`;
    option.textContent = `${item.kind === "tag" ? "Tag" : "Plate"} · ${item.identifier}`;
    option.dataset.kind = item.kind; option.dataset.identifier = item.canonicalIdentifier;
    return option;
  });
  el.accountIdentifier.replaceChildren(placeholder, ...options);
  el.inventoryStatus.textContent = inventory.updatedAt
    ? `${options.length} verified identifier${options.length === 1 ? "" : "s"} loaded ${new Date(inventory.updatedAt).toLocaleString()}.`
    : "E-ZPass identifiers have not been loaded.";
}

function render(state, { restore = false } = {}) {
  const formDraft = restore ? state.uiDrafts?.vehicleAssignment : draftValue();
  latestState = state;
  const trips = state.sources?.turo?.records || [], tolls = state.sources?.ezpass?.records || [], drafts = state.invoiceDrafts || [];
  const summary = state.selectionSummary || { tripCount: 0, tollCount: 0, totalCents: 0 };
  el.tripCount.textContent = trips.length; el.tollCount.textContent = tolls.length; el.draftCount.textContent = drafts.length; el.selectedTotal.textContent = moneyCents(summary.totalCents);
  el.batchTrips.textContent = `${summary.tripCount} trips`; el.batchTolls.textContent = `${summary.tollCount} tolls`; el.batchTotal.textContent = moneyCents(summary.totalCents);
  el.navBatchCount.textContent = summary.tripCount; el.graceMinutes.value = String(state.settings?.graceMinutes || 0);
  const range = state.settings?.tripDateRange || {};
  el.tripStartDate.value = range.startDate || ""; el.tripEndDate.value = range.endDate || "";
  el.tripDateStatus.textContent = state.dateRangeNeedsSync ? "Date range changed — refresh required" : range.startDate || range.endDate
    ? `Trip end ${range.startDate || "any date"} through ${range.endDate || "any date"}` : "All completed trips";
  el.lastSync.textContent = state.lastSync ? `Synced ${new Date(state.lastSync).toLocaleString()}` : "Never synced";
  for (const [source, target] of [["turo", el.turoCompleteness], ["ezpass", el.ezpassCompleteness]]) {
    const run = state.collectionRuns?.[source]; target.textContent = collectionLabel(source, run); target.className = run?.complete ? "complete" : "incomplete";
  }
  const coverage = coverageLabel(state.collectionRuns);
  el.coverageStatus.textContent = coverage.text;
  el.coverageStatus.className = coverage.warning ? "incomplete" : "complete";
  renderIdentifierInventory(state);
  const hidden = new Set(state.fleet?.hiddenVehicleIds || []);
  el.vehicleOptions.replaceChildren(...(state.fleet?.vehicles || []).filter((vehicle) => !hidden.has(String(vehicle.vehicleId))).map((vehicle) => { const option = document.createElement("option"); option.value = vehicle.vehicleId; option.label = [vehicle.label || vehicle.vehicleId, vehicle.sourcePlate].filter(Boolean).join(" · "); return option; }));
  fill(el.assignmentList, (state.fleet?.vehicles || []).filter((vehicle) => !hidden.has(String(vehicle.vehicleId))).map((vehicle) => vehicleCard(vehicle,
    (state.fleet?.assignments || []).filter((assignment) => String(assignment.vehicleId) === String(vehicle.vehicleId)), state)), "Sync Turo history to discover vehicles.");
  fill(el.hiddenVehicleList, (state.fleet?.vehicles || []).filter((vehicle) => hidden.has(String(vehicle.vehicleId))).map((vehicle) => {
    const card = element("article", "card card-row");
    const restore = element("button", "secondary", "Restore vehicle"); restore.type = "button"; restore.dataset.restoreVehicleId = vehicle.vehicleId;
    card.append(element("strong", "", vehicle.label || vehicle.sourcePlate || vehicle.vehicleId), restore); return card;
  }), "No removed vehicles.");
  fill(el.tripsList, drafts.map((draft) => tripCard(draft, state)), "No completed trips loaded yet.");

  const tripBlockers = drafts.filter((item) => !item.selectable).map((draft) => {
    const vehicle = (state.fleet?.vehicles || []).find((item) => String(item.vehicleId) === String(draft.vehicleId));
    const reasons = draft.blockingReasons.map((reason) =>
      reason === draft.eligibility && draft.eligibilityReason ? reasonLabel(draft.eligibilityReason) : reasonLabel(reason));
    const unavailable = (state.collectionRuns?.ezpass?.queryReports || []).filter((report) =>
      String(report.reservationId) === String(draft.reservationId) && report.status === "identifier_unavailable" &&
      (!draft.activeQueryIds || draft.activeQueryIds.includes(report.queryId)));
    const identifiers = unavailable.map((report) => (state.fleet?.assignments || []).find((assignment) =>
      String(assignment.vehicleId) === String(draft.vehicleId) &&
      `${draft.reservationId}:${assignment.kind}:${assignment.canonicalIdentifier}` === report.queryId))
      .filter(Boolean).map((assignment) => `${assignment.kind} ${assignment.identifier}`);
    return reviewCard(`Trip ${draft.reservationId} · ${vehicle?.label || "Turo vehicle"}`,
      [reasons.join(" · "), identifiers.length ? `Unavailable in E-ZPass: ${identifiers.join(", ")}` : ""].filter(Boolean).join(" · "));
  });
  fill(el.tripBlockerList, tripBlockers, "No trip or source blockers.");
  const tollReview = new Map();
  const addIssue = (toll, detail, actions = []) => {
    const key = toll.id || JSON.stringify([toll.timestampMs, toll.plaza, toll.amountCents, identifier(toll)]);
    if (!tollReview.has(key)) tollReview.set(key, reviewCard(`${moneyCents(toll.amountCents)} · ${toll.plaza}`,
      `${identifier(toll)} · ${formatTime(toll.timestampMs, state.settings?.timeZone)} · ${detail}`, actions));
  };
  for (const issue of state.reconciliation?.unmatchedTolls || []) {
    const { toll, reason, candidates = [], mappedVehicleId } = issue;
    const vehicle = (state.fleet?.vehicles || []).find((item) => String(item.vehicleId) === String(mappedVehicleId));
    const mappedDetail = mappedVehicleId ? ` · Vehicle: ${vehicle?.label || vehicle?.sourcePlate || mappedVehicleId}` : "";
    const actions = reason === "identifier_not_mapped" && candidates.length === 1
      ? mappingActions(toll, candidates[0], state) : [];
    addIssue(toll, `${reasonLabel(reason)}${mappedDetail}`, actions);
  }
  for (const match of (state.reconciliation?.matched || []).filter((item) => !item.vehicleConfirmed)) {
    addIssue(match.toll, "Time matches one trip, but this identifier is not mapped to its vehicle", mappingActions(match.toll, match.trip, state));
  }
  for (const { toll, candidates } of state.reconciliation?.ambiguous || []) addIssue(toll, `Overlaps ${candidates.length} trips`);
  fill(el.tollReviewList, [...tollReview.values()], "No unresolved tolls."); el.navReviewCount.textContent = tollReview.size;
  fill(el.batchList, drafts.filter((draft) => draft.selected).map((draft) => batchCard(draft, state)), "No trips selected.");
  el.goEvidenceButton.disabled = summary.tripCount === 0;
  const selectedDrafts = drafts.filter((draft) => draft.selected);
  el.approveBatchButton.disabled = !selectedDrafts.length || selectedDrafts.some((draft) => !draft.tripApproved || !draft.batchReady);
  el.sendBatchButton.disabled = true;
  el.previewBatchButton.disabled = !selectedDrafts.length || selectedDrafts.some((draft) => !draft.tripApproved || !draft.batchReady);
  el.submissionPreview.replaceChildren();
  hydrateEvidencePreviews();
  restoreDraft(formDraft);
}
function updateIdentifierPreview() {
  const canonical = canonicalIdentifier(el.identifierKind.value, el.identifier.value);
  el.identifierPreview.textContent = canonical
    ? `Exact value used for matching: ${canonical}${el.identifierKind.value === "tag" ? " (leading zeros preserved)" : ""}`
    : "Manual values must contain letters or numbers and exactly identify an E-ZPass tag or plate.";
}
function openAssignmentEditor(draft) {
  restoreDraft(draft); showView("vehicles");
  setManualIdentifierMode(!el.accountIdentifier.value);
  el.assignmentForm?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  (el.accountIdentifier.value ? el.validFrom : el.identifier)?.focus?.();
}
function scheduleDraftSave() { clearTimeout(draftTimer); updateIdentifierPreview(); draftTimer = setTimeout(() => send({ type: "SAVE_UI_DRAFT", draft: draftValue() }).catch((error) => setStatus(error.message, "error")), 250); }
for (const input of [el.vehicleId, el.vehicleLabel, el.identifierKind, el.identifier, el.validFrom, el.validTo]) input.addEventListener("input", scheduleDraftSave);
el.accountIdentifier.addEventListener("change", () => {
  if (!el.accountIdentifier.value) { setManualIdentifierMode(false); scheduleDraftSave(); return; }
  const [kind, value] = el.accountIdentifier.value.split(":");
  el.identifierKind.value = kind; el.identifier.value = value;
  setManualIdentifierMode(false); scheduleDraftSave();
});
el.manualIdentifierButton.addEventListener("click", () => {
  el.accountIdentifier.value = ""; setManualIdentifierMode(true); updateIdentifierPreview(); el.identifier?.focus?.();
});
for (const [name, nav] of Object.entries(navs)) nav.addEventListener("click", () => showView(name));
el.assignmentForm.addEventListener("submit", async (event) => { event.preventDefault(); clearTimeout(draftTimer); try {
  const assignment = draftValue();
  if (!assignment.identifier || !canonicalIdentifier(assignment.kind, assignment.identifier)) {
    throw new Error("Choose an E-ZPass identifier or open manual entry and enter a complete tag or plate.");
  }
  const { state } = await send({ type: "UPSERT_ASSIGNMENT", assignment }); render(state); restoreDraft({}); showView("vehicles");
  setStatus("Vehicle assignment saved; trip matches recalculated.");
} catch (error) { setStatus(error.message, "error"); } });
async function handleMappingPrefill(event) {
  const data = event.target?.dataset || {};
  if (!data.mapVehicleId) return false;
  const draft = { vehicleId: data.mapVehicleId, label: data.mapVehicleLabel || "", kind: data.mapKind || "tag", identifier: data.mapIdentifier || "", validFrom: "", validTo: "" };
  if (data.quickLink === "true") {
    try {
      const { state } = await send({ type: "UPSERT_ASSIGNMENT", assignment: draft });
      render(state); restoreDraft({}); setStatus(`${draft.kind === "tag" ? "E-ZPass tag" : "Plate"} linked; trips and unresolved tolls recalculated.`);
    } catch (error) {
      const card = event.target?.closest?.(".vehicle-card");
      if (card) {
        card.querySelector?.(".mapping-feedback")?.remove();
        card.append(element("p", "mapping-feedback", error.message));
      }
      setStatus(error.message, "error");
    }
    return true;
  }
  openAssignmentEditor(draft);
  try { await send({ type: "SAVE_UI_DRAFT", draft }); setStatus("Mapping prefilled. Review the identifier and dates, then save it."); }
  catch (error) { setStatus(error.message, "error"); }
  return true;
}
el.assignmentList.addEventListener("click", async (event) => {
  if (event.target?.dataset?.refreshIdentifiers === "true") { await refreshIdentifierInventory(); return; }
  if (await handleMappingPrefill(event)) return;
  const vehicleId = event.target?.dataset?.vehicleId;
  if (vehicleId) {
    const vehicle = latestState.fleet.vehicles.find((item) => String(item.vehicleId) === vehicleId);
    if (!confirmRemoval(`Vehicle ${vehicle?.label || vehicleId} and its trips from this workspace`, true)) return;
    try { const { state } = await send({ type: "HIDE_VEHICLE", vehicleId }); render(state); setStatus("Vehicle removed from the workspace. Its synced records and mappings are retained."); }
    catch (error) { setStatus(error.message, "error"); }
    return;
  }
  const id = event.target?.dataset?.assignmentId; if (!id) return;
  const assignment = latestState.fleet.assignments.find((item) => item.id === id);
  if (!confirmRemoval(`${assignment?.kind || "Identifier"} ${assignment?.identifier || id} assignment`, false)) return;
  try { const { state } = await send({ type: "DELETE_ASSIGNMENT", id }); render(state); setStatus("Assignment removed."); }
  catch (error) { setStatus(error.message, "error"); }
});
el.hiddenVehicleList.addEventListener("click", async (event) => {
  const vehicleId = event.target?.dataset?.restoreVehicleId; if (!vehicleId) return;
  try { const { state } = await send({ type: "RESTORE_VEHICLE", vehicleId }); render(state); setStatus("Vehicle restored; trips and Batch recalculated."); }
  catch (error) { setStatus(error.message, "error"); }
});
el.tollReviewList.addEventListener("click", (event) => {
  if (event.target?.dataset?.mapVehicleId) reviewMappingEditor(event.target);
});
el.tripsList.addEventListener("change", async (event) => { if (event.target?.dataset?.action !== "toll") return; try { const { state } = await send({ type: "SET_TOLL_SELECTION", reservationId: event.target.dataset.reservationId, tollId: event.target.dataset.tollId, selected: event.target.checked }); render(state); } catch (error) { setStatus(error.message, "error"); } });
el.tripsList.addEventListener("click", async (event) => {
  if (event.target?.dataset?.navigateView) { showView(event.target.dataset.navigateView); return; }
  if (event.target?.dataset?.action !== "trip") return;
  if (event.target.dataset.selected !== "true" && !confirmRemoval(`Trip ${event.target.dataset.reservationId} from Batch`, true)) return;
  try { const { state } = await send({ type: "SET_TRIP_SELECTION", reservationId: event.target.dataset.reservationId,
    selected: event.target.dataset.selected === "true" }); render(state); setStatus(event.target.dataset.selected === "true" ? "Trip added to Batch." : "Trip removed from Batch."); }
  catch (error) { setStatus(error.message, "error"); }
});
el.selectAllButton.addEventListener("click", async () => { try { const { state } = await send({ type: "SELECT_ALL_READY", selected: true }); render(state); setStatus("All ready trips restored to Batch."); } catch (error) { setStatus(error.message, "error"); } });
el.graceMinutes.addEventListener("change", async () => { try { const { state } = await send({ type: "UPDATE_SETTINGS", settings: { graceMinutes: Number(el.graceMinutes.value) } }); render(state); setStatus("Grace period updated; selections were revalidated."); } catch (error) { setStatus(error.message, "error"); } });
el.tripDateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { state } = await send({ type: "UPDATE_SETTINGS", settings: { tripDateRange: {
      startDate: el.tripStartDate.value, endDate: el.tripEndDate.value
    } } });
    render(state); setStatus("Date range applied. Use Find uncharged trips to refresh this range.");
  } catch (error) { setStatus(error.message, "error"); }
});
async function refreshIdentifierInventory() {
  el.refreshIdentifiersButton.disabled = true; setStatus("Loading the exact tag and plate list from E-ZPass…", "busy");
  try { const { state, inventory } = await send({ type: "REFRESH_EZPASS_IDENTIFIERS" }); render(state, { restore: true });
    setStatus(`${inventory.items.length} E-ZPass identifier${inventory.items.length === 1 ? "" : "s"} loaded. Synced trips and tolls were not changed.`); }
  catch (error) { setStatus(error.message, "error"); }
  finally { el.refreshIdentifiersButton.disabled = false; }
}
el.refreshIdentifiersButton.addEventListener("click", refreshIdentifierInventory);
el.syncButton.addEventListener("click", async () => { el.syncButton.disabled = true; setStatus("Collecting signed-in portal records…", "busy"); try { const response = await send({ type: "RUN_SYNC" }); render(response.state); showView(response.state.fleet?.assignments?.length ? "trips" : "vehicles"); const errors = Object.entries(response.collection).filter(([, value]) => !value.ok).map(([key, value]) => `${key}: ${value.error}`); const partial = response.synced && response.state.collectionRuns?.ezpass?.complete === false; setStatus(partial ? "Partial sync saved. Search-incomplete trips are blocked; completed trips remain reviewable." : response.synced ? "Loaded records. Review completeness and invoice-status blockers." : `Not refreshed; prior results retained. ${errors.join(" ")}`, partial ? "error" : response.synced ? "good" : "error"); } catch (error) { setStatus(error.message, "error"); } finally { el.syncButton.disabled = false; } });
el.goEvidenceButton.addEventListener("click", async () => {
  try { await send({ type: "OPEN_EZPASS_EVIDENCE" }); setStatus("E-ZPass is open. Click the extension toolbar icon, then Prepare evidence.", "busy"); }
  catch (error) { setStatus(error.message, "error"); }
});
el.batchList.addEventListener("change", async (event) => {
  if (event.target?.dataset?.action !== "approve-trip") return;
  try {
    const { state } = await send({ type: "SET_TRIP_APPROVAL", reservationId: event.target.dataset.reservationId, approved: event.target.checked });
    render(state); setStatus(event.target.checked ? "Trip approved." : "Trip approval removed.");
  } catch (error) { setStatus(error.message, "error"); }
});
el.batchList.addEventListener("click", async (event) => {
  const previewTrip = event.target?.dataset?.previewTrip;
  if (previewTrip) { await showSubmissionPreview(previewTrip); return; }
  const reservationId = event.target?.dataset?.removeBatchTrip;
  if (reservationId) {
    if (!confirmRemoval(`Trip ${reservationId} from Batch`, true)) return;
    try { const { state } = await send({ type: "SET_TRIP_SELECTION", reservationId, selected: false }); render(state); setStatus(`Trip ${reservationId} removed from Batch. Restore it on Trips.`); }
    catch (error) { setStatus(error.message, "error"); }
    return;
  }
  const id = event.target?.dataset?.evidenceId; if (!id) return;
  if (!confirmRemoval(`Evidence image ${id}`, false)) return;
  try { const { state } = await send({ type: "DELETE_EVIDENCE", id }); render(state); setStatus("Evidence removed; approvals were invalidated."); }
  catch (error) { setStatus(error.message, "error"); }
});
async function showSubmissionPreview(reservationId = null) {
  try {
    const { preview } = await send({ type: "PREVIEW_SUBMISSION", reservationId });
    const cards = preview.map((item) => {
      const card = element("article", "card");
      card.append(element("strong", "", `Trip ${item.reservationId} · ${moneyCents(item.totalCents)}`),
        element("p", "", `${item.tolls.length} selected tolls · ${item.evidenceIds.length} evidence images`));
      for (const toll of item.tolls) card.append(element("p", "", `${toll.plaza || "Toll"} · ${moneyCents(toll.amountCents)} · ${formatTime(toll.timestampMs, latestState.settings?.timeZone)}`));
      return card;
    });
    el.submissionPreview.replaceChildren(...cards);
    setStatus("Submission details displayed for review. Sending remains disabled until the Turo adapter is verified.");
  } catch (error) { setStatus(error.message, "error"); }
}
el.previewBatchButton.addEventListener("click", () => showSubmissionPreview());
el.approveBatchButton.addEventListener("click", async () => {
  try { const { state } = await send({ type: "APPROVE_BATCH" }); render(state); setStatus("The unchanged batch is approved locally."); }
  catch (error) { setStatus(error.message, "error"); }
});
el.clearButton.addEventListener("click", async () => { if (!confirmRemoval("All local trips, tolls, mappings, drafts, and evidence", false)) return; try { const { state } = await send({ type: "CLEAR_LOCAL_DATA" }); render(state, { restore: true }); showView("vehicles"); setStatus("Local records, fleet assignments, and drafts cleared."); } catch (error) { setStatus(error.message, "error"); } });
send({ type: "GET_STATE" }).then(({ state }) => { render(state, { restore: true }); showView(state.fleet?.assignments?.length ? "trips" : "vehicles"); setStatus("Ready."); }).catch((error) => setStatus(error.message, "error"));
