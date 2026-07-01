/**
 * Error types raised by the governance layer.
 *
 * All extend {@link GovernanceError} so callers (and the agent harness) can
 * distinguish a governance rejection from an ordinary handler failure. Use the
 * {@link isGovernanceError}, {@link isGovernanceDenial}, and
 * {@link isApprovalPending} guards to branch without `instanceof` chains.
 */

/** Every machine-readable code a {@link GovernanceError} can carry. */
export type GovernanceErrorCode =
  | "missing_context"
  | "access_denied"
  | "scope_violation"
  | "authorization_denied"
  | "approval_denied"
  | "approval_pending"
  | "idempotency_conflict"
  | "config_error";

export class GovernanceError extends Error {
  /** Machine-readable code, e.g. `"scope_violation"`. */
  readonly code: GovernanceErrorCode;
  /** The tool the decision applied to, when known. */
  readonly tool?: string;

  constructor(code: GovernanceErrorCode, message: string, tool?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.tool = tool;
  }
}

/** No trusted context was available when a governed tool was invoked. */
export class MissingContextError extends GovernanceError {
  constructor(tool?: string) {
    super(
      "missing_context",
      "No trusted context was resolved for this tool call. A governed tool " +
        "must run inside a context (see ContextStore.run / the toolkit's " +
        "`context` resolver).",
      tool,
    );
  }
}

/** The actor lacked a required role. */
export class AccessDeniedError extends GovernanceError {
  readonly requiredRoles: string[];

  constructor(tool: string, requiredRoles: string[]) {
    super(
      "access_denied",
      `Actor is not permitted to call "${tool}". Requires one of: ` +
        requiredRoles.join(", "),
      tool,
    );
    this.requiredRoles = requiredRoles;
  }
}

/** The call targeted a resource outside the actor's allowed scopes. */
export class ScopeViolationError extends GovernanceError {
  readonly requested: string[];
  readonly allowed: string[];

  constructor(tool: string, requested: string[], allowed: string[]) {
    super(
      "scope_violation",
      requested.length === 0
        ? `"${tool}" is gated only by scope but derived no scopes for this ` +
            "call, so the gate cannot apply — refusing (fail closed). Derive " +
            "at least one scope for every call, or declare another gate."
        : `"${tool}" attempted to act on scope(s) [${requested.join(", ")}] ` +
            `outside the actor's allowed scopes [${allowed.join(", ")}].`,
      tool,
    );
    this.requested = requested;
    this.allowed = allowed;
  }
}

/** A tool's `authorize` predicate rejected the call. */
export class AuthorizationDeniedError extends GovernanceError {
  constructor(tool: string, reason?: string) {
    super(
      "authorization_denied",
      `"${tool}" was not authorized for this caller/target` +
        (reason ? `: ${reason}` : "."),
      tool,
    );
  }
}

/**
 * A governed tool was defined unsafely — e.g. a side-effecting tool with no
 * authorization gate. Thrown at definition time, not per call.
 */
export class GovernanceConfigError extends GovernanceError {
  constructor(tool: string, message: string) {
    super("config_error", message, tool);
  }
}

/**
 * Approval is required and not yet decided. This is a *suspend* signal, not a
 * denial: the harness should pause the run (persisting whatever it needs) and
 * resume — re-invoking the tool — once the approval is resolved. `ref` carries
 * the adapter's handle for the pending approval (e.g. a ticket id).
 */
export class ApprovalPendingError extends GovernanceError {
  readonly ref?: string;

  constructor(tool: string, ref?: string, reason?: string) {
    super(
      "approval_pending",
      `"${tool}" is awaiting approval` + (reason ? `: ${reason}` : ".") +
        (ref ? ` (ref: ${ref})` : ""),
      tool,
    );
    this.ref = ref;
  }
}

/** Human (or external) approval was required and not granted. */
export class ApprovalDeniedError extends GovernanceError {
  constructor(tool: string, reason?: string) {
    super(
      "approval_denied",
      `"${tool}" requires approval which was not granted` +
        (reason ? `: ${reason}` : "."),
      tool,
    );
  }
}

/** A concurrent call holds the same idempotency key. */
export class IdempotencyConflictError extends GovernanceError {
  readonly key: string;

  constructor(tool: string, key: string) {
    super(
      "idempotency_conflict",
      `Another in-flight call to "${tool}" already holds idempotency key ` +
        `"${key}".`,
      tool,
    );
    this.key = key;
  }
}

/**
 * Codes that mean governance *refused* the call. Excludes `approval_pending`
 * (a suspend signal, not a denial) and `config_error` (a definition-time bug,
 * never thrown at call time).
 */
const DENIAL_CODES: ReadonlySet<GovernanceErrorCode> = new Set([
  "missing_context",
  "access_denied",
  "scope_violation",
  "authorization_denied",
  "approval_denied",
  "idempotency_conflict",
]);

/** True for any error raised by the governance layer. */
export function isGovernanceError(err: unknown): err is GovernanceError {
  return err instanceof GovernanceError;
}

/**
 * True when the governance layer refused the call (scope, authorization, RBAC,
 * approval denial, missing context, idempotency conflict) — i.e. the model
 * should be told it isn't allowed, not that the tool failed. Excludes the
 * approval-pending suspend signal; use {@link isApprovalPending} for that.
 */
export function isGovernanceDenial(err: unknown): err is GovernanceError {
  return err instanceof GovernanceError && DENIAL_CODES.has(err.code);
}

/** True for the suspend signal: approval is required and not yet decided. */
export function isApprovalPending(err: unknown): err is ApprovalPendingError {
  return err instanceof ApprovalPendingError;
}
