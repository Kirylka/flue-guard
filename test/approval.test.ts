import { test } from "node:test";
import assert from "node:assert/strict";
import { autoApprove, type ApprovalAdapter } from "../src/approval.js";
import type { TrustedContext } from "../src/types.js";

const ctx: TrustedContext = {
  actor: { id: "a1", roles: ["agent"] },
  tenantId: "acme",
  scopes: [],
};

test("autoApprove approves every request", async () => {
  const decision = await autoApprove.request({
    tool: "refund",
    args: { amount: 100 },
    ctx,
  });
  assert.equal(decision.approved, true);
  assert.equal(decision.approver, "auto");
});

test("a custom adapter can deny with a reason", async () => {
  const denying: ApprovalAdapter = {
    async request() {
      return { approved: false, reason: "over limit" };
    },
  };
  const decision = await denying.request({ tool: "refund", args: {}, ctx });
  assert.equal(decision.approved, false);
  assert.equal(decision.reason, "over limit");
});
