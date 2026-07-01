/**
 * The golden-path factory: `govern()` wires Flue's real `defineTool`, so
 * `gov.tool(...)` returns a ready Flue tool with no injection. These imports
 * also pin the public surface — `govern`/`caller` from the root, the in-memory
 * sink from `/testing`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { govern, caller, AuthorizationDeniedError } from "flue-guard";
import { InMemoryAuditLog } from "flue-guard/testing";

test("govern(): gov.tool returns a usable Flue tool gated by authorize", async () => {
  const audit = new InMemoryAuditLog();
  const gov = govern({ audit }); // built-in context store; Flue defineTool wired

  const reset = gov.tool({
    name: "reset_password",
    description: "Send a password reset link.",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    authorize: caller((a, ctx) => a.accountId === ctx.actor.id),
    idempotency: { key: (a) => a.accountId },
    execute: (a) => `sent:${a.accountId}`,
  });

  // It is a Flue ToolDefinition (name/description/parameters/execute).
  assert.equal(reset.name, "reset_password");
  assert.equal(typeof reset.execute, "function");

  // Own account: allowed, returns the (string) result Flue expects.
  const out = await gov.run(
    { actor: { id: "u1", roles: [] }, tenantId: "t" },
    () => reset.execute({ accountId: "u1" }),
  );
  assert.equal(out, "sent:u1");

  // Someone else's account: refused before the side effect.
  await assert.rejects(
    () =>
      gov.run(
        { actor: { id: "u1", roles: [] }, tenantId: "t" },
        () => reset.execute({ accountId: "victim" }),
      ),
    AuthorizationDeniedError,
  );

  const outcomes = (await audit.entries()).map((e) => `${e.decision}/${e.outcome}`);
  assert.deepEqual(outcomes, ["allow/executing", "allow/success", "deny/denied"]);
});
