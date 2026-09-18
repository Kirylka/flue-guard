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
