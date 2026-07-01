import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeAllowed, normalizeScopes, deniedScopes } from "../src/scope.js";

test("exact scope matches", () => {
  assert.ok(scopeAllowed("customer:c-1", ["customer:c-1"]));
  assert.ok(!scopeAllowed("customer:c-2", ["customer:c-1"]));
});

test("wildcard prefix matches", () => {
  assert.ok(scopeAllowed("customer:c-1", ["customer:*"]));
  assert.ok(scopeAllowed("customer:c-1", ["*"]));
  assert.ok(!scopeAllowed("ticket:t-1", ["customer:*"]));
});

test("wildcard matches across separators", () => {
  assert.ok(scopeAllowed("tenant:acme/customer:c-1", ["tenant:acme/*"]));
});

test("regex metacharacters in patterns are escaped", () => {
  // The '.' must be literal, not 'any char'.
  assert.ok(!scopeAllowed("customerXc-1", ["customer.c-1"]));
  assert.ok(scopeAllowed("customer.c-1", ["customer.c-1"]));
});

test("normalizeScopes handles string, array, null", () => {
  assert.deepEqual(normalizeScopes("a"), ["a"]);
  assert.deepEqual(normalizeScopes(["a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeScopes(undefined), []);
  assert.deepEqual(normalizeScopes(null), []);
});

test("deniedScopes returns the uncovered subset", () => {
  assert.deepEqual(
    deniedScopes(["customer:c-1", "ticket:t-9"], ["customer:*"]),
    ["ticket:t-9"],
  );
  assert.deepEqual(deniedScopes(["customer:c-1"], ["customer:*"]), []);
});
