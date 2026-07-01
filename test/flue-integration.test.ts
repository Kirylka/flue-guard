/**
 * Real integration test against @flue/runtime (v1.0.0-beta.1) and valibot.
 *
 * This does NOT mock Flue: it builds a governed tool, runs it through Flue's
 * actual `defineTool` (which converts the valibot schema to JSON Schema and
 * wraps execute to validate model arguments), and then invokes the normalized
 * tool the way a session would. It proves the integration holds end to end:
 * Flue's schema validation runs first, then our governance pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, ToolInputValidationError } from "@flue/runtime";
import * as v from "valibot";
import {
  ContextStore,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createGovernedToolkit,
  toFlueTool,
} from "./_all.js";
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
  const tool = defineTool(toFlueTool(governed));
  return { ctx, audit, tool, refunds: () => refunds };
}

const acme: TrustedContext = {
  actor: { id: "agent-1", roles: ["support_agent"] },
  tenantId: "acme",
  scopes: ["customer:c-100"],
};

test("Flue defineTool accepts the governed tool and preserves name/description", () => {
  const { tool } = build();
  assert.equal(tool.name, "issue_refund");
  assert.equal(tool.description, "Issue a refund to a customer.");
  assert.equal(typeof tool.execute, "function");
});

test("valid call: Flue validates args, governance runs, returns a string", async () => {
  const app = build();
  const out = await app.ctx.run(acme, () =>
    app.tool.execute({ customerId: "c-100", amount: 40, refundId: "r-1" }),
  );
  assert.equal(typeof out, "string");
  assert.match(out as string, /refunded \$40 to c-100 for acme/);
  assert.equal(app.refunds(), 1);
});

test("invalid args are rejected by Flue/valibot before our handler runs", async () => {
  const app = build();
  await app.ctx.run(acme, async () => {
    await assert.rejects(
      () =>
        app.tool.execute({
          customerId: "c-100",
          amount: "lots", // wrong type
          refundId: "r-1",
        }),
      ToolInputValidationError,
    );
  });
  assert.equal(app.refunds(), 0);
});

test("out-of-scope call is blocked by governance even with valid args", async () => {
  const app = build();
  await app.ctx.run(acme, async () => {
    await assert.rejects(
      () =>
        app.tool.execute({ customerId: "c-999", amount: 10, refundId: "r-2" }),
      ScopeViolationError,
    );
  });
  assert.equal(app.refunds(), 0);
});

test("duplicate refund replays through the real tool; side effect runs once", async () => {
  const app = build();
  await app.ctx.run(acme, async () => {
    const a = await app.tool.execute({
      customerId: "c-100",
      amount: 40,
      refundId: "r-1",
    });
    const b = await app.tool.execute({
      customerId: "c-100",
      amount: 40,
      refundId: "r-1",
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
  const toolkit = createGovernedToolkit({ context: ctx, audit, defineTool });

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
    () => refund.execute({ customerId: "c-1", amount: 40 }),
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
