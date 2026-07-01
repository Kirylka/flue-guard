import { test } from "node:test";
import assert from "node:assert/strict";
import { always, never } from "../src/approval.js";
import type { TrustedContext } from "../src/types.js";

const ctx: TrustedContext = { actor: { id: "u1", roles: [] }, tenantId: "t1" };

test("always(reason) is a policy that triggers with that reason", () => {
  const policy = always("refund over limit");
  assert.equal(typeof policy, "function");
  assert.equal(
    (policy as (a: unknown, c: TrustedContext) => unknown)({}, ctx),
    "refund over limit",
  );
});

test("always() without a reason still triggers", () => {
  const policy = always();
  assert.equal(
    (policy as (a: unknown, c: TrustedContext) => unknown)({}, ctx),
    true,
  );
});

test("never() is the literal false policy, not a gating function", () => {
  // Must be `false`, NOT `() => false`: `defineGovernedTool` counts a function
  // policy as an authorization gate, and never() must not satisfy the
  // "side-effect tool needs a gate" check.
  assert.equal(never(), false);
});
