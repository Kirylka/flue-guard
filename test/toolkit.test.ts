import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernedToolkit, caller, trusted } from "../src/toolkit.js";
import { InMemoryAuditLog, type AuditLog } from "../src/audit.js";
import { InMemoryIdempotencyStore } from "../src/idempotency.js";
import { ContextStore } from "../src/context.js";
import {
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalPendingError,
  AuthorizationDeniedError,
  GovernanceConfigError,
  MissingContextError,
  ScopeViolationError,
} from "../src/errors.js";
import type { ApprovalAdapter } from "../src/approval.js";
import type { TrustedContext } from "../src/types.js";

function setup(opts: { approval?: ApprovalAdapter } = {}) {
  const audit = new InMemoryAuditLog();
  const idempotencyStore = new InMemoryIdempotencyStore();
  let ctx: TrustedContext = {
    actor: { id: "a1", roles: ["agent"] },
    tenantId: "acme",
    scopes: ["customer:*"],
  };
  const toolkit = createGovernedToolkit({
    context: () => ctx,
    audit,
    idempotencyStore,
    approval: opts.approval,
  });
  return {
    audit,
    toolkit,
    setCtx: (c: Partial<TrustedContext>) => {
      ctx = { ...ctx, ...c };
    },
  };
}

test("allowed call succeeds, returns result, writes one allow/success entry", async () => {
  const { toolkit, audit } = setup();
  const tool = toolkit.defineGovernedTool({
    name: "lookup",
    description: "look up a customer",
    scope: (a: { customerId: string }) => `customer:${a.customerId}`,
    execute: (a) => ({ found: a.customerId }),
  });

  const result = await tool.execute({ customerId: "c-1" });
  assert.deepEqual(result, { found: "c-1" });

  const entries = await audit.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decision, "allow");
  assert.equal(entries[0]!.outcome, "success");
});

test("out-of-scope call is blocked with ScopeViolationError and audited deny", async () => {
  const { toolkit, audit, setCtx } = setup();
  setCtx({ scopes: ["customer:c-1"] });
  const tool = toolkit.defineGovernedTool({
    name: "refund",
    description: "issue refund",
    sideEffect: true,
    scope: (a: { customerId: string }) => `customer:${a.customerId}`,
    execute: () => ({ ok: true }),
  });

  await assert.rejects(
    () => tool.execute({ customerId: "c-999" }),
    ScopeViolationError,
  );
  const entries = await audit.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decision, "deny");
  assert.equal(entries[0]!.error, "scope_violation");
});

test("missing role is blocked with AccessDeniedError", async () => {
  const { toolkit, setCtx } = setup();
  setCtx({ actor: { id: "a1", roles: ["agent"] } });
  const tool = toolkit.defineGovernedTool({
    name: "close-account",
    description: "close",
    requireRoles: ["admin"],
    execute: () => ({ ok: true }),
  });
  await assert.rejects(() => tool.execute({}), AccessDeniedError);
});

test("idempotent side effect runs once and replays thereafter", async () => {
  const { toolkit, audit } = setup();
  let runs = 0;
  const tool = toolkit.defineGovernedTool({
    name: "refund",
    description: "issue refund",
    sideEffect: true,
    scope: (a: { customerId: string }) => `customer:${a.customerId}`,
    idempotency: { key: (a: { refundId: string }) => `refund:${a.refundId}` },
    execute: (a: { customerId: string; refundId: string }) => {
      runs += 1;
      return { refundId: a.refundId, processed: runs };
    },
  });

  const first = await tool.execute({ customerId: "c-1", refundId: "r-1" });
  const second = await tool.execute({ customerId: "c-1", refundId: "r-1" });

  assert.equal(runs, 1, "handler must run exactly once");
  assert.deepEqual(first, second);

  // First call: intent (executing) + success. Second call: replayed.
  const entries = await audit.entries();
  assert.deepEqual(
    entries.map((e) => e.outcome),
    ["executing", "success", "replayed"],
  );
});

test("handler error is audited as allow/error, key released, error propagated", async () => {
  const { toolkit, audit } = setup();
  let attempts = 0;
  const tool = toolkit.defineGovernedTool({
    name: "refund",
    description: "issue refund",
    sideEffect: true,
    unsafeAllowUnauthorized: true, // this test is about error handling, not auth
    idempotency: { key: () => "refund:r-x" },
    execute: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gateway down");
      return { ok: true };
    },
  });

  await assert.rejects(() => tool.execute({}), /gateway down/);
  const entries = await audit.entries();
  // Intent record first, then the error outcome.
  assert.equal(entries[0]!.outcome, "executing");
  assert.equal(entries[1]!.decision, "allow");
  assert.equal(entries[1]!.outcome, "error");

  // key was released on failure -> a retry executes again (not replayed)
  const retry = await tool.execute({});
  assert.deepEqual(retry, { ok: true });
  assert.equal(attempts, 2);
});

test("approval required but no adapter configured denies (fail-closed)", async () => {
  const { toolkit } = setup(); // no approval adapter
  const tool = toolkit.defineGovernedTool({
    name: "refund",
    description: "issue refund",
    approval: (a: { amount: number }) =>
      a.amount > 50 ? "exceeds $50" : false,
    execute: () => ({ ok: true }),
  });
  await assert.rejects(() => tool.execute({ amount: 100 }), ApprovalDeniedError);
  // under threshold: no approval needed, succeeds
  assert.deepEqual(await tool.execute({ amount: 10 }), { ok: true });
});

test("approval adapter decision is honored and approver recorded", async () => {
  const denying: ApprovalAdapter = {
    async request() {
      return { approved: false, reason: "policy" };
    },
  };
  const r1 = setup({ approval: denying });
  const denied = r1.toolkit.defineGovernedTool({
    name: "refund",
    description: "r",
    approval: true,
    execute: () => ({ ok: true }),
  });
  await assert.rejects(() => denied.execute({}), ApprovalDeniedError);

  const approving: ApprovalAdapter = {
    async request() {
      return { approved: true, approver: "manager@acme" };
    },
  };
  const r2 = setup({ approval: approving });
  const ok = r2.toolkit.defineGovernedTool({
    name: "refund",
    description: "r",
    approval: true,
    execute: () => ({ ok: true }),
  });
  await ok.execute({});
  const entries = await r2.audit.entries();
  assert.equal(entries[0]!.approver, "manager@acme");
});

test("missing context denies with MissingContextError and audits unknown actor", async () => {
  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({
    context: () => {
      throw new MissingContextError();
    },
    audit,
  });
  const tool = toolkit.defineGovernedTool({
    name: "lookup",
    description: "l",
    execute: () => ({ ok: true }),
  });
  await assert.rejects(() => tool.execute({}), MissingContextError);
  const entries = await audit.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.tenantId, "unknown");
  assert.equal(entries[0]!.decision, "deny");
});

test("authorize (caller anchor) blocks a call the caller isn't entitled to", async () => {
  const { toolkit, audit } = setup();
  const tool = toolkit.defineGovernedTool<{ accountId: string }>({
    name: "reset_password",
    description: "send a reset link",
    sideEffect: true,
    // The caller may only reset their own account. `a` inferred — no annotation.
    authorize: caller((a, ctx) => a.accountId === ctx.actor.id),
    execute: () => ({ sent: true }),
  });

  await assert.rejects(
    () => tool.execute({ accountId: "victim" }),
    AuthorizationDeniedError,
  );
  await tool.execute({ accountId: "a1" }); // a1 is the actor in setup()

  const entries = await audit.entries();
  assert.equal(entries[0]!.decision, "deny");
  assert.equal(entries[0]!.error, "authorization_denied");
  assert.equal(entries[1]!.decision, "allow");
});

test("approval can suspend (pending) and resume on re-invocation", async () => {
  let granted = false;
  const adapter = {
    async request() {
      return granted
        ? { approved: true, approver: "boss@co" }
        : { approved: false, pending: true, ref: "ticket-1" };
    },
  };
  const { toolkit, audit } = setup({ approval: adapter });
  let runs = 0;
  const tool = toolkit.defineGovernedTool({
    name: "wire_transfer",
    description: "move money",
    sideEffect: true,
    approval: true, // also satisfies the side-effect gate requirement
    execute: () => {
      runs += 1;
      return { ok: true };
    },
  });

  // First invocation: not yet decided -> suspend, nothing executes.
  await assert.rejects(
    () => tool.execute({}),
    (err: unknown) =>
      err instanceof ApprovalPendingError && err.ref === "ticket-1",
  );
  assert.equal(runs, 0);

  // The human approves out of band; the harness resumes -> re-invoke.
  granted = true;
  assert.deepEqual(await tool.execute({}), { ok: true });
  assert.equal(runs, 1);

  const entries = await audit.entries();
  assert.equal(entries[0]!.decision, "defer");
  assert.equal(entries[0]!.outcome, "pending");
  assert.equal(entries.at(-1)!.outcome, "success");
});

test("a side-effect call whose intent record fails does not execute", async () => {
  // Audit sink that fails when writing the pre-execution intent record.
  const inner = new InMemoryAuditLog();
  const audit: AuditLog = {
    append: async (input) => {
      if (input.outcome === "executing") throw new Error("audit down");
      return inner.append(input);
    },
    entries: () => inner.entries(),
  };
  const toolkit = createGovernedToolkit({
    context: () => ({
      actor: { id: "a1", roles: ["agent"] },
      tenantId: "acme",
      scopes: ["customer:*"],
    }),
    audit,
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  let runs = 0;
  const tool = toolkit.defineGovernedTool<{ customerId: string }>({
    name: "charge",
    description: "charge a card",
    sideEffect: true,
    scope: (a) => `customer:${a.customerId}`,
    execute: () => {
      runs += 1;
      return { charged: true };
    },
  });

  await assert.rejects(() => tool.execute({ customerId: "c-1" }), /audit down/);
  assert.equal(runs, 0, "handler must not run if its intent can't be recorded");
});

test("a side-effect tool with no authorization gate is rejected at definition", () => {
  const { toolkit } = setup();
  assert.throws(
    () =>
      toolkit.defineGovernedTool({
        name: "danger",
        description: "ungated side effect",
        sideEffect: true,
        execute: () => ({ ok: true }),
      }),
    GovernanceConfigError,
  );
});

test("authorize via a trusted source resolves the anchor server-side", async () => {
  // The anonymous-recovery shape: no authenticated actor; the trusted anchor is
  // a record lookup (email on file), compared against the model-supplied arg.
  const store = new ContextStore();
  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({
    context: store,
    audit,
    trustedSources: {
      accountEmail: (a: { accountId: string }) =>
        a.accountId === "acct-1" ? "owner@acme.test" : "someone@else.test",
    },
  });
  const reset = toolkit.defineGovernedTool<{ accountId: string; resetEmail: string }>({
    name: "start_recovery",
    description: "send a recovery link",
    sideEffect: true,
    // `a` inferred from the generic — no annotation; `src` is the resolved
    // trusted value.
    authorize: trusted("accountEmail", (a, src) => a.resetEmail === src),
    execute: () => ({ sent: true }),
  });

  const ctx = { actor: { id: "anon", roles: [] }, tenantId: "t", scopes: [] };
  // Right email → allowed; wrong email → denied (the HTS check, made mandatory).
  await store.run(ctx, () =>
    reset.execute({ accountId: "acct-1", resetEmail: "owner@acme.test" }),
  );
  await store.run(ctx, async () => {
    await assert.rejects(
      () => reset.execute({ accountId: "acct-1", resetEmail: "attacker@evil.test" }),
      AuthorizationDeniedError,
    );
  });
});

test("authorize referencing an unregistered trusted source is rejected at definition", () => {
  const { toolkit } = setup();
  assert.throws(
    () =>
      toolkit.defineGovernedTool<{ accountId: string; resetEmail: string }>({
        name: "start_recovery",
        description: "r",
        sideEffect: true,
        authorize: trusted("doesNotExist", (a, src) => a.resetEmail === src),
        execute: () => ({ ok: true }),
      }),
    GovernanceConfigError,
  );
});

test("side-effecting primitive needs out-of-band acknowledgement, not arg scope", () => {
  const { toolkit } = setup();
  const base = {
    name: "run_sql",
    description: "run arbitrary SQL",
    sideEffect: true,
    kind: "primitive" as const,
    // A scope on a free-form payload is not enough for a primitive.
    scope: () => "db:main",
    execute: () => ({ rows: 0 }),
  };

  assert.throws(() => toolkit.defineGovernedTool(base), GovernanceConfigError);
  assert.doesNotThrow(() =>
    toolkit.defineGovernedTool({ ...base, egressControlled: true }),
  );
  assert.doesNotThrow(() =>
    toolkit.defineGovernedTool({ ...base, unsafeAllowUnauthorized: true }),
  );
});

test("primitive tools are flagged as broad in the audit; scoped tools are not", async () => {
  const { toolkit, audit } = setup();
  const runSql = toolkit.defineGovernedTool({
    name: "run_sql",
    description: "run SQL",
    sideEffect: true,
    kind: "primitive",
    egressControlled: true, // bounded out-of-band
    execute: () => ({ rows: 1 }),
  });
  const lookup = toolkit.defineGovernedTool({
    name: "lookup",
    description: "read",
    execute: () => ({ ok: true }),
  });

  await runSql.execute({});
  await lookup.execute({});
  const entries = await audit.entries();
  assert.equal(entries.find((e) => e.tool === "run_sql")!.kind, "primitive");
  assert.equal(entries.find((e) => e.tool === "lookup")!.kind, undefined);
});

test("unsafeAllowUnauthorized opts out of the side-effect gate requirement", () => {
  const { toolkit } = setup();
  assert.doesNotThrow(() =>
    toolkit.defineGovernedTool({
      name: "danger",
      description: "explicitly ungated",
      sideEffect: true,
      unsafeAllowUnauthorized: true,
      execute: () => ({ ok: true }),
    }),
  );
});

test("an opaque host schema (e.g. Valibot) is passed through, not parsed", async () => {
  const { toolkit, audit } = setup();
  // A Valibot-style schema object: no `.parse` method, not a function.
  const valibotLike = { kind: "object", entries: { customerId: "string" } };
  let received: unknown;
  const tool = toolkit.defineGovernedTool<{ customerId: string }>({
    name: "lookup",
    description: "l",
    parameters: valibotLike,
    scope: (a) => `customer:${a.customerId}`,
    execute: (a) => {
      received = a;
      return { ok: true };
    },
  });

  // Flue would parse args first; here the args arrive and pass through intact.
  await tool.execute({ customerId: "c-1" });
  assert.deepEqual(received, { customerId: "c-1" });
  // The schema is exposed verbatim for Flue's defineTool to consume.
  assert.equal(tool.parameters, valibotLike);
  assert.equal((await audit.entries())[0]!.outcome, "success");
});

test("the returned object is a Flue-compatible tool", () => {
  const { toolkit } = setup();
  const tool = toolkit.defineGovernedTool({
    name: "lookup",
    description: "desc",
    parameters: { parse: (x) => x as { customerId: string } },
    execute: () => ({}),
  });
  assert.equal(tool.name, "lookup");
  assert.equal(tool.description, "desc");
  assert.equal(typeof tool.execute, "function");
  assert.ok("parameters" in tool);
});

test("toModelOutput shapes the returned value but audits the full result", async () => {
  const { toolkit, audit } = setup();
  const tool = toolkit.defineGovernedTool({
    name: "lookup_customer",
    description: "Look up a customer record.",
    authorize: caller(() => true),
    toModelOutput: (r: { id: string }) => ({ id: r.id }),
    execute: async () => ({ id: "c-1", plan: "pro", internalNotes: "vip" }),
  });
  const out = await tool.execute({});
  assert.deepEqual(out, { id: "c-1" }); // model sees only the shaped value
  const success = (await audit.entries()).find((e) => e.outcome === "success");
  assert.ok(success);
  // audit keeps the full (redacted) result, not the shaped one
  assert.equal(
    (success.result as { internalNotes: string }).internalNotes,
    "vip",
  );
});

test("a replayed call returns the same shaped value as the original", async () => {
  const { toolkit } = setup();
  let calls = 0;
  const tool = toolkit.defineGovernedTool({
    name: "send_invoice",
    description: "Send an invoice.",
    sideEffect: true,
    authorize: caller(() => true),
    idempotency: { key: () => "inv-1" },
    toModelOutput: (r: { id: string }) => ({ id: r.id }),
    execute: async () => {
      calls++;
      return { id: "i-1", amount: 100 };
    },
  });
  const first = await tool.execute({});
  const second = await tool.execute({});
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});
