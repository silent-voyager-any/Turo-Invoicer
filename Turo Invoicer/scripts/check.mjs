import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["https://turo.com/*", "https://www.e-zpassny.com/*", "https://e-zpassny.com/*"]);
for (const file of [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((script) => script.js)]) assert.ok(existsSync(file), file);
for (const file of readdirSync(".").filter((name) => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message || result.stderr || "Syntax checker could not run.");
}
console.log("Manifest references, least-privilege permissions, and JavaScript syntax passed.");
