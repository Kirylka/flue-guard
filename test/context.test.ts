import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextStore } from "../src/context.js";
import { MissingContextError } from "../src/errors.js";
import type { TrustedContext } from "../src/types.js";

const ctxA: TrustedContext = {
  actor: { id: "a1", roles: ["agent"] },
  tenantId: "acme",
  scopes: ["customer:*"],
};
const ctxB: TrustedContext = {
  actor: { id: "b1", roles: ["agent"] },
  tenantId: "globex",
  scopes: ["customer:c-9"],
};

test("current() returns the bound context inside run()", () => {
  const store = new ContextStore();
  store.run(ctxA, () => {
    assert.equal(store.current().tenantId, "acme");
    assert.equal(store.peek()?.tenantId, "acme");
  });
});

test("current() throws MissingContextError outside run()", () => {
  const store = new ContextStore();
  assert.equal(store.peek(), undefined);
  assert.throws(() => store.current(), MissingContextError);
});

test("nested runs isolate context", () => {
  const store = new ContextStore();
  store.run(ctxA, () => {
    assert.equal(store.current().tenantId, "acme");
    store.run(ctxB, () => {
      assert.equal(store.current().tenantId, "globex");
    });
    assert.equal(store.current().tenantId, "acme");
  });
});

test("resolver() reads the current context", async () => {
  const store = new ContextStore();
  const resolve = store.resolver();
  await store.run(ctxB, async () => {
    assert.equal((await resolve()).actor.id, "b1");
  });
});

test("context propagates across async boundaries", async () => {
  const store = new ContextStore();
  await store.run(ctxA, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(store.current().tenantId, "acme");
  });
});
