/**
 * Exercise the Jev adapter through the real Flue loop with an SDK transport fixture.
 * No network or API key: deny, review/resume, replay, and deny after approval.
 */
import assert from "node:assert/strict";
import { start } from "@flue/runtime/node";
import { init, useDelivery, useModel, useTool } from "@flue/runtime";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import * as v from "valibot";
import { govern } from "flue-guard";
import { createJevGuard } from "flue-guard/jev";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { InMemoryAuditLog } from "flue-guard/testing";

const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "m", contextWindow: 200000, maxTokens: 8192 }],
});
const audit = new InMemoryAuditLog();
let probability = 0;
let approved = false;
let evaluations = 0;
let approvals = 0;
const guard = createJevGuard({
  client: new TypeSafeClient({ apiKey: "synthetic", logLevel: "off", fetch: async () => {
    evaluations++;
    return globalThis.Response.json({ model: "fixture", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
      policyViolation: { type: "noul", noul: probability },
    } });
  } }),
  model: "fixture", policyId: "reset", policy: "Reset only when requested.",
  thresholds: { review: 0.3, deny: 0.8 },
  state: ({ tool, args }) => ({ request: "Reset my password", action: { tool, args } }),
});
const base = govern({
  context: () => {
    throw new Error("dispatched tools must use bound identity");
  },
  audit,
  approval: { request: async ({ assessment }) => {
    approvals++;
    assert.equal(assessment.decision, "review");
    return approved ? { approved: true, approver: "reviewer" } : { approved: false, pending: true, ref: "ticket" };
  } },
});
let resets = 0;
let modelResult;

function SupportAgent() {
  useModel("faux/m");
  const delivery = useDelivery();
  const actorId = delivery.kind === "signal" ? delivery.attributes?.actorId : undefined;
  if (!actorId) throw new Error("authenticated actor is required");
  const bound = base.withContext({
    actor: { id: actorId, roles: ["account_holder"] },
    tenantId: "app",
    scopes: [`account:${actorId}`],
  });
  useTool(bound.tool({
    name: "reset_password",
    description: "Send a password reset link for an account.",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    guard,
    scope: (a) => `account:${a.accountId}`,
    idempotency: { key: (a) => `reset:${a.accountId}` },
    execute: (a) => {
      resets += 1;
      // Application fields must not terminate the turn or unwrap themselves.
      return { accountId: a.accountId, output: "sent", terminate: true };
    },
  }));
  return "Reset passwords when asked.";
}

const runtime = await start({ agents: [SupportAgent], providers: [faux.provider], env: {} });
try {
  async function call(instanceId, actorId, accountId, expectedError) {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("reset_password", { accountId })], { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result, "Flue must return a tool result to the model");
        assert.equal(result.isError, expectedError);
        modelResult = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        return fauxAssistantMessage("Turn complete.");
      },
    ]);
    const handle = init(SupportAgent, { id: instanceId });
    const receipt = await handle.dispatch({
      message: {
        kind: "signal",
        type: "support.request",
        body: "Please reset my password",
        attributes: { actorId },
      },
    });
    const reply = await handle.read(receipt, { signal: globalThis.AbortSignal.timeout(10000) });
    assert.equal(reply.text, "Turn complete.");
    assert.equal(faux.getPendingResponseCount(), 0);
  }

  probability = 0.95;
  await call("guarded", "user-7", "user-7", true);
  assert.equal(resets, 0);
  assert.equal(approvals, 0);
  assert.equal((await audit.entries()).at(-1).error, "guard_denied");

  probability = 0.5;
  await call("guarded", "user-7", "user-7", true);
  assert.equal(resets, 0);
  assert.equal(approvals, 1);
  assert.equal((await audit.entries()).at(-1).outcome, "pending");

  approved = true;
  await call("guarded", "user-7", "user-7", false);
  assert.equal(resets, 1);
  assert.equal(approvals, 2);
  assert.deepEqual(JSON.parse(modelResult), { accountId: "user-7", output: "sent", terminate: true });

  await call("guarded", "user-7", "user-7", false);
  assert.equal(resets, 1);
  assert.equal((await audit.entries()).at(-1).outcome, "replayed");

  probability = 0.95;
  await call("guarded", "user-7", "user-7", true);
  assert.equal(resets, 1);
  assert.equal(approvals, 3, "guard deny must not consult the old approval");
  assert.equal((await audit.entries()).at(-1).error, "guard_denied");
  assert.equal(evaluations, 5, "every invocation must reassess before approval or replay");
  assert.deepEqual(await audit.verify(), { valid: true });
  console.log("Jev through Flue verified: deny, pending review, approved resume, replay, later deny wins.");
} finally {
  await runtime.stop();
}
