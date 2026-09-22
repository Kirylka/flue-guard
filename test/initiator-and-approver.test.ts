/**
 * Two identities on a session (who acts now vs who started it) and the check
 * that decides whether a given approver may approve a given call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernedToolkit, caller, InMemoryAuditLog } from "./_all.js";
import { ApprovalDeniedError } from "../src/errors.js";
import type { ApprovalAdapter } from "../src/approval.js";

const actor = { id: "agent-1", roles: [] };

function approvedBy(approver: string | undefined): ApprovalAdapter {
  return { request: async () => ({ approved: true, approver }) };
}

test("a policy can compare the acting caller with the one who started the session", async () => {
  const audit = new InMemoryAuditLog();
  const gov = createGovernedToolkit({ audit });
  const seen: Array<string | undefined> = [];
  const tool = gov.defineGovernedTool<{ note: string }>({
    name: "add_note",
    description: "add a note",
    sideEffect: true,
    // The session was opened by one person; someone else is acting in it now.
    authorize: caller((_a, ctx) => {
      seen.push(ctx.initiator?.id);
      return ctx.initiator === undefined || ctx.initiator.id === ctx.actor.id;
    }),
    execute: () => "ok",
  });

  await gov.run({ actor, tenantId: "acme", initiator: { id: "agent-1" } }, () =>
    tool.execute({ note: "same person" }),
  );
  await gov.run({ actor, tenantId: "acme", initiator: { id: "someone-else" } }, async () => {
    await assert.rejects(() => tool.execute({ note: "handed over" }), { code: "authorization_denied" });
  });
  assert.deepEqual(seen, ["agent-1", "someone-else"]);
});

test("the audit records the initiator when the session carries one", async () => {
  const audit = new InMemoryAuditLog();
  const gov = createGovernedToolkit({ audit });
  const tool = gov.defineGovernedTool({
    name: "read_note",
    description: "read a note",
    authorize: caller(() => true),
    execute: () => "ok",
  });

  await gov.run({ actor, tenantId: "acme", initiator: { id: "opened-by" } }, () => tool.execute({}));
  await gov.run({ actor, tenantId: "acme" }, () => tool.execute({}));

  const [withInitiator, without] = await audit.entries();
  assert.equal(withInitiator?.actorId, "agent-1");
  assert.equal(withInitiator?.initiatorId, "opened-by");
  assert.equal(without?.initiatorId, undefined);
});

test("canApprove refuses an approver the tool does not accept", async () => {
  const audit = new InMemoryAuditLog();
  const gov = createGovernedToolkit({ audit, approval: approvedBy("agent-1") });
  let ran = false;
  const tool = gov.defineGovernedTool<{ amount: number }>({
    name: "refund",
    description: "refund",
    sideEffect: true,
    approval: true,
    // The person who asked for the refund must not sign it off.
    canApprove: (approver, _args, ctx) => approver !== ctx.actor.id,
    execute: () => {
      ran = true;
      return "ok";
    },
  });

  await gov.run({ actor, tenantId: "acme" }, async () => {
    await assert.rejects(() => tool.execute({ amount: 10 }), ApprovalDeniedError);
  });
  assert.equal(ran, false);
  const entry = (await audit.entries()).at(-1);
  assert.equal(entry?.decision, "deny");
  assert.equal(entry?.error, "approval_denied");
  assert.equal(entry?.approver, "agent-1");
});

test("canApprove lets an accepted approver through and records them", async () => {
  const audit = new InMemoryAuditLog();
  const gov = createGovernedToolkit({ audit, approval: approvedBy("manager-7") });
  const tool = gov.defineGovernedTool<{ amount: number }>({
    name: "refund",
    description: "refund",
    sideEffect: true,
    approval: true,
    canApprove: (approver, _args, ctx) => approver !== ctx.actor.id,
    execute: () => "refunded",
  });

  const result = await gov.run({ actor, tenantId: "acme" }, () => tool.execute({ amount: 10 }));
  assert.equal(result, "refunded");
  assert.equal((await audit.entries()).at(-1)?.approver, "manager-7");
});

test("canApprove without a named approver fails closed", async () => {
  const gov = createGovernedToolkit({
    audit: new InMemoryAuditLog(),
    approval: approvedBy(undefined),
  });
  const tool = gov.defineGovernedTool({
    name: "refund",
    description: "refund",
    sideEffect: true,
    approval: true,
    canApprove: () => true, // would accept anyone — but nobody was named
    execute: () => assert.fail("executed"),
  });

  await gov.run({ actor, tenantId: "acme" }, async () => {
    await assert.rejects(() => tool.execute({}), ApprovalDeniedError);
  });
});

test("canApprove is not consulted when the call needed no approval", async () => {
  const gov = createGovernedToolkit({ audit: new InMemoryAuditLog() });
  const tool = gov.defineGovernedTool({
    name: "read_note",
    description: "read a note",
    authorize: caller(() => true),
    canApprove: () => assert.fail("consulted without an approval step"),
    execute: () => "ok",
  });
  assert.equal(await gov.run({ actor, tenantId: "acme" }, () => tool.execute({})), "ok");
});
