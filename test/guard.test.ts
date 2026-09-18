import { test } from "node:test";
import assert from "node:assert/strict";
import { createGovernedToolkit, caller } from "../src/toolkit.js";
import { InMemoryIdempotencyStore } from "../src/idempotency.js";
import type { GuardAssessment } from "../src/guard.js";
import { InMemoryAuditLog } from "../src/audit.js";

test("a guard denial stops approval and execution after authorization", async () => {
  const calls: string[] = [];
  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({
    audit,
    context: () => ({ actor: { id: "alice", roles: [] }, tenantId: "acme" }),
    approval: { request: async () => { calls.push("approval"); return { approved: true }; } },
  });
  const spec = {
    name: "refund",
    description: "Refund an order",
    sideEffect: true,
    authorize: caller(() => { calls.push("authorize"); return true; }),
    guard: {
      evaluate: async () => {
        calls.push("guard");
        return { decision: "deny" as const, reasonCodes: ["intent_mismatch"] };
      },
    },
    approval: true,
    execute: () => { calls.push("execute"); return "refunded"; },
  };
  const tool = toolkit.defineGovernedTool(spec);
  await assert.rejects(tool.execute({}), { code: "guard_denied" });
  assert.deepEqual(calls, ["authorize", "guard"]);
  assert.equal((await audit.entries())[0]?.error, "guard_denied");
});

const context = () => ({ actor: { id: "alice", roles: [] }, tenantId: "acme" });
const allow = { decision: "allow" as const, reasonCodes: [] };
const review = { decision: "review" as const, reasonCodes: ["ambiguous"] };

for (const approved of [true, false]) {
  test(`review requires approval and passes assessment: ${approved}`, async () => {
    let executed = false;
    const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context,
      approval: { request: async (req) => { assert.deepEqual(req.assessment, review); return { approved }; } },
    });
    const tool = toolkit.defineGovernedTool({ name: "read", description: "read",
      guard: { evaluate: async () => review }, execute: () => { executed = true; return 7; },
    });
    if (approved) assert.equal(await tool.execute({}), 7);
    else await assert.rejects(tool.execute({}), { code: "approval_denied" });
    assert.equal(executed, approved);
  });
}

test("allow does not override required approval; review without an adapter blocks", async () => {
  for (const assessment of [allow, review]) {
    const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context });
    const tool = toolkit.defineGovernedTool({ name: "read", description: "read", approval: assessment === allow,
      guard: { evaluate: async () => assessment }, execute: () => assert.fail("executed"),
    });
    await assert.rejects(tool.execute({}), { code: "approval_denied" });
  }
});

for (const idempotent of [true, false]) {
  test(`guard and execution share one detached mutable clone, other steps retain args (${idempotent})`, async () => {
    const original = { nested: { value: 1 } };
    let assessed: typeof original | undefined;
    const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context,
      approval: { request: async (req) => { assert.equal(req.args, original); original.nested.value = 9; return { approved: true }; } },
    });
    const tool = toolkit.defineGovernedTool<typeof original, number>({ name: "read", description: "read",
      authorize: caller((args) => { assert.equal(args, original); return true; }),
      guard: { evaluate: async ({args}) => { assessed = args; assert.notEqual(args, original); assert.notEqual(args.nested, original.nested); assert.equal(Object.isFrozen(args), false); return allow; } },
      approval: (args) => { assert.equal(args, original); return true; },
      ...(idempotent ? { idempotency: { key: (args: typeof original) => { assert.equal(args, original); return "one"; } } } : {}),
      execute: (args) => { assert.equal(args, assessed); return args.nested.value; },
    });
    assert.equal(await tool.execute(original), 1);
  });
}

test("an authorization denial never calls the guard", async () => {
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context });
  const tool = toolkit.defineGovernedTool({ name: "read", description: "read",
    authorize: caller(() => false), guard: { evaluate: async () => assert.fail("assessed") },
    execute: () => assert.fail("executed"),
  });
  await assert.rejects(tool.execute({}), { code: "authorization_denied" });
});

test("guard errors, malformed assessments, and uncloneable args fail closed without leaking bodies", async () => {
  const invalid = { decision: "permit", reasonCodes: [] } as unknown as typeof allow;
  for (const [args, evaluate] of [
    [{}, async () => { throw new Error("secret-provider-body"); }],
    [{}, async () => invalid],
    [{ callback: () => 1 }, async () => allow],
  ] as const) {
    const audit = new InMemoryAuditLog();
    const toolkit = createGovernedToolkit({ audit, context });
    const tool = toolkit.defineGovernedTool({ name: "read", description: "read", guard: { evaluate }, execute: () => assert.fail("executed") });
    await assert.rejects(tool.execute(args), { code: "guard_unavailable" });
    const entries = await audit.entries();
    assert.equal(entries[0]?.error, "guard_unavailable");
    assert.equal(entries[0]?.outcome, "error");
    assert.equal(JSON.stringify(entries).includes("secret-provider-body"), false);
  }
});

test("deadline blocks a non-cooperative guard and aborts its signal", async () => {
  let signal: AbortSignal | undefined;
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context });
  const tool = toolkit.defineGovernedTool({ name: "read", description: "read",
    guard: { timeoutMs: 5, evaluate: ({ctx}) => { signal = ctx.signal; return new Promise(() => {}); } },
    execute: () => assert.fail("executed"),
  });
  await assert.rejects(tool.execute({}), { code: "guard_unavailable" });
  assert.equal(signal?.aborted, true);
});

test("guard denial on retry takes precedence over a prior approval and idempotent replay", async () => {
  let denied = false;
  let approvals = 0;
  let executions = 0;
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context,
    approval: { request: async () => { approvals++; return { approved: true }; } },
  });
  const tool = toolkit.defineGovernedTool({ name: "read", description: "read", approval: true,
    guard: { evaluate: async () => denied ? { decision: "deny", reasonCodes: ["changed"] } : allow },
    idempotency: { key: () => "one" }, execute: () => ++executions,
  });
  assert.equal(await tool.execute({}), 1);
  denied = true;
  await assert.rejects(tool.execute({}), { code: "guard_denied" });
  assert.equal(approvals, 1);
  assert.equal(executions, 1);
});

test("pending review cannot override a guard denial on resume", async () => {
  let denied = false;
  let approvals = 0;
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context,
    approval: { request: async () => { approvals++; return { approved: false, pending: true, ref: "ticket" }; } },
  });
  const tool = toolkit.defineGovernedTool({ name: "read", description: "read",
    guard: { evaluate: async () => denied ? { decision: "deny", reasonCodes: [] } : review },
    execute: () => assert.fail("executed"),
  });
  await assert.rejects(tool.execute({}), { code: "approval_pending" });
  denied = true;
  await assert.rejects(tool.execute({}), { code: "guard_denied" });
  assert.equal(approvals, 1);
});

test("guard alone is not an authorization gate and timeout configuration is validated", () => {
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context });
  assert.throws(() => toolkit.defineGovernedTool({ name: "write", description: "write", sideEffect: true,
    guard: { evaluate: async () => allow }, execute: () => 1,
  }), { code: "config_error" });
  assert.throws(() => toolkit.defineGovernedTool({ name: "read", description: "read",
    guard: { timeoutMs: 0, evaluate: async () => allow }, execute: () => 1,
  }), { code: "config_error" });
});

for (const before of [true, false]) {
  test(`parent cancellation blocks assessment (pre-aborted: ${before})`, async () => {
    const controller = new AbortController();
    let started = false;
    let signal: AbortSignal | undefined;
    const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context });
    const tool = toolkit.defineGovernedTool({ name: "read", description: "read",
      guard: { evaluate: ({ctx}) => { started = true; signal = ctx.signal; controller.abort(); return new Promise(() => {}); } },
      execute: () => assert.fail("executed"),
    });
    if (before) controller.abort();
    await assert.rejects(tool.execute({}, undefined, controller.signal), { code: "guard_unavailable" });
    assert.equal(started, !before);
    if (!before) assert.equal(signal?.aborted, true);
  });
}

test("completed assessments are redacted on intent, success, and replay without changing approval evidence", async () => {
  const audit = new InMemoryAuditLog();
  const assessment = { ...allow, details: { secret: "private-value", model: "test" } };
  const toolkit = createGovernedToolkit({ audit, context,
    approval: { request: async (req) => { assert.equal(req.assessment?.details?.secret, "private-value"); return { approved: true }; } },
  });
  const tool = toolkit.defineGovernedTool({ name: "write", description: "write", sideEffect: true, approval: true,
    guard: { evaluate: async () => assessment }, idempotency: { key: () => "one" }, execute: () => 1,
  });
  await tool.execute({});
  await tool.execute({});
  const entries = await audit.entries();
  assert.deepEqual(entries.map((entry) => entry.outcome), ["executing", "success", "replayed"]);
  for (const entry of entries) assert.deepEqual(entry.guard, { ...allow, details: { secret: "[redacted]", model: "test" } });
  assert.deepEqual(await audit.verify(), { valid: true });
});


test("an assessment finishing after its deadline cannot allow execution when timers were delayed", async () => {
  let executions = 0;
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context });
  const tool = toolkit.defineGovernedTool({ name: "read", description: "read",
    guard: { timeoutMs: 5, evaluate: async () => {
      // Model synchronous projection or parsing that prevents the timeout callback running.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      return allow;
    } },
    execute: () => ++executions,
  });
  await assert.rejects(tool.execute({}), { code: "guard_unavailable" });
  assert.equal(executions, 0);
});


test("concurrent assessments keep each call's decision and audit evidence isolated", async () => {
  const audit = new InMemoryAuditLog();
  const releases = new Map<number, (assessment: GuardAssessment) => void>();
  let ready: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
  const executions: number[] = [];
  const toolkit = createGovernedToolkit({ audit, context });
  const tool = toolkit.defineGovernedTool<{ id: number }>({ name: "read", description: "read",
    guard: { evaluate: ({ args }) => new Promise((resolve) => {
      releases.set(args.id, resolve);
      if (releases.size === 2) ready?.();
    }) },
    execute: (args) => { executions.push(args.id); return args.id; },
  });
  const first = tool.execute({ id: 1 });
  const second = tool.execute({ id: 2 });
  const denied = assert.rejects(first, { code: "guard_denied" });
  await bothStarted;
  releases.get(2)?.({ decision: "allow", reasonCodes: ["second"] });
  assert.equal(await second, 2);
  releases.get(1)?.({ decision: "deny", reasonCodes: ["first"] });
  await denied;
  assert.deepEqual(executions, [2]);
  assert.deepEqual((await audit.entries()).map((entry) => [entry.args, entry.guard]), [
    [{ id: 2 }, { decision: "allow", reasonCodes: ["second"] }],
    [{ id: 1 }, { decision: "deny", reasonCodes: ["first"] }],
  ]);
  assert.deepEqual(await audit.verify(), { valid: true });
});

test("guard failure leaves no idempotency claim and a later healthy call can execute", async () => {
  const store = new InMemoryIdempotencyStore();
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context, idempotencyStore: store });
  let healthy = false;
  const tool = toolkit.defineGovernedTool({ name: "write", description: "write", sideEffect: true,
    authorize: caller(() => true), idempotency: { key: () => "one" },
    guard: { evaluate: async () => { if (!healthy) throw new Error("outage"); return allow; } },
    execute: () => "done",
  });
  await assert.rejects(tool.execute({}), { code: "guard_unavailable" });
  assert.equal(await store.get("acme", JSON.stringify(["write", "one"])), undefined);
  healthy = true;
  assert.equal(await tool.execute({}), "done");
});

test("a failed intent audit after guard allow blocks the side effect and releases the claim", async () => {
  const store = new InMemoryIdempotencyStore();
  const toolkit = createGovernedToolkit({ context, idempotencyStore: store,
    audit: { append: async () => { throw new Error("audit unavailable"); }, entries: async () => [] },
  });
  const tool = toolkit.defineGovernedTool({ name: "write", description: "write", sideEffect: true,
    authorize: caller(() => true), guard: { evaluate: async () => allow },
    idempotency: { key: () => "one" }, execute: () => assert.fail("executed"),
  });
  await assert.rejects(tool.execute({}), /audit unavailable/);
  assert.equal((await store.begin("acme", JSON.stringify(["write", "one"]))).status, "started");
});
