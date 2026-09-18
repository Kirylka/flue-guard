import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// A separate process isolates Flue's provider and runtime registries.
test("governed tools enforce policy through Flue's real dispatched model loop", { timeout: 30000 }, async () => {
  await promisify(execFile)(process.execPath, ["scripts/live-faux-spike.mjs"], {
    cwd: new URL("../../", import.meta.url),
    timeout: 25000,
  });
});


test("Jev guard deny, review, resume and replay work through Flue's model loop", { timeout: 30000 }, async () => {
  await promisify(execFile)(process.execPath, ["scripts/jev-faux-spike.mjs"], {
    cwd: new URL("../../", import.meta.url),
    timeout: 25000,
  });
});
