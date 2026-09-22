import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function node() {
  return {
    value: "", textContent: "", className: "", disabled: false, hidden: false, label: "", dataset: {}, children: [], listeners: {}, classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
    querySelector(selector) { return descendants(this).find((item) => selector === ".review-mapping-editor" && item.className === "review-mapping-editor") || null; },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this); },
    focus() {}, scrollIntoView() {}
  };
}

async function dashboard({ confirmRemoval = true, withRemovables = false, withPageReport = false } = {}) {
  const elements = new Map();
  const document = { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); }, createElement: node };
  let state = {
    version: 6, sources: { turo: { records: [{ id: "trip", vehicleId: "car1" }] }, ezpass: { records: [{ id: "toll" }] } },
    settings: { timeZone: "America/New_York", graceMinutes: 0 }, fleet: {
      vehicles: [{ vehicleId: "car1", label: "Car one", sourcePlate: "NY:ABC-123", sourcePlateConfirmed: false }], assignments: [],
      identifierInventory: { items: [{ kind: "plate", identifier: "License plate NY ABC-123", canonicalIdentifier: "ABC123" },
        { kind: "tag", identifier: "Tag # 001", canonicalIdentifier: "001" }], updatedAt: "2026-01-01T00:00:00.000Z" }
    },
    uiDrafts: { vehicleAssignment: { vehicleId: "car1", label: "Car one", kind: "tag", identifier: "001" } },
    collectionRuns: {
      turo: { complete: true, pageCount: 1, recordCount: 1, range: { startDate: "2026-01-01", endDate: "2026-01-01" } },
      ezpass: { complete: true, completeForRange: true, pageCount: 3, lastPage: 3, recordCount: 1,
        requestedRange: { startDate: "2026-01-01", endDate: "2026-01-01" }, observedRange: { startDate: "2025-12-01", endDate: "2026-02-01" } }
    },
    invoiceDrafts: [{
      reservationId: "trip", vehicleId: "car1", startMs: Date.parse("2026-01-01T14:00:00Z"), endMs: Date.parse("2026-01-01T20:00:00Z"),
      eligibility: "eligible_uncharged", tolls: [{ id: "toll", timestampMs: Date.parse("2026-01-01T16:00:00Z"), plaza: "Example", amountCents: 425, tagId: "001" }],
      selectedTollIds: ["toll"], selected: true, selectable: true, blockingReasons: [], totalCents: 425
    }],
    selectionSummary: { tripCount: 0, tollCount: 0, totalCents: 0 }, reconciliation: { matched: [], unmatchedTolls: [{
      toll: { id: "review-toll", timestampMs: Date.parse("2026-01-01T16:00:00Z"), plaza: "Example", amountCents: 425, tagOrPlate: "000123" },
      reason: "identifier_not_mapped", candidates: [{ id: "trip", vehicleId: "car1" }]
    }], ambiguous: [] }, lastSync: null
  };
  if (withRemovables) {
    state.fleet.assignments = [{ id: "assignment-1", vehicleId: "car1", kind: "tag", identifier: "001" }];
    state.evidence = [{ id: "image-1", reservationId: "trip", kind: "tag", identifier: "001",
      startDate: "2026-01-01", endDate: "2026-01-01", coveredTollIds: ["toll"] }];
  }
  if (withPageReport) state.collectionRuns.ezpass.queryReports = [{
    reservationId: "trip", queryId: "trip:tag:001", kind: "tag", status: "complete",
    complete: true, pageCount: 2, recordCount: 10
  }];
  const messages = [];
  const chrome = { runtime: { sendMessage: async (message) => {
    messages.push(structuredClone(message));
    if (message.type === "SAVE_UI_DRAFT") state.uiDrafts.vehicleAssignment = message.draft;
    if (message.type === "UPSERT_ASSIGNMENT") {
      state.fleet.assignments.push({ id: "a1", ...message.assignment }); state.uiDrafts.vehicleAssignment = {};
    }
    if (message.type === "REFRESH_EZPASS_IDENTIFIERS") return { ok: true, state: structuredClone(state), inventory: structuredClone(state.fleet.identifierInventory) };
    return { ok: true, state: structuredClone(state), synced: true, collection: { turo: { ok: true }, ezpass: { ok: true } } };
  } } };
  vm.runInNewContext(readFileSync("dashboard.js", "utf8"), { document, chrome, Intl, Date, Object, Set, clearTimeout, setTimeout, structuredClone, confirm: () => confirmRemoval });
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, messages, state };
}

test("dashboard restores a vehicle draft after reopening", async () => {
  const env = await dashboard();
  assert.equal(env.elements.get("#vehicleId").value, "car1");
  assert.equal(env.elements.get("#identifier").value, "001");
});

test("dashboard submits a dated assignment and clears the completed form", async () => {
  const env = await dashboard();
  env.elements.get("#validFrom").value = "2026-01-01";
  await env.elements.get("#assignmentForm").listeners.submit({ preventDefault() {} });
  const save = env.messages.find((message) => message.type === "UPSERT_ASSIGNMENT");
  assert.equal(save.assignment.identifier, "001");
  assert.equal(save.assignment.validFrom, "2026-01-01");
  assert.equal(env.elements.get("#vehicleId").value, "");
});

test("dashboard renders trip cards and sends trip selection changes", async () => {
  const env = await dashboard();
  assert.equal(env.elements.get("#tripsList").children.length, 1);
  assert.equal(env.elements.get("#batchList").children.length, 1);
  assert.equal(env.elements.get("#coverageStatus").textContent, "All configured trip identifiers searched");
  assert.match(env.elements.get("#ezpassCompleteness").textContent, /last page 3.*requested 2026-01-01.*observed 2025-12-01/);
  const button = descendants(env.elements.get("#tripsList")).find((item) => item.dataset.action === "trip");
  await env.elements.get("#tripsList").listeners.click({ target: button });
  assert.equal(env.messages.at(-1).type, "SET_TRIP_SELECTION");
  assert.equal(env.messages.at(-1).reservationId, "trip");
  assert.equal(env.messages.at(-1).selected, false);
});

test("dashboard exposes vehicles, trips, review and batch pages", async () => {
  const env = await dashboard();
  for (const id of ["#navVehicles", "#navTrips", "#navReview", "#navBatch"]) assert.equal(typeof env.elements.get(id).listeners.click, "function");
  env.elements.get("#navTrips").listeners.click();
  assert.equal(env.elements.get("#tripsView").hidden, false);
  assert.equal(env.elements.get("#vehiclesView").hidden, true);
});

function descendants(node) {
  return [node, ...(node?.children || []).flatMap(descendants)];
}

test("vehicle cards distinguish Turo IDs and immediately link verified plates", async () => {
  const env = await dashboard();
  const text = descendants(env.elements.get("#assignmentList")).map((item) => item.textContent).join(" ");
  assert.match(text, /Turo internal vehicle ID: car1 — not an E-ZPass tag/);
  const button = descendants(env.elements.get("#assignmentList")).find((item) => item.dataset.mapKind === "plate");
  await env.elements.get("#assignmentList").listeners.click({ target: button });
  const save = env.messages.find((message) => message.type === "UPSERT_ASSIGNMENT");
  assert.equal(save.assignment.identifier, "ABC123");
  assert.equal(save.assignment.kind, "plate");
});

test("needs review opens an inline editor and saves only after confirmation", async () => {
  const env = await dashboard();
  assert.equal(env.elements.get("#navReviewCount").textContent, 1);
  const buttons = descendants(env.elements.get("#tollReviewList")).filter((item) => item.dataset.mapVehicleId);
  assert.deepEqual(buttons.map((button) => button.dataset.mapKind), ["tag", "plate"]);
  await env.elements.get("#tollReviewList").listeners.click({ target: buttons[0] });
  assert.equal(env.messages.some((message) => message.type === "UPSERT_ASSIGNMENT"), false);
  const form = descendants(env.elements.get("#tollReviewList")).find((item) => item.className === "review-mapping-editor");
  assert.ok(form);
  await form.listeners.submit({ preventDefault() {} });
  const save = env.messages.findLast((message) => message.type === "UPSERT_ASSIGNMENT");
  assert.equal(save.assignment.vehicleId, "car1");
  assert.equal(save.assignment.identifier, "000123");
  assert.equal(save.assignment.kind, "tag");
});

test("account inventory populates the preferred selector and manual entry remains explicit", async () => {
  const env = await dashboard();
  const options = env.elements.get("#accountIdentifier").children;
  assert.deepEqual(options.slice(1).map((option) => option.value), ["plate:ABC123", "tag:001"]);
  assert.equal(env.elements.get("#manualIdentifierFields").hidden, true);
  assert.equal(env.elements.get("#identifier").required, false);
  env.elements.get("#manualIdentifierButton").listeners.click();
  assert.equal(env.elements.get("#manualIdentifierFields").hidden, false);
  assert.equal(env.elements.get("#identifier").required, true);
});

test("inventory refresh and evidence handoff buttons invoke real worker operations", async () => {
  const env = await dashboard();
  await env.elements.get("#refreshIdentifiersButton").listeners.click();
  assert.equal(env.messages.at(-1).type, "REFRESH_EZPASS_IDENTIFIERS");
  await env.elements.get("#goEvidenceButton").listeners.click();
  assert.equal(env.messages.at(-1).type, "OPEN_EZPASS_EVIDENCE");
});

test("removal controls confirm first and cancellation leaves state unchanged", async () => {
  const env = await dashboard({ confirmRemoval: false });
  const vehicle = descendants(env.elements.get("#assignmentList")).find((item) => item.dataset.vehicleId === "car1");
  const trip = descendants(env.elements.get("#batchList")).find((item) => item.dataset.removeBatchTrip === "trip");
  await env.elements.get("#assignmentList").listeners.click({ target: vehicle });
  await env.elements.get("#batchList").listeners.click({ target: trip });
  await env.elements.get("#clearButton").listeners.click();
  assert.equal(env.messages.some((item) => ["HIDE_VEHICLE", "SET_TRIP_SELECTION", "CLEAR_LOCAL_DATA"].includes(item.type)), false);
});

test("vehicle and individual Batch removals dispatch only after confirmation", async () => {
  const env = await dashboard();
  const vehicle = descendants(env.elements.get("#assignmentList")).find((item) => item.dataset.vehicleId === "car1");
  const trip = descendants(env.elements.get("#batchList")).find((item) => item.dataset.removeBatchTrip === "trip");
  await env.elements.get("#assignmentList").listeners.click({ target: vehicle });
  await env.elements.get("#batchList").listeners.click({ target: trip });
  assert.ok(env.messages.some((item) => item.type === "HIDE_VEHICLE" && item.vehicleId === "car1"));
  assert.ok(env.messages.some((item) => item.type === "SET_TRIP_SELECTION" && item.reservationId === "trip" && item.selected === false));
});

test("date form applies an optional trip-end range", async () => {
  const env = await dashboard();
  env.elements.get("#tripStartDate").value = "2026-09-01";
  env.elements.get("#tripEndDate").value = "2026-09-30";
  await env.elements.get("#tripDateForm").listeners.submit({ preventDefault() {} });
  const update = env.messages.find((item) => item.type === "UPDATE_SETTINGS");
  assert.equal(update.settings.tripDateRange.startDate, "2026-09-01");
  assert.equal(update.settings.tripDateRange.endDate, "2026-09-30");
});

test("assignment and evidence removal both honor cancellation", async () => {
  const env = await dashboard({ confirmRemoval: false, withRemovables: true });
  const assignment = descendants(env.elements.get("#assignmentList")).find((item) => item.dataset.assignmentId === "assignment-1");
  const evidence = descendants(env.elements.get("#batchList")).find((item) => item.dataset.evidenceId === "image-1");
  await env.elements.get("#assignmentList").listeners.click({ target: assignment });
  await env.elements.get("#batchList").listeners.click({ target: evidence });
  assert.equal(env.messages.some((item) => item.type === "DELETE_ASSIGNMENT" || item.type === "DELETE_EVIDENCE"), false);
});

test("trip cards show collected result-page and toll counts", async () => {
  const env = await dashboard({ withPageReport: true });
  const text = descendants(env.elements.get("#tripsList")).map((item) => item.textContent).join(" ");
  assert.match(text, /2 result pages/);
  assert.match(text, /10 filtered toll rows/);
  assert.match(text, /1 matched toll/);
});
