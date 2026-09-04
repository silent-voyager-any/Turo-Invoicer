(() => {
  "use strict";

  // This file runs in the page's MAIN world. It observes response bodies only;
  // it never reads cookies, authorization headers, or request bodies.
  if (window.__TURO_TOLL_NETWORK_HOOK__) return;
  Object.defineProperty(window, "__TURO_TOLL_NETWORK_HOOK__", { value: true });

  const MESSAGE_SOURCE = "turo-toll-reconciler-page";
  const MAX_RESPONSE_CHARS = 2_000_000;
  const relevantPath = /(?:trip|reservation|booking|calendar|transaction|toll|activity|statement)/i;
  const excludedPath = /(?:login|logout|auth|password|token|payment|profile)/i;
  const isTuro = location.hostname === "turo.com";
  const HISTORY_PATH = "/us/en/trips/history";
  const TARGET_PATH = isTuro ? HISTORY_PATH : "/ezpass/dashboard/transactions";
  const pagePath = () => new URL(location.href).pathname.replace(/\/$/, "");

  function isAllowedUrl(rawUrl, startedOn = pagePath()) {
    try {
      if (startedOn !== TARGET_PATH || pagePath() !== TARGET_PATH) return false;
      const url = new URL(rawUrl, location.href);
      const domain = location.hostname.endsWith("turo.com") ? "turo.com" : "e-zpassny.com";
      const sameSite = url.hostname === domain || url.hostname.endsWith("." + domain);
      // API subdomains can be observed without granting them request privileges.
      return url.protocol === "https:" && sameSite && relevantPath.test(url.pathname) && !excludedPath.test(url.pathname);
    } catch {
      return false;
    }
  }

  function publish(startedOn, payload) {
    if (payload == null) return;
    if (startedOn !== TARGET_PATH || pagePath() !== TARGET_PATH) return;
    // No request URL/query string crosses the bridge (it may contain tokens).
    if (JSON.stringify(payload).length > MAX_RESPONSE_CHARS) return;
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "NETWORK_RESPONSE",
        pagePath: TARGET_PATH,
        payload
      },
      location.origin
    );
  }

  function parseJsonText(text) {
    if (typeof text !== "string" || text.length > MAX_RESPONSE_CHARS) return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  const originalFetch = window.fetch;
  async function readBounded(response) {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_CHARS) { reader.cancel().catch(() => {}); return null; }
        text += decoder.decode(value, { stream: true });
      }
      return parseJsonText(text + decoder.decode());
    } finally { reader.releaseLock(); }
  }
  window.fetch = async function interceptedFetch(...args) {
    const startedOn = pagePath();
    const response = await originalFetch.apply(this, args);
    const requestUrl = response.url || args[0]?.url || args[0];
    if (response.ok && isAllowedUrl(requestUrl, startedOn)) {
      try {
        const contentLength = Number(response.headers.get("content-length") || 0);
        const contentType = response.headers.get("content-type") || "";
        if ((!contentLength || contentLength <= MAX_RESPONSE_CHARS) && /json|text\/plain/i.test(contentType)) {
          readBounded(response.clone()).then((payload) => publish(startedOn, payload)).catch(() => {});
        }
      } catch {
        // Opaque/streamed responses may not be cloneable; DOM extraction remains available.
      }
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function interceptedOpen(method, url, ...rest) {
    const result = originalOpen.call(this, method, url, ...rest);
    if (!requests.has(this)) {
      this.addEventListener(
        "load",
        () => {
          try {
            const request = requests.get(this);
            const requestUrl = this.responseURL || request.url;
            if (!isAllowedUrl(requestUrl, request.pagePath) || this.status < 200 || this.status >= 300) return;
            const payload =
              this.responseType === "json"
                ? this.response
                : parseJsonText(this.responseText);
            publish(request.pagePath, payload);
          } catch {
            // Access to some response types throws; ignore and rely on the DOM.
          }
        }
      );
    }
    requests.set(this, { url: String(url), pagePath: pagePath() });
    return result;
  };
})();
