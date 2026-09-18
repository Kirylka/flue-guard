import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import { createJevGuard, type JevGuardOptions } from "../src/jev.js";
import { createGovernedToolkit } from "../src/toolkit.js";
import { InMemoryAuditLog } from "../src/audit.js";

const context = { actor: { id: "alice", roles: [] }, tenantId: "acme" };
const thresholds = { review: 0.2, deny: 0.7 };
function options(fetch: Fetch): JevGuardOptions<{ text: string }> {
  return {
    client: new TypeSafeClient({ apiKey: "test-key", fetch, logLevel: "off" }),
    model: "pinned-model", policyId: "support", policyVersion: "1",
    policy: "Only send responses relevant to the customer request.", thresholds,
    state: ({tool, args}) => ({ request: "Reply to the customer", action: { tool, text: args.text } }),
  };
}
function response(probability = 0.1): Response {
  return Response.json({ model: "actual-model", usage: { input_tokens: 10, output_tokens: 3 },
    answers: { policyViolation: { type: "noul", noul: probability } },
  });
}

for (const [probability, decision, reasons] of [
  [0.199, "allow", []],
  [0.2, "review", ["policyViolation"]],
  [0.699, "review", ["policyViolation"]],
  [0.7, "deny", ["policyViolation"]],
] as const) {
  test(`policy violation probability ${probability} routes ${decision}`, async () => {
    const guard = createJevGuard(options(async () => response(probability)));
    const assessment = await guard.evaluate({ tool: "reply", args: { text: "Hello" }, ctx: { ...context, authorizedScopes: [] } });
    assert.equal(assessment.decision, decision);
    assert.deepEqual(assessment.reasonCodes, reasons);
    assert.deepEqual(assessment.details?.probabilities, { policyViolation: probability });
    assert.equal(assessment.details?.model, "actual-model");
    assert.equal(assessment.details?.policyVersion, "1");
  });
}

test("Jev sends only projected state and the policy question", async () => {
  let payload: Record<string, unknown> | undefined;
  const guard = createJevGuard(options(async (_url, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response();
  }));
  await guard.evaluate({ tool: "reply", args: { text: "Hello" }, ctx: { ...context, authorizedScopes: [], attributes: { secret: "do-not-send" } } });
  assert.deepEqual(payload?.state, { request: "Reply to the customer", action: { tool: "reply", text: "Hello" } });
  assert.equal(payload?.model, "pinned-model");
  assert.deepEqual(Object.keys(payload?.questions as object), ["policyViolation"]);
  assert.equal(JSON.stringify(payload).includes("do-not-send"), false);
});

for (const failure of ["server", "malformed", "projector"] as const) {
  test(`Jev ${failure} failure blocks execution with no retries`, async () => {
    let calls = 0;
    const config = options(async () => { calls++; return failure === "server" ? new Response("private body", { status: 503 }) : Response.json({ model: "actual", answers: {} }); });
    if (failure === "projector") config.state = () => { throw new Error("private state"); };
    const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context: () => context });
    const tool = toolkit.defineGovernedTool({ name: "reply", description: "reply", guard: createJevGuard(config), execute: () => assert.fail("executed") });
    await assert.rejects(tool.execute({ text: "Hello" }), { code: "guard_unavailable" });
    assert.equal(calls, failure === "projector" ? 0 : 1);
  });
}

test("Jev requires valid thresholds and an explicit state projector", () => {
  const config = options(async () => response());
  assert.throws(() => createJevGuard({ ...config, thresholds: { review: 0.8, deny: 0.8 } }), { code: "config_error" });
  assert.throws(() => createJevGuard({ ...config, state: undefined } as unknown as typeof config), { code: "config_error" });
});


test("the total deadline includes projection and expired projection never sends a request", async () => {
  let calls = 0;
  let release: ((value: string) => void) | undefined;
  const config = options(async () => { calls++; return response(); });
  config.timeoutMs = 5;
  config.state = () => new Promise<string>((resolve) => { release = resolve; });
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context: () => context });
  const tool = toolkit.defineGovernedTool({ name: "reply", description: "reply", guard: createJevGuard(config), execute: () => assert.fail("executed") });
  await assert.rejects(tool.execute({text: "Hello"}), { code: "guard_unavailable" });
  assert.ok(release);
  release("late state");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("the deadline cancels SDK transport with one attempt", async () => {
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const config = options(async (_url, init) => {
    calls++;
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted transport")), { once: true });
    });
  });
  config.timeoutMs = 5;
  const toolkit = createGovernedToolkit({ audit: new InMemoryAuditLog(), context: () => context });
  const tool = toolkit.defineGovernedTool({ name: "reply", description: "reply", guard: createJevGuard(config), execute: () => assert.fail("executed") });
  await assert.rejects(tool.execute({text: "Hello"}), { code: "guard_unavailable" });
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

for (const badAnswer of [null, {}, { type: "choice", noul: 0 }, { type: "noul", noul: "0" },
  { type: "noul", noul: null }, { type: "noul", noul: -0.01 }, { type: "noul", noul: 1.01 }]) {
  test(`invalid policy answer blocks: ${JSON.stringify(badAnswer)}`, async () => {
    const guard = createJevGuard(options(async () => {
      const body = await response().json() as { answers: Record<string, unknown> };
      body.answers.policyViolation = badAnswer;
      return Response.json(body);
    }));
    const audit = new InMemoryAuditLog();
    const toolkit = createGovernedToolkit({ audit, context: () => context });
    const tool = toolkit.defineGovernedTool({ name: "reply", description: "reply", guard, execute: () => assert.fail("executed") });
    await assert.rejects(tool.execute({ text: "Hello" }), { code: "guard_unavailable" });
    assert.equal((await audit.entries())[0]?.guard, undefined);
  });
}

for (const badThreshold of [
  { review: -0.1, deny: 0.8 }, { review: 0.4, deny: 1.1 },
  { review: NaN, deny: 0.8 }, { review: 0.4, deny: Infinity },
  { review: 0.9, deny: 0.8 },
]) {
  test(`invalid thresholds reject at construction: ${String(badThreshold.review)}/${String(badThreshold.deny)}`, () => {
    assert.throws(() => createJevGuard({ ...options(async () => response()),
      thresholds: badThreshold,
    }), { code: "config_error" });
  });
}

for (const status of [408, 429, 500, 503]) {
  test(`HTTP ${status} never inherits client retries`, async () => {
    let calls = 0;
    const config = options(async () => { calls++; return new Response("provider-secret", { status }); });
    const guard = createJevGuard(config);
    await assert.rejects(guard.evaluate({ tool: "reply", args: { text: "Hello" }, ctx: { ...context, authorizedScopes: [] } }),
      { code: "guard_unavailable" });
    assert.equal(calls, 1);
  });
}

test("connection failures have no retry and no provider cause exposed", async () => {
  let calls = 0;
  const guard = createJevGuard(options(async () => { calls++; throw new Error("transport-secret"); }));
  await assert.rejects(guard.evaluate({ tool: "reply", args: { text: "Hello" }, ctx: { ...context, authorizedScopes: [] } }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes("transport-secret"), false);
      return true;
    });
  assert.equal(calls, 1);
});

test("threshold configuration remains stable when caller mutates its configuration", async () => {
  const config = options(async () => response(0.8));
  config.thresholds = { ...thresholds };
  const guard = createJevGuard(config);
  config.thresholds.deny = 1;
  const assessment = await guard.evaluate({ tool: "reply", args: { text: "Hello" }, ctx: { ...context, authorizedScopes: [] } });
  assert.equal(assessment.decision, "deny");
});
