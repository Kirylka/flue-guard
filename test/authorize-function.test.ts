import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernedToolkit } from "../src/toolkit.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { AuthorizationDeniedError, GovernanceConfigError } from "../src/errors.js";

const ctx = { actor: { id: "u-1", roles: [] }, tenantId: "t" };

test("a plain authorize function is a caller check and counts as a gate", async () => {
  const audit = new InMemoryAuditLog();
  const gov = createGovernedToolkit({ audit, context: () => ctx });
  const close = gov.defineGovernedTool<{ accountId: string }, string>({
    name: "close",
    description: "c",
    sideEffect: true,
    authorize: (a, c) => a.accountId === c.actor.id,
    execute: (a) => `closed ${a.accountId}`,
  });
  assert.equal(await close.execute({ accountId: "u-1" }), "closed u-1");
  await assert.rejects(close.execute({ accountId: "u-2" }), AuthorizationDeniedError);
  assert.equal((await audit.entries()).at(-1)!.error, "authorization_denied");
});

test("a side-effecting tool without any gate still fails to define", () => {
  const gov = createGovernedToolkit({ audit: false, context: () => ctx });
  assert.throws(
    () => gov.defineGovernedTool({ name: "x", description: "x", sideEffect: true, execute: () => 1 }),
    GovernanceConfigError,
  );
});
