import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRbac, type RbacAdapter } from "../src/rbac.js";
import type { TrustedContext } from "../src/types.js";

const ctx = (roles: string[]): TrustedContext => ({
  actor: { id: "a1", roles },
  tenantId: "acme",
  scopes: [],
});

test("empty requiredRoles allows", async () => {
  assert.equal(
    await defaultRbac.can({ tool: "t", requiredRoles: [], ctx: ctx([]) }),
    true,
  );
});

test("any-of matching role allows", async () => {
  assert.equal(
    await defaultRbac.can({
      tool: "t",
      requiredRoles: ["admin", "agent"],
      ctx: ctx(["agent"]),
    }),
    true,
  );
});

test("no matching role denies", async () => {
  assert.equal(
    await defaultRbac.can({
      tool: "t",
      requiredRoles: ["admin"],
      ctx: ctx(["agent"]),
    }),
    false,
  );
});

test("a custom adapter can override the decision", async () => {
  const denyAll: RbacAdapter = { can: () => false };
  assert.equal(
    await denyAll.can({ tool: "t", requiredRoles: [], ctx: ctx(["admin"]) }),
    false,
  );
});
