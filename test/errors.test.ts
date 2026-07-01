import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GovernanceError,
  MissingContextError,
  AccessDeniedError,
  ScopeViolationError,
  ApprovalDeniedError,
  ApprovalPendingError,
  AuthorizationDeniedError,
  GovernanceConfigError,
  IdempotencyConflictError,
  isGovernanceError,
  isGovernanceDenial,
  isApprovalPending,
  type GovernanceErrorCode,
} from "../src/errors.js";

test("all governance errors extend GovernanceError and carry a code", () => {
  const errors: GovernanceError[] = [
    new MissingContextError("t"),
    new AccessDeniedError("t", ["admin"]),
    new ScopeViolationError("t", ["customer:b"], ["customer:a"]),
    new ApprovalDeniedError("t", "too big"),
    new IdempotencyConflictError("t", "k1"),
  ];
  for (const err of errors) {
    assert.ok(err instanceof GovernanceError);
    assert.ok(err instanceof Error);
    assert.equal(typeof err.code, "string");
    assert.ok(err.code.length > 0);
    assert.equal(err.tool, "t");
  }
});

test("errors expose machine codes and structured fields", () => {
  assert.equal(new MissingContextError().code, "missing_context");
  assert.equal(new AccessDeniedError("t", ["a"]).code, "access_denied");

  const scope = new ScopeViolationError("refund", ["customer:b"], ["customer:a"]);
  assert.equal(scope.code, "scope_violation");
  assert.deepEqual(scope.requested, ["customer:b"]);
  assert.deepEqual(scope.allowed, ["customer:a"]);

  const conflict = new IdempotencyConflictError("refund", "key-1");
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(conflict.key, "key-1");
});

test("isGovernanceError is true for governance errors, false otherwise", () => {
  assert.equal(isGovernanceError(new ScopeViolationError("t", ["b"], ["a"])), true);
  assert.equal(isGovernanceError(new Error("plain")), false);
  assert.equal(isGovernanceError("nope"), false);
});

test("isGovernanceDenial covers refusals but not pending or config errors", () => {
  const denials = [
    new MissingContextError("t"),
    new AccessDeniedError("t", ["admin"]),
    new ScopeViolationError("t", ["b"], ["a"]),
    new AuthorizationDeniedError("t"),
    new ApprovalDeniedError("t"),
    new IdempotencyConflictError("t", "k"),
  ];
  for (const err of denials) assert.equal(isGovernanceDenial(err), true);

  // Not denials: a suspend signal, a definition-time config error, a plain error.
  assert.equal(isGovernanceDenial(new ApprovalPendingError("t", "ref")), false);
  assert.equal(isGovernanceDenial(new GovernanceConfigError("t", "bad")), false);
  assert.equal(isGovernanceDenial(new Error("plain")), false);
});

test("isApprovalPending only matches the suspend signal", () => {
  assert.equal(isApprovalPending(new ApprovalPendingError("t", "ref")), true);
  assert.equal(isApprovalPending(new ScopeViolationError("t", ["b"], ["a"])), false);
});

test("error codes are the typed GovernanceErrorCode union", () => {
  // Compile-time: assignable to the union. Runtime: spot-check a couple.
  const code: GovernanceErrorCode = new ScopeViolationError("t", ["b"], ["a"]).code;
  assert.equal(code, "scope_violation");
  assert.equal(new ApprovalPendingError("t").code, "approval_pending");
});
