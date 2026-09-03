(() => {
  "use strict";
  const { scalar, pick, timestamp, textOf, tableValues, createCapture } = TollCapture;

  function parseToll(value) {
    // Use passage/transaction time, NEVER posting date (posting can be days later).
    const time = timestamp(value,
      ["timestamp", "transactionDateTime", "transactionTimestamp", "tollTimestamp", "dateTime"],
      ["transactionDate", "txnDate", "tollDate"], ["transactionTime", "txnTime", "tollTime"]) ??
      scalar(pick(value, ["transactionTime", "tollTime"]));
    const plaza = scalar(pick(value, ["plaza", "plazaName", "plazaLocation", "tollPlaza", "facilityName", "location"]));
    const amount = scalar(pick(value, ["tollAmount", "transactionAmount", "amount", "charge", "fare"]));
    if (time == null || plaza == null || amount == null) return null;
    return {
      id: scalar(pick(value, ["transactionId", "txnId", "id"])),
      timestamp: time, plaza: String(plaza), amount,
      tagId: scalar(pick(value, ["tagId", "tagNumber", "transponderId", "transponderNumber"])),
      plate: scalar(pick(value, ["licensePlate", "plateNumber", "plate"])),
      // E-ZPass vehicle IDs are a different namespace from Turo IDs. Resolve
      // identity only through an explicit tag/plate mapping in the popup.
      vehicleId: null
    };
  }

  function readDom(add) {
    const rows = document.querySelectorAll(
      '[data-transaction-id], [data-testid*="transaction-row" i], [data-test*="transaction-row" i], table tbody tr'
    );
    for (const row of rows) {
      const cell = tableValues(row);
      const date = cell([/^transaction date$/, /^toll date$/, /^date$/]);
      const time = cell([/^transaction time$/, /^toll time$/, /^time$/]);
      add({
        transactionId: row.dataset.transactionId || cell([/^transaction id$/, /^reference$/]),
        timestamp: row.dataset.timestamp || row.querySelector("time[datetime]")?.dateTime ||
          cell([/^transaction date\/time$/, /^date\/time$/]) ||
          (date && time ? date + " " + time : date) ||
          textOf(row, ['[data-field="transactionDateTime"]', '[data-testid="transaction-date-time"]']),
        plaza: row.dataset.plaza || cell([/plaza/, /facility/, /^location$/]) ||
          textOf(row, ['[data-field="plaza"]', '[data-testid="plaza"]']),
        amount: row.dataset.amount ?? cell([/^amount$/, /^toll amount$/, /^charge$/, /^fare$/]) ??
          textOf(row, ['[data-field="amount"]', '[data-testid="amount"]']),
        tagId: row.dataset.tagId || cell([/^tag(?: number| id)?$/, /^transponder/]),
        plate: row.dataset.plate || cell([/^license plate$/, /^plate(?: number)?$/])
      });
    }
  }

  createCapture("ezpass", parseToll, readDom);
})();
