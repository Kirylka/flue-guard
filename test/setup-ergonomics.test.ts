/**
 * Ergonomics: the minimal setup path. Toolkit owns a ContextStore (use
 * gov.run), audit accepts a file path string, and scopes are optional when a
 * tool gates with authorize.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGovernedToolkit,
  caller,
  HashChainAuditLog,
  InMemoryAuditLog,
} from "./_all.js";
import {
  AuthorizationDeniedError,
  GovernanceConfigError,
  MissingContextError,
} from "../src/errors.js";

test("minimal setup: audit path string + built-in store + optional scopes", async () => {
  const path = join(tmpdir(), `ergo-${Date.now()}-${Math.random()}.jsonl`);
  try {
    // No `context` (built-in store), no idempotencyStore, audit as a string.
    const gov = createGovernedToolkit({ audit: path });

    let runs = 0;
    const reset = gov.defineGovernedTool<{ accountId: string }>({
      name: "reset_password",
      description: "send a reset link",
      sideEffect: true,
      authorize: caller((a, ctx) => a.accountId === ctx.actor.id),
      execute: () => {
        runs += 1;
        return "ok";
      },
    });

    // No `scopes` in the trusted context — this tool gates with authorize.
    await gov.run({ actor: { id: "u-1", roles: [] }, tenantId: "app" }, async () => {
      await reset.execute({ accountId: "u-1" }); // own account → allowed
      await assert.rejects(
        () => reset.execute({ accountId: "victim" }),
        AuthorizationDeniedError,
      );
    });
    assert.equal(runs, 1);

    // The string audit was wired into a hash-chained file log.
    const log = new HashChainAuditLog({ path });
    assert.deepEqual(await log.verify(), { valid: true });
    assert.ok((await log.entries()).length >= 1);
  } finally {
    rmSync(path, { force: true });
  }
});

test("gov.run binds the built-in store; current() throws outside it", () => {
  const gov = createGovernedToolkit({ audit: new InMemoryAuditLog() });
  assert.throws(() => gov.current(), MissingContextError);
  const tenant = gov.run(
    { actor: { id: "a", roles: [] }, tenantId: "t" },
    () => gov.current().tenantId,
  );
  assert.equal(tenant, "t");
});

test("a custom resolver makes gov.run unavailable (you bind context yourself)", () => {
  const gov = createGovernedToolkit({
    audit: new InMemoryAuditLog(),
    context: () => ({ actor: { id: "a", roles: [] }, tenantId: "t" }),
  });
  assert.throws(
    () => gov.run({ actor: { id: "a", roles: [] }, tenantId: "t" }, () => 1),
    GovernanceConfigError,
  );
});
