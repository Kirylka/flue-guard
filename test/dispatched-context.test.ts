/**
 * The dispatched / addressable-agent pattern: tools run detached from the
 * caller, so AsyncLocalStorage can't reach them. `toolkit.withContext(...)`
 * binds the trusted context per invocation (derived from the dispatch payload
 * inside `createAgent`) instead. These tests prove that binding works without
 * any ambient context and that concurrent interactions don't bleed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createGovernedToolkit,
  toFlueTool,
} from "./_all.js";
import { ScopeViolationError } from "../src/errors.js";
import type { TrustedContext } from "../src/types.js";

// A base toolkit whose ambient resolver THROWS — proving bound tools never fall
// back to it. This mimics "there is no ALS context here" in a dispatched run.
function baseToolkit(audit = new InMemoryAuditLog()) {
  const toolkit = createGovernedToolkit({
    context: () => {
      throw new Error("ambient context must not be used in the dispatched path");
    },
    audit,
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  return { toolkit, audit };
}

const acct = (id: string): TrustedContext => ({
  actor: { id, roles: ["account_holder"] },
  tenantId: "app",
  scopes: [`account:${id}`],
});

test("withContext binds identity per invocation, with no ambient context", async () => {
  const { toolkit, audit } = baseToolkit();

  // This is what you'd do inside createAgent((ctx) => ...), deriving identity
  // from ctx.payload:
  const bound = toolkit.withContext(acct("user-7"));
  const resetPassword = bound.defineGovernedTool<{ accountId: string }>({
    name: "reset_password",
    description: "send a reset link",
    sideEffect: true,
    scope: (a) => `account:${a.accountId}`,
    execute: (a) => `reset ${a.accountId}`,
  });

  // Own account: allowed. Another account: blocked — all without any ALS run().
  assert.equal(await resetPassword.execute({ accountId: "user-7" }), "reset user-7");
  await assert.rejects(
    () => resetPassword.execute({ accountId: "victim" }),
    ScopeViolationError,
  );

  const entries = await audit.entries();
  assert.equal(entries.at(-1)!.actorId, "user-7");
  assert.equal(entries.at(-1)!.error, "scope_violation");
});

test("works when executed fully detached from the binding call stack", async () => {
  const { toolkit } = baseToolkit();
  const bound = toolkit.withContext(acct("user-1"));
  const tool = bound.defineGovernedTool<{ accountId: string }>({
    name: "reset_password",
    description: "x",
    sideEffect: true,
    scope: (a) => `account:${a.accountId}`,
    execute: (a) => `ok:${a.accountId}`,
  });

  // Simulate the coordinator running the tool on a later, unrelated tick.
  const result = await new Promise<unknown>((resolve, reject) => {
    setTimeout(() => {
      tool.execute({ accountId: "user-1" }).then(resolve, reject);
    }, 1);
  });
  assert.equal(result, "ok:user-1");
});

test("two concurrent interactions don't bleed contexts", async () => {
  const audit = new InMemoryAuditLog();
  const { toolkit } = baseToolkit(audit);

  const make = (id: string) =>
    toolkit.withContext(acct(id)).defineGovernedTool<{ accountId: string }>({
      name: "reset_password",
      description: "x",
      sideEffect: true,
      scope: (a) => `account:${a.accountId}`,
      execute: (a) => `reset ${a.accountId} as ${id}`,
    });

  const a = make("alice");
  const b = make("bob");

  // alice can reset alice; bob resetting alice is out of scope.
  const [r1, r2] = await Promise.all([
    a.execute({ accountId: "alice" }),
    b.execute({ accountId: "bob" }),
  ]);
  assert.equal(r1, "reset alice as alice");
  assert.equal(r2, "reset bob as bob");
  await assert.rejects(() => b.execute({ accountId: "alice" }), ScopeViolationError);
});

test("withContext composes with the real Flue defineTool + toFlueTool", async () => {
  // Use the real adapter shape so the dispatched pattern is exercised end to end
  // at the tool-contract level.
  const { toolkit, audit } = baseToolkit();
  const bound = toolkit.withContext(acct("user-9"));
  const flueTool = toFlueTool(
    bound.defineGovernedTool<{ accountId: string }>({
      name: "reset_password",
      description: "send a reset link",
      sideEffect: true,
      scope: (a) => `account:${a.accountId}`,
      execute: (a) => ({ reset: a.accountId }),
    }),
  );

  // Flue calls run({ input, signal }) and expects structured data back.
  const out = await flueTool.run({ input: { accountId: "user-9" } });
  assert.deepEqual(out, { reset: "user-9" });
  assert.equal((await audit.entries()).at(-1)!.outcome, "success");
});

test("withContext accepts a resolver function too", async () => {
  const { toolkit } = baseToolkit();
  const bound = toolkit.withContext(() => acct("dynamic-1"));
  const tool = bound.defineGovernedTool<{ accountId: string }>({
    name: "reset_password",
    description: "x",
    sideEffect: true,
    scope: (a) => `account:${a.accountId}`,
    execute: (a) => `ok:${a.accountId}`,
  });
  assert.equal(await tool.execute({ accountId: "dynamic-1" }), "ok:dynamic-1");
});
