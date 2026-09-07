(() => {
  "use strict";

  const ORIGIN = "https://turo.com";
  const WAIT_MS = 10000;
  const text = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
  const visible = (node) => Boolean(node && !node.hidden && node.getAttribute?.("aria-hidden") !== "true" &&
    (node.offsetParent !== null || node.getClientRects?.().length));

  function route(reservationId) {
    const id = String(reservationId || "");
    if (!/^\d{1,20}$/.test(id) || location.origin !== ORIGIN) return null;
    const path = new URL(location.href).pathname.replace(/\/$/, "");
    if (path === `/us/en/reservation/${id}/invoice-hub`) return "hub";
    if (path === `/us/en/reservation/${id}/reimbursement/invoice`) return "invoice";
    if (path === `/us/en/reservation/${id}/reimbursement/request/select-incidental`) return "select";
    return null;
  }

  function invoiceLink(href, reservationId) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
          url.pathname.replace(/\/$/, "") !== `/us/en/reservation/${reservationId}/reimbursement/invoice`) return null;
      if ([...url.searchParams.keys()].some((key) => key !== "invoiceId") ||
          url.searchParams.getAll("invoiceId").length !== 1 || !/^\d{1,20}$/.test(url.searchParams.get("invoiceId") || "")) return null;
      return url.href;
    } catch { return null; }
  }

  function inspect(reservationId) {
    const phase = route(reservationId);
    if (!phase) return null;
    if (phase === "hub") {
      const heading = [...document.querySelectorAll("h1")].some((node) => visible(node) && /^invoices$/i.test(text(node)));
      if (!heading) return null;
      const urls = [...new Set([...document.querySelectorAll('a[href*="/reimbursement/invoice"]')]
        .map((node) => invoiceLink(node.getAttribute("href"), reservationId)).filter(Boolean))];
      const canCreate = [...document.querySelectorAll("button, a")]
        .some((node) => visible(node) && /^create invoice$/i.test(text(node)));
      return { ok: true, phase, invoiceUrls: urls, canCreate };
    }
    if (phase === "invoice") {
      const root = document.querySelector('[data-testid="reimbursement-InvoiceOverviewView"]');
      if (!root || !visible(root)) return null;
      const hasTolls = [...root.querySelectorAll('h1, h2, h3, [data-testid="itemDescriptionPrice-title"]')]
        .some((node) => /^tolls?$/i.test(text(node)));
      return { ok: true, phase, hasTolls };
    }
    const toll = document.querySelector('input[type="radio"]#TOLLS, input[type="radio"][value="TOLLS"]');
    if (!toll || !visible(toll)) return null;
    return { ok: true, phase, tollOptionAvailable: !toll.disabled && toll.getAttribute("aria-disabled") !== "true" };
  }

  function waitForStatus(reservationId, reply) {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer.disconnect();
      reply(result);
    };
    const check = () => {
      if (!route(reservationId)) {
        finish({ ok: false, error: "Turo invoice verification left the expected reservation route." });
        return;
      }
      const result = inspect(reservationId);
      if (result) finish(result);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    const timer = setTimeout(() => finish({ ok: false,
      error: "Turo invoice verification did not expose a supported invoice or toll-eligibility view." }), WAIT_MS);
    check();
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "COLLECT_INVOICE_STATUS") return false;
    waitForStatus(message.reservationId, reply);
    return true;
  });

  globalThis.TuroInvoiceStatus = Object.freeze({ route, invoiceLink, inspect });
})();
