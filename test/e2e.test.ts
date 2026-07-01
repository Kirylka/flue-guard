/**
 * End-to-end tests: drive the whole stack the way a host would — a trusted
 * context bound for the duration of a run, governed tools invoked by name, a
 * file-backed tamper-evident audit log, and a real idempotency store.
 *
 * Mirrors the README/example: a `reset_password` tool gated by `authorize`
 * (the check Meta's High Touch Support was missing) and an `issue_refund` tool
 * gated by `scope` + `approval` + `idempotency`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextStore,
  HashChainAuditLog,
  InMemoryIdempotencyStore,
  createGovernedToolkit,
  caller,
  verifyChain,
  type ApprovalAdapter,
  type AuditEntry,
  type FlueCompatibleTool,
  type TrustedContext,
} from "./_all.js";
import {
  AuthorizationDeniedError,
  GovernanceConfigError,
  ScopeViolationError,
} from "../src/errors.js";

function buildAgent(auditPath: string) {
  const contextStore = new ContextStore();
  const audit = new HashChainAuditLog({ path: auditPath });
  const approvals: ApprovalAdapter = {
    async request(req) {
      const amount = (req.args as { amount: number }).amount;
      return amount <= 200
        ? { approved: true, approver: "supervisor" }
        : { approved: false, reason: "too big" };
    },
  };
  const toolkit = createGovernedToolkit({
    context: contextStore.resolver(),
    audit,
    idempotencyStore: new InMemoryIdempotencyStore(),
    approval: approvals,
  });

  let resetLinks = 0;
  let refundsIssued = 0;

  const resetPassword = toolkit.defineGovernedTool<{ accountId: string }>({
    name: "reset_password",
    description: "send a reset link",
    sideEffect: true,
    // Caller may only reset an account they control.
    authorize: caller((a, ctx) => a.accountId === ctx.actor.id),
    idempotency: { key: (a) => `reset:${a.accountId}` },
    execute: (a) => {
      resetLinks += 1;
      return `reset link sent for ${a.accountId}`;
    },
  });

  const refund = toolkit.defineGovernedTool<{
    customerId: string;
    amount: number;
    refundId: string;
  }>({
    name: "issue_refund",
    description: "refund",
    sideEffect: true,
    requireRoles: ["support_agent"],
    scope: (a) => `customer:${a.customerId}`,
    idempotency: { key: (a) => `refund:${a.customerId}:${a.refundId}` },
    approval: (a) => (a.amount > 50 ? "over $50" : false),
    execute: () => {
      refundsIssued += 1;
      return "refunded";
    },
  });

  const tools = new Map<string, FlueCompatibleTool>([
    [resetPassword.name, resetPassword],
    [refund.name, refund],
  ]);

  const runAs = <T>(ctx: TrustedContext, fn: () => Promise<T>) =>
    contextStore.run(ctx, fn);
  const call = (name: string, args: unknown) => tools.get(name)!.execute(args);

  return { toolkit, audit, runAs, call, resets: () => resetLinks, refunds: () => refundsIssued };
}

const principal: TrustedContext = {
  actor: { id: "c-100", roles: ["support_agent"] },
  tenantId: "acme",
  scopes: ["customer:c-100"],
};

test("e2e: a full run enforces authorize, scope, idempotency and audit", async () => {
  const path = join(tmpdir(), `e2e-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const app = buildAgent(path);

    await app.runAs(principal, async () => {
      // reset own account -> allowed
      await app.call("reset_password", { accountId: "c-100" });
      // reset someone else's account -> blocked by authorize (the Meta case)
      await assert.rejects(
        app.call("reset_password", { accountId: "victim" }),
        AuthorizationDeniedError,
      );
      // refund self -> allowed
      await app.call("issue_refund", {
        customerId: "c-100",
        amount: 40,
        refundId: "r-1",
      });
      // duplicate refund -> replay, must NOT re-issue
      await app.call("issue_refund", {
        customerId: "c-100",
        amount: 40,
        refundId: "r-1",
      });
      // cross-customer -> blocked by scope
      await assert.rejects(
        app.call("issue_refund", {
          customerId: "c-999",
          amount: 10,
          refundId: "r-9",
        }),
        ScopeViolationError,
      );
    });

    assert.equal(app.resets(), 1, "one reset link, not two");
    assert.equal(app.refunds(), 1, "refund runs exactly once");

    // Side-effecting executions write an `executing` intent record before the
    // outcome; denials and replays write a single record.
    const entries = await app.audit.entries();
    assert.deepEqual(
      entries.map((e) => `${e.tool}:${e.decision}/${e.outcome}`),
      [
        "reset_password:allow/executing",
        "reset_password:allow/success",
        "reset_password:deny/denied",
        "issue_refund:allow/executing",
        "issue_refund:allow/success",
        "issue_refund:allow/replayed",
        "issue_refund:deny/denied",
      ],
    );
    assert.equal(entries[2]!.error, "authorization_denied");
    assert.equal(entries[6]!.error, "scope_violation");
    assert.deepEqual(await app.audit.verify(), { valid: true });
  } finally {
    rmSync(path, { force: true });
  }
});

test("e2e: defining an ungated side-effect tool is refused", () => {
  const path = join(tmpdir(), `e2e-guard-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const app = buildAgent(path);
    assert.throws(
      () =>
        app.toolkit.defineGovernedTool({
          name: "delete_account",
          description: "danger",
          sideEffect: true,
          execute: () => "gone",
        }),
      GovernanceConfigError,
    );
  } finally {
    rmSync(path, { force: true });
  }
});

test("e2e: tampering with the persisted audit file is detected", async () => {
  const path = join(tmpdir(), `e2e-tamper-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const app = buildAgent(path);
    await app.runAs(principal, async () => {
      await app.call("reset_password", { accountId: "c-100" });
      await app.call("issue_refund", {
        customerId: "c-100",
        amount: 40,
        refundId: "r-1",
      });
    });
    assert.deepEqual(await app.audit.verify(), { valid: true });

    // Attacker edits the refund record on disk.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const tampered = lines.map((line) => {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.tool === "issue_refund") entry.args = { customerId: "c-evil" };
      return JSON.stringify(entry);
    });
    writeFileSync(path, tampered.join("\n") + "\n");

    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditEntry);
    const firstRefundIdx = entries.findIndex((e) => e.tool === "issue_refund");
    const result = await verifyChain(entries);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, firstRefundIdx);
  } finally {
    rmSync(path, { force: true });
  }
});

test("e2e: same idempotency key under two tenants does not collide", async () => {
  const path = join(tmpdir(), `e2e-tenant-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const app = buildAgent(path);
    const mk = (tenantId: string): TrustedContext => ({
      actor: { id: "agent", roles: ["support_agent"] },
      tenantId,
      scopes: ["customer:c-1"],
    });

    await app.runAs(mk("acme"), () =>
      app.call("issue_refund", { customerId: "c-1", amount: 10, refundId: "r" }),
    );
    await app.runAs(mk("globex"), () =>
      app.call("issue_refund", { customerId: "c-1", amount: 10, refundId: "r" }),
    );

    // Different tenants -> both execute (no replay across tenant boundary).
    assert.equal(app.refunds(), 2);
  } finally {
    rmSync(path, { force: true });
  }
});
