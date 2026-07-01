/**
 * Flue integration adapter.
 *
 * This is the ONLY module aware of how Flue calls a tool; the governance core
 * has no Flue dependency.
 *
 * Verified against `@flue/runtime` v1.0.0-beta.1. Flue's tool contract
 * (`ToolDefinition`) is:
 *
 * ```ts
 * interface ToolDefinition<TParams> {
 *   name: string;
 *   description: string;
 *   parameters: TParams;            // valibot schema OR raw JSON Schema object
 *   execute: (args, signal?: AbortSignal) => Promise<string>;
 * }
 * ```
 *
 * Two facts shape this adapter:
 *  - `execute` must return a **string** (the result the LLM sees). Our handler
 *    can return anything, so {@link toFlueTool} coerces non-strings via
 *    `JSON.stringify`.
 *  - The second `execute` argument is an **AbortSignal**, not a context. So a
 *    tool cannot receive trusted context as a call argument — bind it at the
 *    agent/workflow boundary with {@link ContextStore} (AsyncLocalStorage),
 *    deriving it from `FlueContext` (`req`/`env`).
 *
 * Usage:
 * ```ts
 * import { createAgent, defineTool } from "@flue/runtime";
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
 * const agent = createAgent(() => ({ model, tools: [refund] }));
 * ```
 *
 * Supplying the trusted context depends on how Flue runs the tool:
 *  - **You drive the prompt** (workflows, direct calls): the tool runs inside
 *    your awaited call, so `ContextStore` (AsyncLocalStorage) reaches it —
 *    `await ctx.run(deriveContext(flueCtx.req), () => harness.prompt(text))`.
 *  - **Flue drives the prompt** (`dispatch()` / addressable agents): the turn is
 *    processed detached from your caller, so ALS can't reach the tool. Bind the
 *    context per invocation inside `createAgent` with
 *    `toolkit.withContext(deriveTrustedContext(ctx.payload, ctx.env))`, then
 *    define the tools from the bound toolkit.
 *
 * {@link hostContextResolver} remains for non-Flue runtimes that pass a context
 * object to `execute` (Flue's second `execute` arg is an AbortSignal).
 */

import type { ContextResolver } from "./context.js";
import { MissingContextError } from "./errors.js";
import type { FlueCompatibleTool, TrustedContext } from "./types.js";

/**
 * Structural shape of a Flue (`@flue/runtime`) `ToolDefinition`, kept
 * dependency-free. `parameters` is typed `object` to match Flue's
 * `ToolParameters` (a valibot schema or a raw JSON Schema object).
 */
export interface FlueToolDefinition {
  name: string;
  description: string;
  parameters: object;
  // The dynamically-parsed model arguments. Typed as a record (not `unknown`)
  // so this structural shape stays assignable in both directions to Flue's
  // generic `defineTool`/`ToolDefinition`.
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

/**
 * Coerce any handler result to the `string` Flue's contract requires. A plain
 * `JSON.stringify` is not enough: it returns `undefined` for `undefined` (and
 * functions), and throws on `bigint` or circular structures — any of which
 * would violate the declared `Promise<string>`. So: strings pass through, `void`
 * becomes `""`, normal values serialize, and anything unserializable falls back
 * to `String(...)`.
 */
function toResultString(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    const json = JSON.stringify(result);
    return json ?? String(result);
  } catch {
    return String(result);
  }
}

/**
 * Adapt a governed tool into Flue's `ToolDefinition` contract: coerce the
 * handler result to the string Flue expects, and ignore Flue's `AbortSignal`
 * second argument so it is never mistaken for a context. Pass the result to
 * Flue's `defineTool(...)`.
 */
export function toFlueTool(governed: FlueCompatibleTool): FlueToolDefinition {
  return {
    name: governed.name,
    description: governed.description,
    // A tool's parameters is always a schema object (valibot or JSON Schema).
    parameters: (governed.parameters ?? {}) as object,
    execute: async (args, signal) => {
      // Forward Flue's AbortSignal to the handler (via the execution context),
      // without letting it be mistaken for a host context object.
      const result = await governed.execute(args, undefined, signal);
      return toResultString(result);
    },
  };
}

/**
 * Build a {@link ContextResolver} that derives the trusted context from a
 * context object passed as the second argument to `execute`. This suits custom
 * runtimes that hand a context to tools; note that **Flue does not** — its
 * second argument is an `AbortSignal` — so under Flue use {@link ContextStore}
 * instead. Throws {@link MissingContextError} (fail-closed) if absent.
 */
export function hostContextResolver<H>(
  extract: (host: H) => TrustedContext | Promise<TrustedContext>,
): ContextResolver {
  return (hostContext?: unknown) => {
    if (hostContext == null) throw new MissingContextError();
    return extract(hostContext as H);
  };
}
