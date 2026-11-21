/**
 * The governance pipeline and its composition root.
 *
 * `createGovernedToolkit` is constructed once with the cross-cutting
 * collaborators (trusted-context resolver, audit log, and optional idempotency
 * store / RBAC / approval / redaction adapters). The `defineGovernedTool` it
 * returns wraps a tool spec so that every invocation runs through the same
 * deterministic pipeline before (and after) the real handler:
 *
 *   context -> validate -> RBAC -> scope -> authorize -> guard -> approval
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
  ExecutionContext,
  FlueCompatibleTool,
  InferArgs,
  StandardSchemaV1,
  ToolCallInfo,
  TrustedContext,
} from "./types.js";
import { checkSpec } from "./check-spec.js";
import type {
  FlueDefineTool,
  GovernedFlueToolSpec,
  GovernedToolSpec,
  SignalDelivery,
  TrustedSource,
} from "./spec.js";
import { makeValidator } from "./validate.js";
import { ContextStore, type ContextResolver } from "./context.js";
import {
  GENESIS_HASH,
  HashChainAuditLog,
  type AuditLog,
  type AuditInput,
} from "./audit.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import { defaultRbac, type RbacAdapter } from "./rbac.js";
import {
  type ApprovalAdapter,
  type ApprovalPolicy,
} from "./approval.js";
import { evaluateGuard, type GuardAssessment } from "./guard.js";
import { defaultRedactor, type Redactor } from "./redaction.js";
import { deniedScopes, normalizeScopes } from "./scope.js";
import { toFlueTool, type FlueToolDefinition } from "./flue.js";
import {
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalPendingError,
  AuthorizationDeniedError,
  GuardDeniedError,
  GuardUnavailableError,
  GovernanceConfigError,
  GovernanceError,
  IdempotencyConflictError,
  MissingContextError,
  ScopeViolationError,
} from "./errors.js";

export { caller, trusted } from "./spec.js";
export type {
  AuthorizeSpec,
  CallerCheck,
  FlueDefineTool,
  GovernedFlueToolSpec,
  GovernedToolSpec,
  SignalDelivery,
  TrustedSource,
} from "./spec.js";

/**
 * Sink for `audit: false`. The pipeline always writes its outcome somewhere, so
 * opting out needs a sink rather than a branch at every call site. Nothing is
 * kept: the returned record exists only to satisfy the {@link AuditLog}
 * contract, and the toolkit never reads it.
 */
const discardedAudit: AuditLog = {
  async append(input: AuditInput) {
    return {
      ...input,
      seq: 0,
      prevHash: GENESIS_HASH,
      ts: input.ts ?? new Date().toISOString(),
      hash: "",
    };
  },
  async entries() {
    return [];
  },
};

export interface GovernedToolkitOptions {
  /**
   * Trusted-context source (never model output). Omit it to use the toolkit's
   * built-in {@link ContextStore} via `toolkit.run(...)` (the common case);
   * pass your own `ContextStore` to share one; or pass a resolver function for
   * a custom binding (then `toolkit.run` is unavailable — you bind it yourself).
   */
  context?: ContextStore | ContextResolver;
  /**
   * Audit sink — an {@link AuditLog}, or a file path string (hash-chained
   * JSONL). Required, so you cannot end up without a record by forgetting it:
   * pass `false` to say out loud that this toolkit keeps none. Governance
   * decisions still hold with `false`; you just lose the receipt.
   */
  audit: AuditLog | string | false;
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
   * per render inside the agent function, derived from authenticated
   * `useDelivery()` signal attributes.
   * All other collaborators (audit, idempotency, adapters) are shared.
   */
  withContext(context: TrustedContext | ContextResolver): GovernedToolkit;
  /**
   * `withContext` for a Flue delivery. Pass `useDelivery()` and a function that
   * maps the signal's attributes to the trusted context, or returns `undefined`
   * when they don't name a caller. When the delivery is not a signal, has no
   * attributes, or `toContext` returns `undefined`, governed tools refuse
   * every call with {@link MissingContextError}; if `toContext` throws, they
   * refuse with that error. Either way the refusal is logged and the agent
   * itself still runs, so it can answer without tools.
   *
   * Only use it for signals your own server sent after authenticating the
   * caller: the attributes are trusted as they are.
   */
  withSignal(
    delivery: SignalDelivery,
    toContext: (attributes: Record<string, string>) => TrustedContext | undefined,
  ): GovernedToolkit;
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
   * using the toolkit's built-in `ContextStore`. Only applies to tools that
   * execute within the callback; detached dispatch needs `withContext`. Unavailable
   * if you constructed the toolkit with a custom resolver function.
   */
  run<T>(context: TrustedContext, fn: () => T): T;
  /** The current trusted context, or throw if not inside `run(...)`. */
  current(): TrustedContext;
  /** The current trusted context, or `undefined` if not inside `run(...)`. */
  peek(): TrustedContext | undefined;
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
    options.audit === false
      ? discardedAudit
      : typeof options.audit === "string"
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

    const withSignal = (
      delivery: SignalDelivery,
      toContext: (attributes: Record<string, string>) => TrustedContext | undefined,
    ): GovernedToolkit => {
      // Map once, at render: the attributes cannot change during a turn. Any
      // failure becomes a resolver that refuses each call, which the pipeline
      // records as a denial, rather than an error that breaks the render.
      let bound: TrustedContext | undefined;
      let failure: unknown;
      try {
        bound = delivery.kind === "signal" && delivery.attributes
          ? toContext(delivery.attributes)
          : undefined;
      } catch (err) {
        failure = err;
      }
      return build(() => {
        if (failure !== undefined) throw failure;
        if (!bound) throw new MissingContextError();
        return bound;
      });
    };

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
      withSignal,
      tool,
      run: <T>(context: TrustedContext, fn: () => T) =>
        requireStore().run(context, fn),
      current: () => requireStore().current(),
      peek: () => requireStore().peek(),
    };

    function defineGovernedTool<TArgs, TResult>(
      spec: GovernedToolSpec<TArgs, TResult>,
    ): FlueCompatibleTool {
    const { authorize, scopeIsOnlyGate } = checkSpec(spec, options.trustedSources);
    const validate = makeValidator(spec.parameters);
    const redactor = spec.redact ?? baseRedactor;
    const appendAudit = (input: AuditInput) =>
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
      call?: ToolCallInfo,
    ): Promise<unknown> => {
      const toolCallId = call?.toolCallId || undefined;
      let assessment: GuardAssessment | undefined;
      const audit = (input: AuditInput) => appendAudit({
        ...input,
        ...(assessment ? { guard: redactor(assessment) } : {}),
      });
      // 1. Resolve trusted context (fail-closed; we still record the denial).
      let ctx: TrustedContext;
      try {
        ctx = await resolveContext(hostContext);
      } catch (err) {
        await audit({
          actorId: "unknown",
          tenantId: "unknown",
          tool: spec.name,
          ...(toolCallId ? { toolCallId } : {}),
          decision: "deny",
          outcome: "denied",
          requestedScopes: [],
          error: errorCode(err),
        });
        throw err;
      }

      const base = {
        actorId: ctx.actor.id,
        // Omitted for the common single-identity case, so existing entries and
        // their hashes are unchanged.
        ...(ctx.initiator ? { initiatorId: ctx.initiator.id } : {}),
        tenantId: ctx.tenantId,
        tool: spec.name,
        requestId: ctx.requestId,
        // Omitted when the host gives no call id, so entries stay unchanged.
        ...(toolCallId ? { toolCallId } : {}),
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
          args = await validate(rawArgs);
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
          ...(toolCallId ? { toolCallId } : {}),
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
        // A load-bearing scope gate must actually derive something: an empty
        // requested list is vacuously "in scope", which would let this side
        // effect run ungated for this call. Fail closed instead.
        if (scopeIsOnlyGate && requested.length === 0) {
          await denyAudit("scope_violation");
          throw new ScopeViolationError(spec.name, [], allowedScopes);
        }
        const denied = deniedScopes(requested, allowedScopes);
        if (denied.length > 0) {
          await denyAudit("scope_violation");
          throw new ScopeViolationError(spec.name, denied, allowedScopes);
        }

        // 5. Authorization, keyed to a declared trusted anchor.
        if (authorize) {
          const a = authorize;
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

        // Clone only the guard/handler arguments; the other steps keep their inputs.
        let executionArgs = args;
        if (spec.guard) {
          try {
            executionArgs = structuredClone(args);
            assessment = await evaluateGuard(spec.guard, {
              tool: spec.name, args: executionArgs, ctx: execCtx,
            });
          } catch {
            await audit({
              ...base, decision: "deny", outcome: "error",
              requestedScopes: requested, args: redactedArgs, error: "guard_unavailable",
            });
            audited = true;
            throw new GuardUnavailableError(spec.name);
          }
          if (assessment.decision === "deny") {
            await denyAudit("guard_denied");
            throw new GuardDeniedError(spec.name);
          }
        }

        // 6. Approval, required by either the existing policy or guard review.
        let approver: string | undefined;
        const approval = evaluateApproval(spec.approval, args, ctx);
        if (approval.needed || assessment?.decision === "review") {
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
            ...(assessment ? { assessment } : {}),
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
          if (spec.canApprove) {
            const accepted =
              decision.approver !== undefined &&
              (await spec.canApprove(decision.approver, args, ctx));
            if (!accepted) {
              await denyAudit("approval_denied", { approver: decision.approver });
              throw new ApprovalDeniedError(
                spec.name,
                decision.approver === undefined
                  ? "the approval named no approver"
                  : `${decision.approver} may not approve this call`,
              );
            }
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

        // Single exit point for the model-visible return. The audit log and the
        // idempotency store both keep the full result; only this shapes what the
        // model/host sees. Replay routes its stored (full) result through here
        // too, so a replayed call returns exactly what the original returned.
        const shape = (result: TResult): unknown =>
          spec.toModelOutput ? spec.toModelOutput(result, execCtx) : result;

        const runAndAudit = async (
          idempotencyKey?: string,
        ): Promise<unknown> => {
          await writeIntent(idempotencyKey);
          let result: TResult;
          try {
            result = await spec.execute(executionArgs, execCtx);
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
          // The outcome is on the chain. `shape` runs outside the try so a
          // toModelOutput bug propagates without writing a second,
          // contradictory outcome record for the same call.
          audited = true;
          return shape(result);
        };

        // 7. Idempotency (only when a policy is declared).
        if (spec.idempotency) {
          const rawKey = spec.idempotency.key(
            args,
            toolCallId ? { ...ctx, toolCallId } : ctx,
          );
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
            // Outcome recorded; a toModelOutput throw below must not write a
            // second outcome record (see runAndAudit).
            audited = true;
            return shape(begin.record.result as TResult);
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
            result = await spec.execute(executionArgs, execCtx);
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
          // Outcome recorded; a toModelOutput throw below must not write a
          // second outcome record (see runAndAudit).
          audited = true;
          return shape(result);
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
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      execute,
    };
    }
  };

  return build(rootResolver);
}
