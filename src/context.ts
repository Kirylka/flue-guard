/**
 * Trusted context propagation.
 *
 * The trusted context (actor, tenant, scopes) must reach a governed tool
 * without ever passing through the model. The recommended way to do this in a
 * server is {@link ContextStore}, which uses `AsyncLocalStorage` so that a
 * single `run()` at the request boundary makes the context available to every
 * tool call in that agent run.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { MissingContextError } from "./errors.js";
import type { TrustedContext } from "./types.js";

/**
 * Resolves the trusted context for a tool invocation. Receives the host
 * framework's context object (e.g. Flue's) when one is available.
 */
export type ContextResolver = (
  hostContext?: unknown,
) => TrustedContext | Promise<TrustedContext>;

/**
 * Holds the trusted context for the duration of an agent run using
 * `AsyncLocalStorage`. Bind it once at your request boundary:
 *
 * ```ts
 * await contextStore.run(trustedContext, () => agent.run(prompt));
 * ```
 */
export class ContextStore {
  private readonly als = new AsyncLocalStorage<TrustedContext>();

  /** Run `fn` with `context` available to every governed tool it triggers. */
  run<T>(context: TrustedContext, fn: () => T): T {
    return this.als.run(context, fn);
  }

  /** The current context, or `undefined` if not inside a `run()`. */
  peek(): TrustedContext | undefined {
    return this.als.getStore();
  }

  /** The current context, throwing {@link MissingContextError} if absent. */
  current(): TrustedContext {
    const ctx = this.als.getStore();
    if (!ctx) throw new MissingContextError();
    return ctx;
  }

  /** A {@link ContextResolver} bound to this store. */
  resolver(): ContextResolver {
    return () => this.current();
  }
}
