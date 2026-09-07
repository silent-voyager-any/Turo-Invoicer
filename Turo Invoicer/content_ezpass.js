(() => {
  "use strict";
  const { scalar, pick, timestamp, textOf, tableValues, createCapture } = TollCapture;
  const TRANSACTIONS_PATH = "/ezpass/dashboard/transactions";
  const NON_TOLL_ACTIVITY = /\b(?:credit|payment|replenish(?:ment)?|deposit|refund|balance|adjust(?:ment)?)\b/i;

  function hasCompleteInstant(value) {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string") return false;
    const text = value.trim();
    return /^\d{10}$|^\d{13}$/.test(text) || /(?:T|\s)\d{1,2}:\d{2}/.test(text);
  }

  function parseToll(value) {
    const activity = scalar(pick(value, ["activity", "transactionType", "activityType", "type"]));
    if (activity && NON_TOLL_ACTIVITY.test(String(activity))) return null;
    // Exit/passage/transaction time is usable; posting dates are not.
    const time = timestamp(value,
      ["timestamp", "transactionDateTime", "transactionTimestamp", "txnDateTime",
        "tollDateTime", "tollTimestamp", "exitDateTime", "passageDateTime", "dateTime"],
      ["transactionDate", "txnDate", "tollDate", "exitDate", "passageDate"],
      ["transactionTime", "txnTime", "tollTime", "exitTime", "passageTime"]) ??
      scalar(pick(value, ["transactionTime", "tollTime"]));
    const plazaValue = pick(value, ["exitPlazaName", "exitPlaza", "plaza", "plazaName",
      "plazaLocation", "tollPlaza", "facilityName", "facility", "location", "entryPlaza"]);
    const plaza = scalar(plazaValue) ?? scalar(pick(plazaValue, ["name", "description", "code"]));
    const amount = scalar(pick(value, ["displayAmount", "tollAmount", "transactionAmount", "amount", "chargeAmount", "charge", "fare"]));
    if (!hasCompleteInstant(time) || plaza == null || amount == null) return null;
    return {
      id: scalar(pick(value, ["laneTxnId", "laneTransactionId", "transactionId", "txnId", "transactionNumber", "referenceNumber", "id"])),
      timestamp: time, plaza: String(plaza), amount,
      tagId: scalar(pick(value, ["tagId", "tagNumber", "transponderId", "transponderNumber"])),
      plate: scalar(pick(value, ["licensePlate", "plateNumber", "plate"])),
      tagOrPlate: scalar(pick(value, ["tagOrPlateNumber", "tagOrPlate", "tagPlateNumber", "tagPlate"])),
      vehicleId: null // An E-ZPass vehicle ID is not a Turo vehicle ID.
    };
  }

  function readDom(add) {
    if (new URL(location.href).pathname.replace(/\/$/, "") !== TRANSACTIONS_PATH) return;
    const rows = new Set(document.querySelectorAll(
      '[data-transaction-id], [data-testid*="transaction-row" i], [data-test*="transaction-row" i], ' +
      'table tr, [role="grid"] [role="row"], [role="table"] [role="row"]'
    ));
    for (const row of rows) {
      const cell = tableValues(row);
      // Header matching is punctuation/whitespace insensitive, and is scoped
      // to this table/grid. Exit timestamps and plazas win over entry values.
      const date = cell([/^exit date$/, /^transaction date$/, /^txn date$/, /^toll date$/, /^date$/]);
      const time = cell([/^exit time$/, /^transaction time$/, /^txn time$/, /^toll time$/, /^time$/]);
      const explicitDateTime = cell([
        /^exit date (?:and )?time$/, /^transaction date (?:and )?time$/,
        /^txn date (?:and )?time$/, /^toll date (?:and )?time$/, /^date (?:and )?time$/
      ]);
      const tagged = cell([/^tag plate(?: number| no)?$/]);
      const type = cell([/^activity$/, /^transaction type$/, /^activity type$/, /^type$/]);
      const candidate = {
        transactionId: row.dataset.transactionId || cell([/^lane txn id$/, /^transaction (?:id|number|no)$/, /^reference(?: number)?$/]),
        timestamp: row.dataset.timestamp || explicitDateTime ||
          (date && /\d{1,2}:\d{2}/.test(date) ? date : date && time ? date + " " + time : null) ||
          textOf(row, ['[data-field="transactionDateTime"]', '[data-testid="transaction-date-time"]']),
        transactionDate: row.dataset.transactionDate || date,
        transactionTime: row.dataset.transactionTime || time,
        plaza: row.dataset.plaza || cell([
          /^exit plaza(?: name)?$/, /^plaza(?: name| location)?$/, /^toll plaza$/,
          /^facility(?: name)?$/, /^location$/, /^entry plaza(?: name)?$/, /^transaction description$/, /^description$/
        ]) || textOf(row, ['[data-field="plaza"]', '[data-testid="plaza"]']),
        amount: row.dataset.amount ?? cell([/^toll amount$/, /^transaction amount$/, /^amount$/, /^toll$/, /^charge(?: amount)?$/, /^fare$/]) ??
          textOf(row, ['[data-field="amount"]', '[data-testid="amount"]']),
        tagId: row.dataset.tagId || cell([/^tag(?: number| id| no)?$/, /^transponder(?: number| id| no)?$/]),
        // Even a numeric plate can resemble a tag. Preserve the mixed value and
        // resolve only via an explicit user mapping, without guessing its type.
        tagOrPlate: tagged,
        plate: row.dataset.plate || cell([/^license plate(?: number)?$/, /^plate(?: number| no)?$/]),
        activity: type
      };
      // Do not count header/layout rows as raw transactions. Credit rows still
      // enter the raw count and are deliberately rejected by parseToll.
      if (candidate.transactionId || candidate.timestamp || candidate.transactionDate || candidate.amount || candidate.activity) add(candidate);
    }
  }

  createCapture("ezpass", parseToll, readDom, {
    collectorRevision: "0.4.7-history-pagination-2",
    isPageAllowed: (path) => path === TRANSACTIONS_PATH,
    pageMessage: "Open https://www.e-zpassny.com/ezpass/dashboard/transactions and apply your activity filters before syncing.",
    waitTimeoutMs: 20000,
    settleMs: 300,
    observeThrottleMs: 100,
    collect: globalThis.EzpassCollection?.collect,
    emptyMessage: "Timed out after 20 seconds waiting for complete E-ZPass toll postings. Credits and other non-toll activity are ignored; a toll must include an exit/transaction date, time, plaza, and amount. Apply a date range, then reload the page and retry."
  });
})();
