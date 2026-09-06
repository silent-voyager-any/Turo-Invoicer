const elements = Object.fromEntries(["tripCount", "tollCount", "openDashboard", "syncButton", "status", "statusDot", "lastSync"]
  .map((id) => [id, document.querySelector(`#${id}`)]));

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
    return response;
  });
}

function status(message, kind = "good") {
  elements.status.textContent = message;
  elements.status.className = `status${kind === "error" ? " error" : ""}`;
  elements.statusDot.className = `status-dot ${kind}`;
}

function render(state) {
  elements.tripCount.textContent = state.sources?.turo?.records?.length || 0;
  elements.tollCount.textContent = state.sources?.ezpass?.records?.length || 0;
  elements.lastSync.textContent = state.lastSync ? `Synced ${new Date(state.lastSync).toLocaleString()}` : "Never synced";
}

elements.openDashboard.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
});

elements.syncButton.addEventListener("click", async () => {
  elements.syncButton.disabled = true;
  status("Waiting for both signed-in portal tabs…", "busy");
  try {
    const response = await send({ type: "RUN_SYNC" });
    render(response.state);
    const errors = Object.entries(response.collection).filter(([, result]) => !result.ok)
      .map(([source, result]) => `${source}: ${result.error}`);
    status(response.synced ? "Sync complete. Open the dashboard to review." : `Not refreshed. ${errors.join(" ")}`, response.synced ? "good" : "error");
  } catch (error) { status(error.message, "error"); }
  finally { elements.syncButton.disabled = false; }
});

send({ type: "GET_STATE" }).then(({ state }) => { render(state); status("Ready."); })
  .catch((error) => status(error.message, "error"));
