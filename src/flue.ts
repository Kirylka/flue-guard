/**
 * Flue integration adapter.
 *
 * This is the ONLY module aware of how Flue calls a tool; the governance core
 * has no Flue dependency.
 *
 * Verified against `@flue/runtime` v1.0.0-beta.9. Flue's tool contract
 * (`ToolDefinition`) changed in beta.3 — `parameters`/`execute` were removed in
 * favor of `input`/`output`/`run`, and passing the old fields to `defineTool`
 * now throws `ToolLegacyDefinitionError`:
 *
 * ```ts
 * interface ToolDefinition<TInput, TOutput> {
 *   name: string;
 *   description: string;
 *   input?: TInput;   // optional Valibot top-level object schema
 *   output?: TOutput; // optional Valibot schema; omit to return raw JSON
 *   run: (ctx: { input; signal? }) => StructuredResult | Promise<StructuredResult>;
 * }
 * ```
 *
 * Three facts shape this adapter:
 *  - `run` receives a single **context object** `{ input, signal }` — no
 *    positional args, and (unlike some runtimes) **no host context**. `input` is
 *    Flue's already-parsed model arguments — and it only exists when the tool
 *    declares an `input` schema, so this adapter ALWAYS declares one (a genuine
 *    Valibot `parameters` schema as-is; anything else degrades to an
 *    unconstrained object passthrough so the arguments still arrive for the
 *    internal validator and the governance predicates).
 *  - `run` returns **structured data directly**. Flue validates it against the
 *    declared `output` (we declare none), snapshots it, and JSON-serializes it
 *    for the model — so we no longer `JSON.stringify` the result ourselves.
 *    Consequence: handler results must be JSON-plain (objects/arrays/strings/
 *    numbers/booleans/null). Flue rejects `bigint`, `Date`, class instances and
 *    circular structures, where the pre-beta.3 adapter coerced them to a string.
 *  - `input` must be a Valibot top-level object schema; Flue rejects anything
 *    else, which is why non-Valibot validators can't be forwarded.
 *
 * Because `run` carries no host context, trusted context must be bound out of
 * band via {@link ContextStore} (AsyncLocalStorage) at the agent/workflow
 * boundary — Flue's second positional argument was always an `AbortSignal`, so
 * this was already the case before beta.3.
 *
 * Usage:
 * ```ts
 * import { defineAgent, defineTool } from "@flue/runtime";
 * import * as v from "valibot";
 * import { createGovernedToolkit, ContextStore, HashChainAuditLog, toFlueTool }
 *   from "flue-guard";
 *
 * const ctx = new ContextStore();
 * const toolkit = createGovernedToolkit({
 *   context: ctx.resolver(),
 *   audit: new HashChainAuditLog({ path: "audit.jsonl" }),
 * });
 *
 * const refund = defineTool(
 *   toFlueTool(
 *     toolkit.defineGovernedTool({
 *       name: "issue_refund",
 *       description: "Issue a refund.",
 *       parameters: v.object({ customerId: v.string(), amount: v.number() }),
 *       sideEffect: true,
 *       scope: (a) => `customer:${a.customerId}`,
 *       execute: (a, gctx) =>
 *         billing.refund(gctx.tenantId, a.customerId, a.amount),
 *     }),
 *   ),
 * );
 *
 * const agent = defineAgent(() => ({ model, tools: [refund] }));
 * ```
 *
 * Supplying the trusted context depends on how Flue runs the tool:
 *  - **You drive the prompt** (workflows, direct calls): the tool runs inside
 *    your awaited call, so `ContextStore` (AsyncLocalStorage) reaches it —
 *    `await ctx.run(deriveContext(flueCtx.req), () => harness.prompt(text))`.
 *  - **Flue drives the prompt** (`dispatch()` / addressable agents): the turn is
 *    processed detached from your caller, so ALS can't reach the tool. Bind the
 *    context per invocation inside `defineAgent` with
 *    `toolkit.withContext(deriveTrustedContext(ctx.payload, ctx.env))`, then
 *    define the tools from the bound toolkit.
 *
 * {@link hostContextResolver} remains for non-Flue runtimes that pass a context
 * object to the governed tool's `execute` (Flue's `run` receives none).
 */

import type { ContextResolver } from "./context.js";
import { MissingContextError } from "./errors.js";
import * as v from "valibot";
import type { FlueCompatibleTool, TrustedContext } from "./types.js";

/**
 * The context object Flue passes to a tool's `run`: the already-parsed model
 * arguments and the cancellation signal. Mirrors Flue's `ToolContext`
 * structurally, without importing it.
 */
export interface FlueRunContext {
  input?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Structural shape of a Flue (`@flue/runtime` beta.3+) `ToolDefinition`,
 * assignable to Flue's generic type without importing it. `input` is a Valibot
 * object schema (typed `object` to match Flue's `ToolInputSchema`) — always
 * emitted by {@link toFlueTool}, since without one Flue drops the model's
 * arguments entirely. `output` is left undeclared so Flue JSON-serializes the
 * raw structured result `run` returns.
 */
export interface FlueToolDefinition {
  name: string;
  description: string;
  input?: object;
  output?: object;
  run: (context: FlueRunContext) => Promise<unknown>;
}

/**
 * Passthrough `input` schema for tools whose `parameters` can't be handed to
 * Flue as-is. Flue only invokes `run` with the arguments it parsed against a
 * declared `input` — with no `input`, the model's arguments are dropped
 * entirely and the handler (and every scope/authorize/idempotency predicate)
 * would compute over `{}`. So the arguments must always travel through Flue,
 * even when validation is ours.
 */
const passthroughInput = v.looseObject({});

/**
 * The `input` schema to emit for a governed tool. A genuine Valibot schema is
 * forwarded as-is (Flue validates the model's arguments against it and the
 * model sees the real parameter shape). Anything else — a function, a zod-like
 * `{ parse }`, or a non-Valibot Standard Schema (all validated internally by
 * the governance core), or no validator at all — degrades to an unconstrained
 * object passthrough: the model sees no parameter constraints, but its
 * arguments still arrive intact for the internal validator and the governance
 * predicates to work on.
 */
function asFlueInput(parameters: unknown): object {
  if (!parameters || typeof parameters !== "object") return passthroughInput;
  const std = (parameters as { "~standard"?: { vendor?: unknown } })[
    "~standard"
  ];
  return std && std.vendor === "valibot"
    ? (parameters as object)
    : passthroughInput;
}

/**
 * Adapt a governed tool into Flue's `ToolDefinition` contract (beta.3+): expose
 * the parameter schema as `input`, run the governed handler from Flue's
 * `run({ input, signal })` context, and return the structured result directly
 * for Flue to validate and serialize. Pass the result to Flue's `defineTool(...)`.
 */
export function toFlueTool(governed: FlueCompatibleTool): FlueToolDefinition {
  return {
    name: governed.name,
    description: governed.description,
    input: asFlueInput(governed.parameters),
    run: ({ input, signal }) =>
      // Flue passes no host context, so the second arg is always undefined;
      // forward Flue's AbortSignal to the handler via the execution context.
      governed.execute(input ?? {}, undefined, signal),
  };
}

/**
 * Build a {@link ContextResolver} that derives the trusted context from a
 * context object passed as the second argument to a governed tool's `execute`.
 * This suits custom runtimes that hand a context to tools; note that **Flue does
 * not** — its `run` receives only `{ input, signal }` — so under Flue use
 * {@link ContextStore} instead. Throws {@link MissingContextError}
 * (fail-closed) if absent.
 */
export function hostContextResolver<H>(
  extract: (host: H) => TrustedContext | Promise<TrustedContext>,
): ContextResolver {
  return (hostContext?: unknown) => {
    if (hostContext == null) throw new MissingContextError();
    return extract(hostContext as H);
  };
}
