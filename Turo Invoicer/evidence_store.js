const DB_NAME = "turo-toll-evidence";
const STORE = "screenshots";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Evidence database could not be opened."));
  });
}

function transact(mode, action) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Evidence database operation failed."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("Evidence transaction failed.")); };
  }));
}

function dataUrlBytes(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Browser did not return a PNG screenshot.");
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");

export async function storePng(dataUrl, metadata) {
  const bytes = dataUrlBytes(dataUrl);
  const id = crypto.randomUUID();
  const hash = hex(await crypto.subtle.digest("SHA-256", bytes));
  const blob = new Blob([bytes], { type: "image/png" });
  let dimensions = { width: null, height: null };
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
  }
  await transact("readwrite", (store) => store.put({ id, blob }));
  return { id, hash, byteLength: bytes.byteLength, ...dimensions, ...metadata };
}

export async function deleteEvidenceBlob(id) {
  await transact("readwrite", (store) => store.delete(String(id)));
}

export async function getEvidenceBlob(id) {
  return transact("readonly", (store) => store.get(String(id))).then((record) => record?.blob || null);
}

export async function clearEvidenceBlobs() {
  await transact("readwrite", (store) => store.clear());
}
