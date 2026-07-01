/**
 * Real integration test against @flue/runtime (v1.0.0-beta.9) and valibot.
 *
 * This does NOT mock Flue: it builds a governed tool and runs it through Flue's
 * actual `defineTool`, which (as of beta.3) requires the `input`/`output`/`run`
 * contract and rejects the legacy `parameters`/`execute` shape with
 * `ToolLegacyDefinitionError`. It proves the emitted tool is accepted, exposes
 * the real Valibot `input` schema Flue validates against, and routes `run(...)`
 * through our governance pipeline end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import {
  ContextStore,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createGovernedToolkit,
  toFlueTool,
  type FlueDefineTool,
} from "./_all.js";

// Flue's generic `defineTool` is structurally compatible with the dependency-free
// `FlueDefineTool` seam (the same cast `govern()` performs in production). This
// still runs the REAL `defineTool` at call time — proving it accepts our tool
// and never throws `ToolLegacyDefinitionError`.
const defineFlueTool = defineTool as unknown as FlueDefineTool;
import { GovernanceConfigError, ScopeViolationError } from "../src/errors.js";
import type { TrustedContext } from "../src/types.js";

interface RefundArgs {
  customerId: string;
  amount: number;
  refundId: string;
}

function build() {
  const ctx = new ContextStore();
  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({
    context: ctx.resolver(),
    audit,
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  let refunds = 0;

  const governed = toolkit.defineGovernedTool<RefundArgs, string>({
    name: "issue_refund",
    description: "Issue a refund to a customer.",
    parameters: v.object({
      customerId: v.string(),
      amount: v.number(),
      refundId: v.string(),
    }),
    sideEffect: true,
    scope: (a) => `customer:${a.customerId}`,
    idempotency: { key: (a) => `refund:${a.refundId}` },
    execute: (a, gctx) => {
      refunds += 1;
      return `refunded $${a.amount} to ${a.customerId} for ${gctx.tenantId}`;
    },
  });

  // The real Flue normalization step.
  const tool = defineFlueTool(toFlueTool(governed));
  return { ctx, audit, tool, refunds: () => refunds };
}

const acme: TrustedContext = {
  actor: { id: "agent-1", roles: ["support_agent"] },
  tenantId: "acme",
  scopes: ["customer:c-100"],
};

test("Flue defineTool accepts the governed tool and preserves name/description/input", () => {
  const { tool } = build();
  assert.equal(tool.name, "issue_refund");
  assert.equal(tool.description, "Issue a refund to a customer.");
  assert.equal(typeof tool.run, "function");
  // The emitted `input` is the real Valibot schema Flue validates against.
  assert.ok(tool.input);
  const inputSchema = tool.input as v.GenericSchema;
  assert.doesNotThrow(() =>
    v.parse(inputSchema, { customerId: "c-1", amount: 1, refundId: "r" }),
  );
});

test("valid call: governance runs and returns the structured result", async () => {
  const app = build();
  const out = await app.ctx.run(acme, () =>
    app.tool.run({ input: { customerId: "c-100", amount: 40, refundId: "r-1" } }),
  );
  assert.equal(typeof out, "string");
  assert.match(out as string, /refunded \$40 to c-100 for acme/);
  assert.equal(app.refunds(), 1);
});

test("the emitted Valibot input schema rejects wrong-typed args (Flue's gate)", () => {
  const { tool } = build();
  // Flue validates the model's arguments against `input` before invoking `run`.
  assert.throws(() =>
    v.parse(tool.input as v.GenericSchema, {
      customerId: "c-100",
      amount: "lots", // wrong type
      refundId: "r-1",
    }),
  );
});

test("out-of-scope call is blocked by governance even with valid args", async () => {
  const app = build();
  await app.ctx.run(acme, async () => {
    await assert.rejects(
      () =>
        app.tool.run({
          input: { customerId: "c-999", amount: 10, refundId: "r-2" },
        }),
      ScopeViolationError,
    );
  });
  assert.equal(app.refunds(), 0);
});

test("duplicate refund replays through the real tool; side effect runs once", async () => {
  const app = build();
  await app.ctx.run(acme, async () => {
    const a = await app.tool.run({
      input: { customerId: "c-100", amount: 40, refundId: "r-1" },
    });
    const b = await app.tool.run({
      input: { customerId: "c-100", amount: 40, refundId: "r-1" },
    });
    assert.equal(a, b);
  });
  assert.equal(app.refunds(), 1);

  const entries = await app.audit.entries();
  assert.equal(entries.at(-1)!.outcome, "replayed");
  assert.deepEqual(await app.audit.verify(), { valid: true });
});

test("toolkit.tool() one-call helper infers args and returns a Flue tool", async () => {
  const ctx = new ContextStore();
  const audit = new InMemoryAuditLog();
  // defineTool injected -> the one-call ergonomic path is available.
  const toolkit = createGovernedToolkit({
    context: ctx,
    audit,
    defineTool: defineFlueTool,
  });

  const refund = toolkit.tool({
    name: "issue_refund",
    description: "Issue a refund to a customer.",
    parameters: v.object({ customerId: v.string(), amount: v.number() }),
    sideEffect: true,
    // `a` is inferred as { customerId: string; amount: number } — no generic.
    scope: (a) => `customer:${a.customerId}`,
    execute: (a, c) => `refunded ${a.amount} to ${a.customerId} for ${c.tenantId}`,
  });

  assert.equal(refund.name, "issue_refund");
  const out = await ctx.run(
    { actor: { id: "u", roles: [] }, tenantId: "acme", scopes: ["customer:c-1"] },
    () => refund.run({ input: { customerId: "c-1", amount: 40 } }),
  );
  assert.equal(out, "refunded 40 to c-1 for acme");
});

test("toolkit.tool() throws if defineTool wasn't provided", () => {
  const toolkit = createGovernedToolkit({
    context: new ContextStore(),
    audit: new InMemoryAuditLog(),
  });
  assert.throws(
    () =>
      toolkit.tool({
        name: "x",
        description: "x",
        parameters: v.object({ a: v.string() }),
        execute: () => "ok",
      }),
    GovernanceConfigError,
  );
});
