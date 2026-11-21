/**
 * The tool spec a developer writes, and the helpers that build its parts.
 * Types only, apart from `caller` and `trusted`; the pipeline that enforces
 * them lives in toolkit.ts.
 */

import type { ApprovalPolicy } from "./approval.js";
import type { FlueToolDefinition } from "./flue.js";
import type { ToolGuard } from "./guard.js";
import type { Redactor } from "./redaction.js";
import type {
  ArgValidator,
  ExecutionContext,
  InferArgs,
  StandardSchemaV1,
  TrustedContext,
} from "./types.js";

/**
 * A declared trusted source: a server-side lookup whose result is a trustworthy
 * anchor to compare an (untrusted) argument against — e.g. "the email on file
 * for this account". Registered on the toolkit and referenced by name.
 */
export type TrustedSource = (
  // Sources are registered once per toolkit and shared by tools with
  // different argument types, so the argument type cannot be narrower.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  ctx: TrustedContext,
) => unknown | Promise<unknown>;

/**
 * A check keyed to the authenticated caller, written as a plain function.
 * Same as `caller(check)`; with `gov.tool`, a plain function is the form whose
 * `args` type TypeScript infers from `parameters`.
 */
export type CallerCheck<TArgs> = (
  args: TArgs,
  ctx: ExecutionContext,
) => boolean | Promise<boolean>;

/**
 * Authorization keyed to a *declared trusted anchor*, not to the arguments
 * alone — so the manifest can record the anchor honestly and the common footgun
 * (comparing an arg to nothing trusted) has no shape to be written in.
 *
 *  - `anchor: "caller"` → `check` receives the trusted execution context; key
 *    the decision to `ctx.actor` (e.g. `owns(ctx.actor.id, a.accountId)`).
 *  - `anchor: { trustedSource }` → the named source is resolved server-side and
 *    its value passed to `check` (e.g. `a.resetEmail === source`) — for
 *    anonymous-recovery-style checks where there is no authenticated actor.
 */
export type AuthorizeSpec<TArgs> =
  | CallerCheck<TArgs>
  | {
      anchor: "caller";
      check: (args: TArgs, ctx: ExecutionContext) => boolean | Promise<boolean>;
    }
  | {
      anchor: { trustedSource: string };
      check: (args: TArgs, source: unknown) => boolean | Promise<boolean>;
    };

/**
 * Authorize keyed to the authenticated caller. The check receives the trusted
 * execution context — key the decision to `ctx.actor`. Same as passing the
 * check itself as `authorize`.
 *
 * With `gov.tool`, TypeScript cannot infer `args` through this helper (it is
 * a nested generic call, typed before `parameters` is), so either annotate
 * `args` or pass the plain function, which is inferred:
 *
 * ```ts
 * authorize: (a, ctx) => owns(ctx.actor.id, a.accountId)
 * ```
 */
export function caller<TArgs = Record<string, unknown>>(
  check: (args: TArgs, ctx: ExecutionContext) => boolean | Promise<boolean>,
): AuthorizeSpec<TArgs> {
  return { anchor: "caller", check };
}

/**
 * Authorize against a registered trusted source (resolved server-side and
 * passed to the check) — for anonymous-recovery-style checks with no
 * authenticated actor. With `gov.tool`, annotate `args`; see {@link caller}.
 *
 * ```ts
 * authorize: trusted("accountEmail", (a, email) => a.resetEmail === email)
 * ```
 */
export function trusted<TArgs = Record<string, unknown>>(
  source: string,
  check: (args: TArgs, value: unknown) => boolean | Promise<boolean>,
): AuthorizeSpec<TArgs> {
  return { anchor: { trustedSource: source }, check };
}

/** The spec a developer authors for a governed tool. */
export interface GovernedToolSpec<TArgs, TResult> {
  name: string;
  description: string;
  /** Argument schema (zod-like or a function). Optional. */
  parameters?: ArgValidator<TArgs>;
  /** Marks this tool as producing an external, real-world side effect. */
  sideEffect?: boolean;
  /** Roles required to call (any-of, via the RBAC adapter). */
  requireRoles?: string[];
  /**
   * Derive the resource scope(s) this specific call will touch. Scope strings
   * are recorded in the audit log for matching/forensics, so like idempotency
   * keys they are NOT redacted — build them from stable ids, not secrets. If
   * `scope` is a side-effecting tool's only gate, deriving no scopes for a
   * call is refused (fail closed) rather than treated as "in scope".
   */
  scope?: (args: TArgs, ctx: TrustedContext) => string | string[];
  /**
   * Authorization for "is this caller allowed to do this to this target?",
   * keyed to a declared trusted anchor (caller identity or a trusted source).
   * See {@link AuthorizeSpec}.
   */
  authorize?: AuthorizeSpec<TArgs>;
  /** Optional semantic gate, evaluated after authorization and before approval. */
  guard?: ToolGuard<TArgs>;
  /**
   * Idempotency policy for side-effectful writes. `key` must return a stable,
   * non-empty string (an empty key is rejected, not treated as "no
   * idempotency"). The key is recorded in the audit log for correlation, so it
   * must not embed secrets — unlike args/results, it is not redacted.
   */
  idempotency?: {
    /**
     * `ctx.toolCallId` is the host's id for this call, when it gives one (Flue
     * does). It only dedupes re-runs of the same call: a call the model makes
     * again, including the one after an approval, gets a new id.
     */
    key: (args: TArgs, ctx: TrustedContext & { toolCallId?: string }) => string;
    ttlMs?: number;
  };
  /** Approval policy. */
  approval?: ApprovalPolicy<TArgs>;
  /**
   * May *this* approver sign off *this* call? Consulted only after an approval
   * adapter returns an approval, so it answers a question the policy cannot:
   * the policy decides whether a human is needed, this decides which human
   * counts. The usual rule is that the caller may not approve their own call:
   * `canApprove: (approver, args, ctx) => approver !== ctx.actor.id`.
   *
   * Fail-closed: declare it and an approval that names no approver is refused,
   * because there is nobody to check.
   */
  canApprove?: (
    approver: string,
    args: TArgs,
    ctx: TrustedContext,
  ) => boolean | Promise<boolean>;
  /** Redact args/result before they go to the audit log (per-tool override). */
  redact?: Redactor;
  /**
   * Shape only what the model sees of the result. The audit log still records
   * the full result (through the redactor); the value returned to the
   * host/model is this function's output.
   */
  toModelOutput?: (result: TResult, ctx: ExecutionContext) => unknown;
  /**
   * How the tool's arguments relate to its blast radius (default `"scoped"`):
   *  - `"scoped"`: structured args with a real target — fully governable
   *    in-process by scope/authorize.
   *  - `"primitive"`: a free-form payload (raw SQL, shell, arbitrary HTTP, a
   *    code interpreter). Argument scoping can't constrain it, so a
   *    side-effecting primitive must be bounded out-of-band (see
   *    {@link egressControlled}). Primitives are flagged as broad in the audit.
   */
  kind?: "scoped" | "primitive";
  /**
   * For a side-effecting `primitive`: your **attestation** that its blast radius
   * is bounded out-of-band (egress allowlist, no in-sandbox credential,
   * DB-level controls), since in-process argument scoping cannot bound it.
   *
   * This is NOT verified or enforced by the library — it can't check your egress
   * config. Setting it only lets the tool define; the containment is the
   * substrate's job. The library's contribution is to refuse to silently
   * certify a primitive as governed and to flag it broad in the audit.
   */
  egressControlled?: boolean;
  /**
   * Escape hatch: allow a `sideEffect` tool to be defined with no authorization
   * gate (scope/authorize/requireRoles/approval). Off by default — an ungated
   * side-effecting tool is how account-takeover bugs ship, so we refuse it
   * unless you say so explicitly.
   */
  unsafeAllowUnauthorized?: boolean;
  /**
   * Bound on one call, in milliseconds, forwarded to Flue's tool `timeoutMs`.
   * Flue 2.3+ aborts `ctx.signal` when it expires and tells the model the call
   * timed out; older Flue versions ignore it. The governance checks count
   * against it too.
   */
  timeoutMs?: number;
  /** The real handler. Receives validated args and the execution context. */
  execute: (args: TArgs, ctx: ExecutionContext) => Promise<TResult> | TResult;
}

/**
 * The spec for {@link GovernedToolkit.tool}: same as {@link GovernedToolSpec},
 * but `parameters` is a Standard Schema (e.g. a Valibot `v.object(...)`) and the
 * argument type of every callback is **inferred** from it — no need to restate
 * it as a generic.
 */
export type GovernedFlueToolSpec<S extends StandardSchemaV1, TResult> = Omit<
  GovernedToolSpec<InferArgs<S>, TResult>,
  "parameters"
> & { parameters: S };

/**
 * The part of Flue's `DeliveredMessage` (from `useDelivery()`) that
 * {@link GovernedToolkit.withSignal} reads.
 */
export type SignalDelivery =
  | { kind: "signal"; attributes?: Record<string, string> }
  | { kind: string; attributes?: undefined };

/** Flue's `defineTool`, injected so the core stays free of any Flue import. */
export type FlueDefineTool = (tool: FlueToolDefinition) => FlueToolDefinition;
