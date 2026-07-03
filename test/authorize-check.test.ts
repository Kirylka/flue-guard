/**
 * `authorize` as a bare check function: the caller-anchored shorthand.
 *
 * The runtime tests prove the function form behaves exactly like
 * `caller(...)` (allow, deny, audit). The *compile-time* point is just as
 * load-bearing: inside `toolkit.tool({...})` the bare function's `args`
 * parameter is contextually typed from `parameters`, so `a.accountId` below
 * type-checks as `string` with no annotation — if that inference regresses,
 * this file fails to build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  createGovernedToolkit,
  InMemoryAuditLog,
  AuthorizationDeniedError,
  type FlueToolDefinition,
  type TrustedContext,
} from "./_all.js";

const ctx: TrustedContext = {
  actor: { id: "u-1", roles: ["holder"] },
  tenantId: "acme",
};

function setup() {
  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({
    context: () => ctx,
    audit,
    // Identity defineTool: enough to exercise toolkit.tool's inference path
    // without pulling the real Flue runtime into this unit test.
    defineTool: (t: FlueToolDefinition) => t,
  });
  return { audit, toolkit };
}

test("bare-function authorize infers args from parameters and gates like caller()", async () => {
  const { audit, toolkit } = setup();
  let runs = 0;

  const reset = toolkit.tool({
    name: "reset_password",
    description: "send a reset link",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    // No annotation: `a` is inferred as { accountId: string } from parameters.
    // `.toUpperCase()` is the compile-time proof it isn't `unknown`.
    authorize: (a, c) => a.accountId.toUpperCase() === c.actor.id.toUpperCase(),
    execute: (a) => {
      runs += 1;
      return `sent to ${a.accountId}`;
    },
  });

  // Own account: allowed.
  assert.equal(await reset.run({ input: { accountId: "u-1" } }), "sent to u-1");
  assert.equal(runs, 1);

  // Someone else's account: denied before the side effect, audited as
  // authorization_denied — identical to the caller(...) form.
  await assert.rejects(
    () => reset.run({ input: { accountId: "victim" } }),
    AuthorizationDeniedError,
  );
  assert.equal(runs, 1);

  const entries = await audit.entries();
  const denial = entries[entries.length - 1]!;
  assert.equal(denial.decision, "deny");
  assert.equal(denial.error, "authorization_denied");
});

test("bare-function authorize counts as the side-effect gate at definition time", () => {
  const { toolkit } = setup();
  // A side-effecting tool whose ONLY gate is the function form must define
  // without a GovernanceConfigError (i.e. it is recognized as a gate).
  toolkit.tool({
    name: "close_account",
    description: "close an account",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    authorize: (a, c) => a.accountId === c.actor.id,
    execute: () => "closed",
  });
});

test("bare-function authorize works on defineGovernedTool too", async () => {
  const { toolkit } = setup();
  const tool = toolkit.defineGovernedTool<{ docId: string }>({
    name: "share_doc",
    description: "share a document",
    sideEffect: true,
    authorize: (a, c) => a.docId.startsWith(`${c.actor.id}:`),
    execute: (a) => a.docId,
  });

  assert.equal(await tool.execute({ docId: "u-1:readme" }), "u-1:readme");
  await assert.rejects(
    () => tool.execute({ docId: "u-2:secret" }),
    AuthorizationDeniedError,
  );
});
