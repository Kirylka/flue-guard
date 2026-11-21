/**
 * Definition-time checks: a spec that could let a side effect run without a
 * check, or that is misconfigured, fails when the tool is defined, never when
 * it is called.
 */

import { GovernanceConfigError } from "./errors.js";
import { guardTimeout } from "./guard.js";
import type { GovernedToolSpec, TrustedSource } from "./spec.js";

/** What the pipeline needs from the checked spec. */
export interface CheckedSpec<TArgs> {
  /** `authorize` in its object form (a plain function becomes the caller anchor). */
  authorize: Exclude<GovernedToolSpec<TArgs, unknown>["authorize"], (...args: never[]) => unknown>;
  /**
   * True when `scope` is the only gate of a side-effecting tool, so a call
   * that derives no scopes must be refused rather than pass vacuously.
   */
  scopeIsOnlyGate: boolean;
}

/** Validate a spec and normalize what the pipeline reads from it. */
export function checkSpec<TArgs, TResult>(
  spec: GovernedToolSpec<TArgs, TResult>,
  trustedSources: Record<string, TrustedSource> | undefined,
): CheckedSpec<TArgs> {
  // `authorize` is keyed to a declared anchor (caller or a trusted source),
  // so there's no arg-only shape to reject. A plain function is the caller
  // anchor. We only check that a referenced trusted source actually exists.
  const authorize = typeof spec.authorize === "function"
    ? { anchor: "caller" as const, check: spec.authorize }
    : spec.authorize;
  if (
    authorize &&
    typeof authorize.anchor === "object" &&
    !(authorize.anchor.trustedSource in (trustedSources ?? {}))
  ) {
    throw new GovernanceConfigError(
      spec.name,
      `authorize for "${spec.name}" references unknown trusted source ` +
        `"${authorize.anchor.trustedSource}". Register it in ` +
        "createGovernedToolkit({ trustedSources }).",
    );
  }

  // `approval: false` is explicitly "no approval" and `evaluateApproval`
  // treats it as such at runtime, so it must NOT count as a gate — only
  // `approval: true` or a policy function does.
  const approvalGates =
    spec.approval === true || typeof spec.approval === "function";

  // When `scope` is the ONLY thing satisfying the side-effect gate below, it
  // is load-bearing: a call for which it derives no scopes would pass the
  // scope check vacuously and run the side effect ungated, so the runtime
  // pipeline fails closed on an empty derivation for exactly this case.
  const scopeIsOnlyGate =
    Boolean(spec.sideEffect) &&
    !spec.unsafeAllowUnauthorized &&
    (spec.kind ?? "scoped") === "scoped" &&
    Boolean(spec.scope) &&
    !authorize &&
    (spec.requireRoles?.length ?? 0) === 0 &&
    !approvalGates;

  // Fail closed at definition time: a side-effecting tool must be gated.
  // The required gate differs by `kind` (the structural answer to both "the
  // check lived nowhere" and "general primitives can't be arg-scoped").
  if (spec.sideEffect && !spec.unsafeAllowUnauthorized) {
    if ((spec.kind ?? "scoped") === "primitive") {
      // A free-form payload (raw SQL, shell, arbitrary HTTP) can't be bound
      // by in-process argument scoping — enforcement must live out-of-band.
      if (!spec.egressControlled) {
        throw new GovernanceConfigError(
          spec.name,
          `Side-effecting primitive "${spec.name}" can't be governed by ` +
            "argument scoping — its payload is free-form. Bound its blast " +
            "radius out-of-band (egress allowlist / no in-sandbox credential " +
            "/ DB-level controls) and set egressControlled: true, or set " +
            "unsafeAllowUnauthorized: true to acknowledge the risk.",
        );
      }
    } else {
      const gated =
        Boolean(spec.scope) ||
        Boolean(authorize) ||
        (spec.requireRoles?.length ?? 0) > 0 ||
        approvalGates;
      if (!gated) {
        throw new GovernanceConfigError(
          spec.name,
          `Side-effecting tool "${spec.name}" has no authorization gate. ` +
            "Declare scope, authorize, requireRoles, or approval, or set " +
            "unsafeAllowUnauthorized: true to acknowledge the risk.",
        );
      }
    }
  }

  if (
    spec.timeoutMs !== undefined &&
    !(Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0)
  ) {
    throw new GovernanceConfigError(
      spec.name,
      `timeoutMs for "${spec.name}" must be a positive whole number of milliseconds.`,
    );
  }
  if (spec.guard) {
    guardTimeout(spec.guard.timeoutMs, spec.name);
    if (typeof spec.guard.evaluate !== "function") {
      throw new GovernanceConfigError(spec.name, "guard.evaluate must be a function.");
    }
  }
  return { authorize, scopeIsOnlyGate };
}
