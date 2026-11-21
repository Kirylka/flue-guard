import { test } from "node:test";
import assert from "node:assert/strict";
import { toFlueTool } from "../src/flue.js";
import { createGovernedToolkit } from "../src/toolkit.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { ApprovalDeniedError, GovernanceConfigError } from "../src/errors.js";
import type { ApprovalAdapter } from "../src/approval.js";
import type { TrustedContext } from "../src/types.js";

const ctx: TrustedContext = { actor: { id: "u-1", roles: [] }, tenantId: "t" };

function toolkit(approval?: ApprovalAdapter) {
  const audit = new InMemoryAuditLog();
  return { audit, gov: createGovernedToolkit({ audit, approval, context: () => ctx }) };
}

test("a pending approval ends the Flue turn with a plain result, not an error", async () => {
  const { audit, gov } = toolkit({
    request: async () => ({ approved: false, pending: true, ref: "ticket-9" }),
  });
  let runs = 0;
  const tool = toFlueTool(gov.defineGovernedTool({
    name: "refund",
    description: "r",
    sideEffect: true,
    approval: () => "refund over $50",
    execute: () => { runs++; return "done"; },
  }));
  const result = await tool.run({ data: {}, toolCallId: "call-1" });
  assert.deepEqual(result, {
    output: { status: "pending_approval", tool: "refund", ref: "ticket-9", reason: "refund over $50" },
    terminate: true,
  });
  assert.equal(runs, 0);
  const last = (await audit.entries()).at(-1)!;
  assert.equal(last.outcome, "pending");
  assert.equal(last.toolCallId, "call-1");
});

test("other governance errors still reach Flue as thrown errors", async () => {
  const { gov } = toolkit({ request: async () => ({ approved: false, reason: "no" }) });
  const tool = toFlueTool(gov.defineGovernedTool({
    name: "refund", description: "r", sideEffect: true, approval: true, execute: () => "done",
  }));
  await assert.rejects(tool.run({ data: {} }), ApprovalDeniedError);
});

test("the direct execute path still throws ApprovalPendingError", async () => {
  const { gov } = toolkit({ request: async () => ({ approved: false, pending: true }) });
  const tool = gov.defineGovernedTool({
    name: "refund", description: "r", sideEffect: true, approval: true, execute: () => "done",
  });
  await assert.rejects(tool.execute({}), { code: "approval_pending" });
});

test("toolCallId reaches the handler, the idempotency key and every audit entry", async () => {
  const { audit, gov } = toolkit();
  const seen: unknown[] = [];
  const tool = toFlueTool(gov.defineGovernedTool<{ id: string }, string>({
    name: "send",
    description: "s",
    sideEffect: true,
    unsafeAllowUnauthorized: true,
    idempotency: { key: (a, c) => { seen.push(c.toolCallId); return `${c.toolCallId}:${a.id}`; } },
    execute: (_a, c) => { seen.push(c.toolCallId); return "ok"; },
  }));
  await tool.run({ data: { id: "x" }, toolCallId: "call-7" });
  // Flue re-running the same call replays it.
  await tool.run({ data: { id: "x" }, toolCallId: "call-7" });
  assert.deepEqual(seen, ["call-7", "call-7", "call-7"]);
  const entries = await audit.entries();
  assert.deepEqual(entries.map((e) => e.outcome), ["executing", "success", "replayed"]);
  assert.ok(entries.every((e) => e.toolCallId === "call-7"));
  assert.equal(entries[0]!.idempotencyKey, "call-7:x");
  assert.deepEqual(await audit.verify(), { valid: true });
});

test("entries carry no toolCallId when the host gives none", async () => {
  const { audit, gov } = toolkit();
  const tool = gov.defineGovernedTool({ name: "read", description: "r", execute: (_a, c) => c.toolCallId ?? "none" });
  assert.equal(await tool.execute({}), "none");
  assert.equal("toolCallId" in (await audit.entries())[0]!, false);
});

test("timeoutMs is validated and forwarded to Flue", () => {
  const { gov } = toolkit();
  const timed = toFlueTool(gov.defineGovernedTool({ name: "a", description: "a", timeoutMs: 1500, execute: () => 1 }));
  assert.equal(timed.timeoutMs, 1500);
  const untimed = toFlueTool(gov.defineGovernedTool({ name: "b", description: "b", execute: () => 1 }));
  assert.equal("timeoutMs" in untimed, false);
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(
      () => gov.defineGovernedTool({ name: "c", description: "c", timeoutMs, execute: () => 1 }),
      GovernanceConfigError,
    );
  }
});
