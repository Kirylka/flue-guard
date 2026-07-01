/**
 * The governance pipeline and its composition root.
 *
 * `createGovernedToolkit` is constructed once with the cross-cutting
 * collaborators (trusted-context resolver, audit log, and optional idempotency
 * store / RBAC / approval / redaction adapters). The `defineGovernedTool` it
 * returns wraps a tool spec so that every invocation runs through the same
 * deterministic pipeline before (and after) the real handler:
 *
 *   context -> validate -> RBAC -> scope -> authorize -> approval
 *           -> idempotency -> execute -> audit
 *
 * Audit records: denials, replays, and approval-deferrals write a single
 * record. A side-effecting call writes an `executing` intent record *before*
 * the handler runs (so a side effect can never run unrecorded) and an outcome
 * record after; non-side-effecting calls write the single outcome record.
 * Governance rejections raise a `GovernanceError` subclass (including
 * `ApprovalPendingError`, a suspend signal); handler failures propagate the
 * original error.
 */

import type {
  ArgValidator,
  ExecutionContext,
  FlueCompatibleTool,
  InferArgs,
  ParseValidator,
  StandardSchemaV1,
  TrustedContext,
} from "./types.js";
import { ContextStore, type ContextResolver } from "./context.js";
import { HashChainAuditLog, type AuditLog, type AuditInput } from "./audit.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import { defaultRbac, type RbacAdapter } from "./rbac.js";
import {
  type ApprovalAdapter,
  type ApprovalPolicy,
} from "./approval.js";
import { defaultRedactor, type Redactor } from "./redaction.js";
import { deniedScopes, normalizeScopes } from "./scope.js";
import { toFlueTool, type FlueToolDefinition } from "./flue.js";
import {
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalPendingError,
  AuthorizationDeniedError,
  GovernanceConfigError,
  GovernanceError,
  IdempotencyConflictError,
  ScopeViolationError,
} from "./errors.js";

/**
 * A declared trusted source: a server-side lookup whose result is a trustworthy
 * anchor to compare an (untrusted) argument against — e.g. "the email on file
 * for this account". Registered on the toolkit and referenced by name.
 */
export type TrustedSource = (
  args: any,
  ctx: TrustedContext,
) => unknown | Promise<unknown>;

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
 * execution context — key the decision to `ctx.actor`. Prefer this helper over
 * the raw object: `args` is inferred (it's pinned by the tool's `parameters`),
 * and the call site reads lighter.
 *
 * ```ts
 * authorize: caller((a, ctx) => owns(ctx.actor.id, a.accountId))
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
 * authenticated actor. `args` is inferred.
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
  /** Derive the resource scope(s) this specific call will touch. */
  scope?: (args: TArgs, ctx: TrustedContext) => string | string[];
  /**
   * Authorization for "is this caller allowed to do this to this target?",
   * keyed to a declared trusted anchor (caller identity or a trusted source).
   * See {@link AuthorizeSpec}.
   */
  authorize?: AuthorizeSpec<TArgs>;
  /**
   * Idempotency policy for side-effectful writes. `key` must return a stable,
   * non-empty string (an empty key is rejected, not treated as "no
   * idempotency"). The key is recorded in the audit log for correlation, so it
   * must not embed secrets — unlike args/results, it is not redacted.
   */
  idempotency?: {
    key: (args: TArgs, ctx: TrustedContext) => string;
    ttlMs?: number;
  };
  /** Approval policy. */
  approval?: ApprovalPolicy<TArgs>;
  /** Redact args/result before they go to the audit log (per-tool override). */
  redact?: Redactor;
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

/** Flue's `defineTool`, injected so the core stays free of any Flue import. */
export type FlueDefineTool = (tool: FlueToolDefinition) => FlueToolDefinition;

export interface GovernedToolkitOptions {
  /**
   * Trusted-context source (never model output). Omit it to use the toolkit's
   * built-in {@link ContextStore} via `toolkit.run(...)` (the common case);
   * pass your own `ContextStore` to share one; or pass a resolver function for
   * a custom binding (then `toolkit.run` is unavailable — you bind it yourself).
   */
  context?: ContextStore | ContextResolver;
  /** Audit sink — an {@link AuditLog}, or a file path string (hash-chained JSONL). */
  audit: AuditLog | string;
  /** Idempotency store. Defaults to a process-local in-memory store. */
  idempotencyStore?: IdempotencyStore;
  /**
   * Declared trusted sources for `authorize: { anchor: { trustedSource } }`.
   * Server-side lookups whose results are trustworthy anchors (e.g. the email
   * on file for an account). Referenced by name; an unknown name is rejected at
   * definition.
   */
  trustedSources?: Record<string, TrustedSource>;
  /**
   * Flue's `defineTool` (from `@flue/runtime`). Provide it to enable the
   * one-call {@link GovernedToolkit.tool} helper.
   */
  defineTool?: FlueDefineTool;
  /** RBAC adapter (defaults to any-of role matching). */
  rbac?: RbacAdapter;
  /** Approval adapter (fail-closed if a tool requires approval without one). */
  approval?: ApprovalAdapter;
  /** Default redactor applied to all tools (defaults to {@link defaultRedactor}). */
  redaction?: Redactor;
  /** Injectable clock for deterministic audit timestamps in tests. */
  clock?: () => number;
}

export interface GovernedToolkit {
  defineGovernedTool<TArgs = Record<string, unknown>, TResult = unknown>(
    spec: GovernedToolSpec<TArgs, TResult>,
  ): FlueCompatibleTool;
  /**
   * Derive a toolkit that resolves the trusted context from a fixed value (or a
   * given resolver) instead of the ambient one. Use this for Flue's dispatched
   * / addressable-agent pattern, where tool calls run detached from the caller
   * so `ContextStore` (AsyncLocalStorage) can't reach them: bind the context
   * per invocation inside `createAgent`, derived from `ctx.payload`/`ctx.env`.
   * All other collaborators (audit, idempotency, adapters) are shared.
   */
  withContext(context: TrustedContext | ContextResolver): GovernedToolkit;
  /**
   * One-call helper: define a governed tool and return a ready-to-use Flue
   * `ToolDefinition` (equivalent to `defineTool(toFlueTool(defineGovernedTool(
   * spec)))`). Argument types are inferred from `parameters`. Requires
   * `defineTool` to have been passed to {@link createGovernedToolkit}.
   */
  tool<S extends StandardSchemaV1, TResult = unknown>(
    spec: GovernedFlueToolSpec<S, TResult>,
  ): FlueToolDefinition;
  /**
   * Bind the trusted context for `fn` (and every governed tool it triggers)
   * using the toolkit's built-in `ContextStore`. The edge-boundary call:
   * `await toolkit.run(trustedContext, () => harness.prompt(text))`. Unavailable
   * if you constructed the toolkit with a custom resolver function.
   */
  run<T>(context: TrustedContext, fn: () => T): T;
  /** The current trusted context, or throw if not inside `run(...)`. */
  current(): TrustedContext;
  /** The current trusted context, or `undefined` if not inside `run(...)`. */
  peek(): TrustedContext | undefined;
}

function makeValidator<T>(v?: ArgValidator<T>): (input: unknown) => T {
  if (!v) return (input) => input as T;
  if (typeof v === "function") return v as (input: unknown) => T;
  const maybeParse = (v as { parse?: unknown }).parse;
  if (typeof maybeParse === "function") {
    return (input) => (v as ParseValidator<T>).parse(input);
  }
  // Opaque host schema (e.g. Flue/Valibot, TypeBox): the host validates it;
  // arguments arrive already parsed, so pass them through unchanged.
  return (input) => input as T;
}

function errorCode(err: unknown): string {
  if (err instanceof GovernanceError) return err.code;
  return err instanceof Error ? err.message : String(err);
}

/** Resolve whether an approval policy is triggered for this call. */
function evaluateApproval<TArgs>(
  policy: ApprovalPolicy<TArgs> | undefined,
  args: TArgs,
  ctx: TrustedContext,
): { needed: boolean; reason?: string } {
  if (policy === undefined || policy === false) return { needed: false };
  if (policy === true) return { needed: true };
  const result = policy(args, ctx);
  if (typeof result === "string") return { needed: true, reason: result };
  return { needed: Boolean(result) };
}

export function createGovernedToolkit(
  options: GovernedToolkitOptions,
): GovernedToolkit {
  const rbac = options.rbac ?? defaultRbac;
  const baseRedactor = options.redaction ?? defaultRedactor;
  const idempotencyStore =
    options.idempotencyStore ?? new InMemoryIdempotencyStore();
  const defineToolFn = options.defineTool;
  const auditLog: AuditLog =
    typeof options.audit === "string"
      ? new HashChainAuditLog({ path: options.audit })
      : options.audit;
  const timestamp = (): string | undefined =>
    options.clock ? new Date(options.clock()).toISOString() : undefined;

  // The toolkit owns a ContextStore unless you pass your own (or a resolver).
  const store: ContextStore | undefined =
    options.context instanceof ContextStore
      ? options.context
      : options.context === undefined
        ? new ContextStore()
        : undefined; // a custom resolver function — no store to drive run()
  const rootResolver: ContextResolver =
    typeof options.context === "function" ? options.context : store!.resolver();
  const requireStore = (): ContextStore => {
    if (!store) {
      throw new GovernanceConfigError(
        "toolkit",
        "toolkit.run/current/peek need a ContextStore. Omit `context` to use " +
          "the built-in one, or pass a ContextStore — not a resolver function.",
      );
    }
    return store;
  };

  // Build a toolkit bound to a specific context resolver; `withContext` derives
  // siblings that share everything else but resolve the context differently.
  const build = (resolveContext: ContextResolver): GovernedToolkit => {
    const withContext = (
      context: TrustedContext | ContextResolver,
    ): GovernedToolkit =>
      build(typeof context === "function" ? context : () => context);

    const tool = <S extends StandardSchemaV1, TResult = unknown>(
      spec: GovernedFlueToolSpec<S, TResult>,
    ): FlueToolDefinition => {
      if (!defineToolFn) {
        throw new GovernanceConfigError(
          spec.name,
          "toolkit.tool() needs Flue's defineTool. Pass `defineTool` to " +
            "createGovernedToolkit, or use defineGovernedTool + toFlueTool.",
        );
      }
      return defineToolFn(
        toFlueTool(
          defineGovernedTool(
            spec as unknown as GovernedToolSpec<InferArgs<S>, TResult>,
          ),
        ),
      );
    };

    return {
      defineGovernedTool,
      withContext,
      tool,
      run: <T>(context: TrustedContext, fn: () => T) =>
        requireStore().run(context, fn),
      current: () => requireStore().current(),
      peek: () => requireStore().peek(),
    };

    function defineGovernedTool<TArgs, TResult>(
      spec: GovernedToolSpec<TArgs, TResult>,
    ): FlueCompatibleTool {
    // `authorize` is keyed to a declared anchor (caller or a trusted source),
    // so there's no arg-only shape to reject. We only check that a referenced
    // trusted source actually exists.
    if (
      spec.authorize &&
      typeof spec.authorize.anchor === "object" &&
      !(spec.authorize.anchor.trustedSource in (options.trustedSources ?? {}))
    ) {
      throw new GovernanceConfigError(
        spec.name,
        `authorize for "${spec.name}" references unknown trusted source ` +
          `"${spec.authorize.anchor.trustedSource}". Register it in ` +
          "createGovernedToolkit({ trustedSources }).",
      );
    }

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
        // `approval: false` is explicitly "no approval" and `evaluateApproval`
        // treats it as such at runtime, so it must NOT count as a gate here —
        // only `approval: true` or a policy function does.
        const approvalGates =
          spec.approval === true || typeof spec.approval === "function";
        const gated =
          Boolean(spec.scope) ||
          Boolean(spec.authorize) ||
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

    const validate = makeValidator(spec.parameters);
    const redactor = spec.redact ?? baseRedactor;
    const audit = (input: AuditInput) =>
      auditLog.append({
        ...input,
        ts: input.ts ?? timestamp(),
        // Run error strings through the same redactor as args/results — an
        // exception message can carry a secret the handler touched. (Fixed
        // governance codes like "scope_violation" pass through unchanged.)
        ...(typeof input.error === "string"
          ? { error: String(redactor(input.error)) }
          : {}),
      });

    const execute = async (
      rawArgs: unknown,
      hostContext?: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      // 1. Resolve trusted context (fail-closed; we still record the denial).
      let ctx: TrustedContext;
      try {
        ctx = await resolveContext(hostContext);
      } catch (err) {
        await audit({
          actorId: "unknown",
          tenantId: "unknown",
          tool: spec.name,
          decision: "deny",
          outcome: "denied",
          requestedScopes: [],
          error: errorCode(err),
        });
        throw err;
      }

      const base = {
        actorId: ctx.actor.id,
        tenantId: ctx.tenantId,
        tool: spec.name,
        requestId: ctx.requestId,
        // Flag broad tools in the audit; omit for the common scoped case so
        // existing entries are unchanged.
        ...(spec.kind === "primitive" ? { kind: "primitive" as const } : {}),
      };

      // Whether this call's outcome has already been written to the audit log.
      // Set at each handled exit so the catch-all below records exactly the
      // exceptions no pipeline step recorded (F5), never double-recording one.
      let audited = false;
      let requested: string[] = [];
      let redactedArgs: unknown;

      try {
        // 2. Validate arguments.
        let args: TArgs;
        try {
          args = validate(rawArgs);
        } catch (err) {
          await audit({
            ...base,
            decision: "deny",
            outcome: "denied",
            requestedScopes: [],
            args: redactor(rawArgs),
            error: `invalid_arguments: ${errorCode(err)}`,
          });
          audited = true;
          throw err;
        }

        redactedArgs = redactor(args);
        requested = normalizeScopes(spec.scope?.(args, ctx));
        const execCtx: ExecutionContext = {
          ...ctx,
          authorizedScopes: requested,
          host: hostContext,
          signal,
        };

        const denyAudit = (error: string, extra: Partial<AuditInput> = {}) => {
          audited = true;
          return audit({
            ...base,
            decision: "deny",
            outcome: "denied",
            requestedScopes: requested,
            args: redactedArgs,
            error,
            ...extra,
          });
        };

        // 3. RBAC.
        const requiredRoles = spec.requireRoles ?? [];
        if (!(await rbac.can({ tool: spec.name, requiredRoles, ctx }))) {
          await denyAudit("access_denied");
          throw new AccessDeniedError(spec.name, requiredRoles);
        }

        // 4. Scope / tenant isolation.
        const allowedScopes = ctx.scopes ?? [];
        const denied = deniedScopes(requested, allowedScopes);
        if (denied.length > 0) {
          await denyAudit("scope_violation");
          throw new ScopeViolationError(spec.name, denied, allowedScopes);
        }

        // 5. Authorization, keyed to a declared trusted anchor.
        if (spec.authorize) {
          const a = spec.authorize;
          const ok =
            a.anchor === "caller"
              ? await a.check(args, execCtx)
              : await a.check(
                  args,
                  await options.trustedSources![a.anchor.trustedSource]!(args, ctx),
                );
          if (!ok) {
            await denyAudit("authorization_denied");
            throw new AuthorizationDeniedError(spec.name);
          }
        }

        // 6. Approval (only when a policy is declared and triggered).
        let approver: string | undefined;
        const approval = evaluateApproval(spec.approval, args, ctx);
        if (approval.needed) {
          if (!options.approval) {
            await denyAudit("approval_denied");
            throw new ApprovalDeniedError(
              spec.name,
              "no approval adapter configured",
            );
          }
          const decision = await options.approval.request({
            tool: spec.name,
            args,
            ctx,
            reason: approval.reason,
          });
          if (decision.pending) {
            // Suspend, don't block: record the deferral and let the harness
            // pause and resume (which re-invokes the tool). No side effect runs.
            await audit({
              ...base,
              decision: "defer",
              outcome: "pending",
              requestedScopes: requested,
              args: redactedArgs,
              approver: decision.approver,
              error: decision.ref ? `approval_pending:${decision.ref}` : undefined,
            });
            audited = true;
            throw new ApprovalPendingError(
              spec.name,
              decision.ref,
              decision.reason ?? approval.reason,
            );
          }
          if (!decision.approved) {
            await denyAudit("approval_denied", { approver: decision.approver });
            throw new ApprovalDeniedError(
              spec.name,
              decision.reason ?? approval.reason,
            );
          }
          approver = decision.approver;
        }

        // For side effects, record an intent BEFORE executing. If this append
        // fails we throw here, so a side effect can never run unrecorded. The
        // outcome record is written after. (Non-side-effect tools write only the
        // single outcome record.)
        const writeIntent = (idempotencyKey?: string): Promise<unknown> =>
          spec.sideEffect
            ? audit({
                ...base,
                decision: "allow",
                outcome: "executing",
                requestedScopes: requested,
                args: redactedArgs,
                approver,
                idempotencyKey,
              })
            : Promise.resolve(undefined);

        const runAndAudit = async (
          idempotencyKey?: string,
        ): Promise<TResult> => {
          await writeIntent(idempotencyKey);
          try {
            const result = await spec.execute(args, execCtx);
            await audit({
              ...base,
              decision: "allow",
              outcome: "success",
              requestedScopes: requested,
              args: redactedArgs,
              result: redactor(result),
              approver,
              idempotencyKey,
            });
            return result;
          } catch (err) {
            await audit({
              ...base,
              decision: "allow",
              outcome: "error",
              requestedScopes: requested,
              args: redactedArgs,
              error: errorCode(err),
              approver,
              idempotencyKey,
            });
            audited = true;
            throw err;
          }
        };

        // 7. Idempotency (only when a policy is declared).
        if (spec.idempotency) {
          const rawKey = spec.idempotency.key(args, ctx);
          // An empty key must be rejected, never treated as "no idempotency" —
          // that silently let the side effect run on every retry.
          if (typeof rawKey !== "string" || rawKey.length === 0) {
            throw new GovernanceConfigError(
              spec.name,
              `idempotency.key for "${spec.name}" produced an empty key. Return a ` +
                "stable, non-empty key, or omit idempotency for this tool.",
            );
          }
          // Namespace by tool so the same key string in two different tools
          // can't collide and cross-replay (F3). JSON-encode the pair rather than
          // joining with a delimiter, so (tool "a:b", key "c") and (tool "a", key
          // "b:c") don't both collapse to "a:b:c". The audit keeps the raw key
          // for readability — `tool` already disambiguates which tool it's for.
          const effectiveKey = JSON.stringify([spec.name, rawKey]);
          const store = idempotencyStore;
          const begin = await store.begin(
            ctx.tenantId,
            effectiveKey,
            spec.idempotency?.ttlMs,
          );

          if (begin.status === "replay") {
            await audit({
              ...base,
              decision: "allow",
              outcome: "replayed",
              requestedScopes: requested,
              args: redactedArgs,
              result: redactor(begin.record.result),
              approver,
              idempotencyKey: rawKey,
            });
            return begin.record.result;
          }

          if (begin.status === "in_flight") {
            await denyAudit("idempotency_conflict", { idempotencyKey: rawKey });
            throw new IdempotencyConflictError(spec.name, rawKey);
          }

          // status === "started".
          try {
            await writeIntent(rawKey);
          } catch (err) {
            // Intent record failed, before any side effect — release the key.
            await store.fail(ctx.tenantId, effectiveKey);
            throw err;
          }

          let result: TResult;
          try {
            result = await spec.execute(args, execCtx);
          } catch (err) {
            // The handler failed: the side effect did not complete, so release
            // the key for a clean retry.
            await store.fail(ctx.tenantId, effectiveKey);
            await audit({
              ...base,
              decision: "allow",
              outcome: "error",
              requestedScopes: requested,
              args: redactedArgs,
              error: errorCode(err),
              approver,
              idempotencyKey: rawKey,
            });
            audited = true;
            throw err;
          }

          // The handler succeeded: the external side effect HAS happened. From
          // here we must never release the key, or a retry would duplicate it
          // (F4). If completion can't even be recorded, leave the key in_flight
          // so a retry is refused (a conflict) rather than silently re-run, and
          // record the gap. True exactly-once across this window needs a
          // transactional store or a downstream idempotency token.
          try {
            await store.complete(ctx.tenantId, effectiveKey, result);
          } catch (err) {
            await audit({
              ...base,
              decision: "allow",
              outcome: "error",
              requestedScopes: requested,
              args: redactedArgs,
              error: `idempotency_completion_unrecorded: ${errorCode(err)}`,
              approver,
              idempotencyKey: rawKey,
            });
            audited = true;
            throw err;
          }

          await audit({
            ...base,
            decision: "allow",
            outcome: "success",
            requestedScopes: requested,
            args: redactedArgs,
            result: redactor(result),
            approver,
            idempotencyKey: rawKey,
          });
          return result;
        }

        // 8. No idempotency: execute and audit.
        return await runAndAudit();
      } catch (err) {
        // A governance/infrastructure step threw without recording an outcome
        // (scope derivation, RBAC, authorize, a trusted source, an approval or
        // idempotency-store call). Record it so "every decision is on the chain"
        // holds, then propagate (F5).
        if (!audited) {
          try {
            await audit({
              ...base,
              decision: "deny",
              outcome: "error",
              requestedScopes: requested,
              args: redactedArgs,
              error: `governance_error: ${errorCode(err)}`,
            });
          } catch {
            // The audit sink itself is failing — don't mask the original error.
          }
        }
        throw err;
      }
    };

    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      execute,
    };
    }
  };

  return build(rootResolver);
}
