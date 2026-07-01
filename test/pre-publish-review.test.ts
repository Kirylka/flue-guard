/**
 * Regression tests for the pre-publish (v0.1.0) review findings:
 *
 *   R1 — a non-Valibot Standard Schema (e.g. an ArkType-style callable, or any
 *        schema without `.parse`) was never validated: Flue got the passthrough
 *        `input`, the internal validator passed raw args through, and a
 *        side-effecting handler executed with invalid (even ArkErrors-shaped)
 *        arguments.
 *   R2 — a `toModelOutput` that throws produced a SECOND, contradictory audit
 *        outcome record for the same call (success + error, or success + a
 *        `deny/governance_error`), breaking the one-outcome-per-call protocol.
 *   R3 — (regression guard, no fix needed) `InMemoryIdempotencyStore` joins
 *        tenant and key with a NUL byte; this pins that a tenant id containing
 *        a space cannot collide with another tenant's key.
 *   R4 — a side-effecting tool whose ONLY gate was `scope` executed ungated
 *        when the scope function derived no scopes (`[]`/`undefined`):
 *        `Boolean(spec.scope)` satisfied the definition-time gate, but an
 *        empty requested list is vacuously within any allowed list, so the
 *        load-bearing gate evaporated at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernedToolkit } from "../src/toolkit.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { InMemoryIdempotencyStore } from "../src/idempotency.js";
import { toFlueTool } from "../src/flue.js";
import { ScopeViolationError } from "../src/errors.js";
import type { TrustedContext } from "../src/types.js";

const trusted: TrustedContext = {
  actor: { id: "a1", roles: [] },
  tenantId: "acme",
  scopes: ["*"],
};

function setup() {
  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({ context: () => trusted, audit });
  return { audit, toolkit };
}

/** An ArkType-style schema: callable, returns (not throws) its errors, and
 * implements Standard Schema with a non-Valibot vendor. */
function arkLikeSchema() {
  return Object.assign(
    (input: unknown) =>
      typeof (input as { amount?: unknown })?.amount === "number"
        ? input
        : { " arkKind": "errors", summary: "amount must be a number" },
    {
      "~standard": {
        version: 1,
        vendor: "arktype",
        validate: (input: unknown) =>
          typeof (input as { amount?: unknown })?.amount === "number"
            ? { value: input }
            : { issues: [{ message: "amount must be a number" }] },
      },
    },
  );
}

// --- R1: non-Valibot Standard Schemas must be validated internally ----------

test("R1: invalid args against an ArkType-style standard schema are rejected, not executed", async () => {
  const { audit, toolkit } = setup();
  let executed = 0;
  const tool = toFlueTool(
    toolkit.defineGovernedTool({
      name: "refund",
      description: "d",
      parameters: arkLikeSchema(),
      sideEffect: true,
      scope: () => "x",
      execute: () => {
        executed += 1;
        return "ok";
      },
    }),
  );

  await assert.rejects(
    tool.run({ input: { amount: "1e6; DROP" } }),
    /amount must be a number/,
  );
  assert.equal(executed, 0);
  const entries = await audit.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decision, "deny");
  assert.match(entries[0]!.error!, /^invalid_arguments:/);
});

test("R1: valid args against a standard schema pass through the validated value", async () => {
  const { toolkit } = setup();
  const tool = toFlueTool(
    toolkit.defineGovernedTool<{ amount: number }, string>({
      name: "refund",
      description: "d",
      parameters: arkLikeSchema(),
      sideEffect: true,
      scope: () => "x",
      execute: (a) => `refunded ${a.amount}`,
    }),
  );
  assert.equal(await tool.run({ input: { amount: 5 } }), "refunded 5");
});

test("R1: an async standard-schema validate is awaited", async () => {
  const { toolkit } = setup();
  const schema = {
    "~standard": {
      version: 1,
      vendor: "custom",
      validate: async (input: unknown) =>
        (input as { ok?: unknown })?.ok === true
          ? { value: input }
          : { issues: [{ message: "not ok" }] },
    },
  };
  const tool = toolkit.defineGovernedTool({
    name: "t",
    description: "d",
    parameters: schema,
    execute: () => "ran",
  });
  await assert.rejects(tool.execute({ ok: false }), /not ok/);
  assert.equal(await tool.execute({ ok: true }), "ran");
});

// --- R2: exactly one outcome record even when toModelOutput throws ----------

test("R2: toModelOutput throwing leaves exactly one outcome record (plain path)", async () => {
  const { audit, toolkit } = setup();
  const tool = toolkit.defineGovernedTool({
    name: "read",
    description: "d",
    execute: () => ({ ok: true }),
    toModelOutput: () => {
      throw new Error("shaping bug");
    },
  });
  await assert.rejects(tool.execute({}), /shaping bug/);
  const entries = await audit.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.outcome, "success");
});

test("R2: toModelOutput throwing leaves intent + one outcome (idempotent side effect)", async () => {
  const { audit, toolkit } = setup();
  let shapeCalls = 0;
  const tool = toolkit.defineGovernedTool<{ id: string }, string>({
    name: "write",
    description: "d",
    sideEffect: true,
    scope: () => "x",
    idempotency: { key: (a) => a.id },
    execute: () => "done",
    toModelOutput: () => {
      shapeCalls += 1;
      throw new Error("shaping bug");
    },
  });

  await assert.rejects(tool.execute({ id: "k1" }), /shaping bug/);
  let entries = await audit.entries();
  assert.deepEqual(
    entries.map((e) => e.outcome),
    ["executing", "success"],
  );

  // A retry replays (the side effect completed); the shaping bug still throws,
  // and the replay writes exactly one more record.
  await assert.rejects(tool.execute({ id: "k1" }), /shaping bug/);
  entries = await audit.entries();
  assert.deepEqual(
    entries.map((e) => e.outcome),
    ["executing", "success", "replayed"],
  );
  assert.equal(shapeCalls, 2);
});

// --- R3: tenant/key composite cannot collide across tenants -----------------

test("R3: a tenant id containing a space cannot collide with another tenant's key", async () => {
  const store = new InMemoryIdempotencyStore();
  await store.begin("acme prod", "x");
  await store.complete("acme prod", "x", "tenant-A-result");

  // Pre-fix these mapped to the same composite id ("acme prod x") and replayed
  // tenant A's result into tenant B.
  const begin = await store.begin("acme", "prod x");
  assert.equal(begin.status, "started");
  assert.equal(await store.get("acme prod", "x").then((r) => r?.result), "tenant-A-result");
});

// --- R4: an empty derived scope must not un-gate a scope-only side effect ---

test("R4: side-effect tool gated only by scope is denied when scope derives nothing", async () => {
  const { audit, toolkit } = setup();
  let ran = 0;
  const tool = toolkit.defineGovernedTool({
    name: "wire_money",
    description: "d",
    sideEffect: true,
    scope: () => [],
    execute: () => {
      ran += 1;
      return "sent";
    },
  });

  await assert.rejects(tool.execute({ to: "attacker" }), ScopeViolationError);
  assert.equal(ran, 0);
  const entries = await audit.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decision, "deny");
  assert.equal(entries[0]!.error, "scope_violation");
});

test("R4: a scope function returning undefined is denied the same way", async () => {
  const { toolkit } = setup();
  const tool = toolkit.defineGovernedTool<{ id?: string }, string>({
    name: "wire_money",
    description: "d",
    sideEffect: true,
    scope: (a) => (a.id ? `account:${a.id}` : (undefined as unknown as string)),
    execute: () => "sent",
  });
  await assert.rejects(tool.execute({}), ScopeViolationError);
  // The legitimate, non-empty path still works.
  assert.equal(await tool.execute({ id: "7" }), "sent");
});

test("R4: empty derived scope is fine when another gate is declared", async () => {
  const { toolkit } = setup();
  const tool = toolkit.defineGovernedTool({
    name: "wire_money",
    description: "d",
    sideEffect: true,
    scope: () => [],
    authorize: { anchor: "caller", check: () => true },
    execute: () => "sent",
  });
  assert.equal(await tool.execute({}), "sent");
});

test("R4: non-side-effect tools may still derive no scopes", async () => {
  const { toolkit } = setup();
  const tool = toolkit.defineGovernedTool({
    name: "lookup",
    description: "d",
    scope: () => [],
    execute: () => "found",
  });
  assert.equal(await tool.execute({}), "found");
});
