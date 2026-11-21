import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernedToolkit } from "../src/toolkit.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { MissingContextError } from "../src/errors.js";
import type { TrustedContext } from "../src/types.js";

const toContext = (a: Record<string, string>): TrustedContext | undefined =>
  a.actorId && a.tenantId ? { actor: { id: a.actorId, roles: [] }, tenantId: a.tenantId } : undefined;

function setup() {
  const audit = new InMemoryAuditLog();
  const gov = createGovernedToolkit({ audit });
  const define = (g: typeof gov) => g.defineGovernedTool({
    name: "whoami", description: "w", execute: (_a, ctx) => `${ctx.tenantId}/${ctx.actor.id}`,
  });
  return { audit, gov, define };
}

test("withSignal binds the caller from authenticated signal attributes", async () => {
  const { gov, define } = setup();
  const bound = gov.withSignal({ kind: "signal", attributes: { actorId: "u-1", tenantId: "acme" } }, toContext);
  assert.equal(await define(bound).execute({}), "acme/u-1");
});

test("withSignal refuses tool calls, but not the render, when no caller is named", async () => {
  const { audit, gov, define } = setup();
  const deliveries = [
    { kind: "user" },
    { kind: "signal" },
    { kind: "signal", attributes: { actorId: "u-1" } },
  ] as const;
  for (const delivery of deliveries) {
    const bound = gov.withSignal(delivery, toContext);
    await assert.rejects(define(bound).execute({}), MissingContextError);
  }
  const entries = await audit.entries();
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.decision === "deny" && e.error === "missing_context"));
});

test("withSignal reports a throwing mapper at call time and logs it", async () => {
  const { audit, gov, define } = setup();
  const bound = gov.withSignal({ kind: "signal", attributes: { actorId: "u-1" } }, () => {
    throw new Error("bad mapper");
  });
  await assert.rejects(define(bound).execute({}), /bad mapper/);
  assert.equal((await audit.entries())[0]!.error, "bad mapper");
});
