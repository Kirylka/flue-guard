/**
 * Example: a customer-support agent governed by flue-guard.
 *
 * Runnable with zero external dependencies — a tiny `init()` mock stands in for
 * Flue so you can see the guarantees without a model. It mirrors the README:
 *
 *   - reset_password is gated by `authorize` (the check Meta's High Touch
 *     Support was missing): you may only reset an account you control.
 *   - issue_refund is gated by `scope` + `approval` + `idempotency`.
 *   - defining a side-effecting tool with NO gate is refused outright.
 *
 * Run:  npm run example
 */

import {
  GovernanceConfigError,
  createGovernedToolkit,
  type ApprovalAdapter,
  type FlueCompatibleTool,
  type TrustedContext,
} from "../src/index.js";
import { InMemoryAuditLog } from "../src/testing.js";

// --- Fake downstream systems with real side effects we must protect. -------
let resetLinksSent = 0;
let refundsIssued = 0;

const accounts = {
  // The ownership check the agent must pass before touching an account.
  isControlledBy(accountId: string, actorId: string) {
    return accountId === actorId;
  },
  sendResetLink(accountId: string) {
    resetLinksSent += 1;
    return { accountId, sent: true };
  },
};

const billing = {
  refund(tenantId: string, customerId: string, amount: number) {
    refundsIssued += 1;
    return { customerId, amount, settled: true };
  },
};

// --- Wiring -----------------------------------------------------------------
const audit = new InMemoryAuditLog();

const approvals: ApprovalAdapter = {
  async request(req) {
    const amount = (req.args as { amount: number }).amount;
    return amount <= 200
      ? { approved: true, approver: "supervisor@support" }
      : { approved: false, reason: "exceeds supervisor limit" };
  },
};

const toolkit = createGovernedToolkit({
  audit,                 // built-in context store + in-memory idempotency by default
  approval: approvals,
});

// --- The fail-closed guard: you can't define an ungated side effect. --------
try {
  toolkit.defineGovernedTool({
    name: "delete_account",
    description: "Permanently delete an account.",
    sideEffect: true,
    execute: () => ({ deleted: true }),
  });
} catch (err) {
  if (err instanceof GovernanceConfigError) {
    console.log(`🚫 Refused to define an ungated side-effect tool: ${err.message}\n`);
  }
}

// --- Governed tools ---------------------------------------------------------
const resetPassword = toolkit.defineGovernedTool<{ accountId: string }>({
  name: "reset_password",
  description: "Send a password reset link for an account.",
  sideEffect: true,
  // The check High Touch Support never made: caller must control the account.
  authorize: (a, ctx) => accounts.isControlledBy(a.accountId, ctx.actor.id),
  idempotency: { key: (a) => `reset:${a.accountId}` },
  execute: (a) => {
    accounts.sendResetLink(a.accountId);
    return `Sent a reset link for ${a.accountId}.`;
  },
});

const issueRefund = toolkit.defineGovernedTool<{
  customerId: string;
  amount: number;
  refundId: string;
}>({
  name: "issue_refund",
  description: "Issue a refund to a customer.",
  sideEffect: true,
  scope: (a) => `customer:${a.customerId}`,
  idempotency: { key: (a) => `refund:${a.refundId}` },
  approval: (a) => (a.amount > 50 ? `refund of $${a.amount} exceeds $50` : false),
  execute: (a, ctx) => {
    const r = billing.refund(ctx.tenantId, a.customerId, a.amount);
    return `Refunded $${r.amount} to ${r.customerId}.`;
  },
});

// --- A tiny stand-in for Flue's defineAgent/init. ---------------------------
function init(config: { tools: FlueCompatibleTool[] }) {
  const byName = new Map(config.tools.map((t) => [t.name, t]));
  return {
    async call(name: string, args: unknown) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return tool.execute(args);
    },
  };
}

const agent = init({ tools: [resetPassword, issueRefund] });

// The verified caller for this conversation: customer c-100, acting for
// themselves. Bound by us from auth — never by the model.
const principal: TrustedContext = {
  actor: { id: "c-100", roles: ["customer"] },
  tenantId: "acme-app",
  scopes: ["customer:c-100"], // may only act on their own customer record
  requestId: "req-1",
};

async function tryCall(label: string, name: string, args: unknown) {
  try {
    const result = await toolkit.run(principal, () => agent.call(name, args));
    console.log(`✅ ${label}: ${JSON.stringify(result)}`);
  } catch (err) {
    console.log(
      `⛔ ${label}: ${(err as Error).constructor.name} — ${(err as Error).message}`,
    );
  }
}

// --- Scenarios --------------------------------------------------------------
async function main() {
  console.log("=== customer-support agent (governed) ===\n");

  await tryCall("reset my own account", "reset_password", { accountId: "c-100" });
  await tryCall("reset SOMEONE ELSE's account (the Meta case)", "reset_password", {
    accountId: "celebrity-account",
  });

  await tryCall("refund $40 (under approval threshold)", "issue_refund", {
    customerId: "c-100",
    amount: 40,
    refundId: "r-1",
  });
  await tryCall("DUPLICATE refund $40 (should replay, not re-issue)", "issue_refund", {
    customerId: "c-100",
    amount: 40,
    refundId: "r-1",
  });
  await tryCall("refund $150 (needs approval → approved)", "issue_refund", {
    customerId: "c-100",
    amount: 150,
    refundId: "r-2",
  });
  await tryCall("refund $500 (needs approval → denied)", "issue_refund", {
    customerId: "c-100",
    amount: 500,
    refundId: "r-3",
  });
  await tryCall("refund ANOTHER customer (out of scope → blocked)", "issue_refund", {
    customerId: "c-999",
    amount: 10,
    refundId: "r-4",
  });

  console.log(
    `\nReal side effects: ${resetLinksSent} reset link(s), ${refundsIssued} refund(s).`,
  );
  console.log("(1 reset for c-100; 2 refunds — r-1 once despite the duplicate, and r-2.)\n");

  console.log("Audit trail:");
  for (const e of await audit.entries()) {
    console.log(
      `  #${e.seq} ${e.tool} ${e.decision}/${e.outcome}` +
        (e.error ? ` (${e.error})` : "") +
        (e.approver ? ` approver=${e.approver}` : ""),
    );
  }

  const v = await audit.verify();
  console.log(
    `\nAudit chain: ${v.valid ? "VALID ✅" : `BROKEN at ${v.brokenAt} ❌`}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
