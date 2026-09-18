/**
 * Exercise governed tools through Flue's public standalone runtime and a faux
 * model. Asserts dispatch identity, validation, replay, and output envelopes.
 * Run: npm run spike (no API key or network required).
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
import { InMemoryAuditLog } from "flue-guard/testing";

const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "m", contextWindow: 200000, maxTokens: 8192 }],
});
const audit = new InMemoryAuditLog();
const base = govern({
  context: () => {
    throw new Error("dispatched tools must use bound identity");
  },
  audit,
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

  await call("allowed", "user-7", "user-7", false);
  assert.equal(resets, 1);
  assert.deepEqual(JSON.parse(modelResult), { accountId: "user-7", output: "sent", terminate: true });

  await call("replayed", "user-7", "user-7", false);
  assert.equal(resets, 1);
  assert.equal((await audit.entries()).at(-1).outcome, "replayed");

  // A continuing instance must rebind tools to the new delivery's caller.
  await call("allowed", "user-8", "user-7", true);
  assert.equal(resets, 1);
  assert.equal((await audit.entries()).at(-1).error, "scope_violation");
  assert.equal((await audit.entries()).at(-1).actorId, "user-8");

  const countBeforeInvalid = (await audit.entries()).length;
  await call("invalid", "user-7", { invalid: true }, true);
  assert.equal(resets, 1);
  assert.equal((await audit.entries()).length, countBeforeInvalid, "Flue rejects invalid input before governance");
  assert.deepEqual(await audit.verify(), { valid: true });
  console.log("Flue 2 dispatch verified: allowed, replayed, cross-account denied, invalid input rejected; audit chain valid.");
} finally {
  await runtime.stop();
}
