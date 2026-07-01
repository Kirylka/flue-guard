/**
 * Shared types for flue-guard.
 *
 * The design separates two things frameworks like Flue keep coupled:
 *   - The LLM-facing **arguments** of a tool call (the model controls these).
 *   - The **trusted context** of the caller — actor, tenant, allowed scopes —
 *     which is injected by your harness and can never be set by the model.
 *
 * Flue gates *what* a tool can do by harness state. This library gates *who*
 * may do it, *for which tenant*, with *what side-effect guarantee*.
 */

/** The trusted, harness-injected execution context for a tool call. */
export interface TrustedContext {
  /** The principal on whose behalf the agent is acting. */
  actor: {
    id: string;
    /** Roles used by the default RBAC adapter. */
    roles: string[];
  };
  /** The tenant this run is bound to. Used for hard multi-tenant isolation. */
  tenantId: string;
  /**
   * Resource scopes the actor is permitted to touch, e.g.
   * `["customer:c-123", "ticket:*"]`. A `*` matches any run of characters.
   * Optional — omit (or `[]`) for tools that gate with `authorize` instead of
   * `scope`.
   */
  scopes?: string[];
  /** Correlation id for the surrounding request/run. */
  requestId?: string;
  /** Free-form attributes available to tool handlers and adapters. */
  attributes?: Record<string, unknown>;
}

/** A zod-like validator (used for internal validation). */
export interface ParseValidator<T> {
  parse: (input: unknown) => T;
}

/** A plain function validator (used for internal validation). */
export type FnValidator<T> = (input: unknown) => T;

/**
 * A schema/validator for tool arguments. Accepted forms:
 *  - a function `(input) => T`, a zod-like `{ parse }`, or any
 *    [Standard Schema](https://standardschema.dev) (Zod, ArkType, TypeBox
 *    0.34+, …) — this library validates arguments internally;
 *  - a **Valibot schema** — forwarded to Flue as the tool's `input`, so Flue
 *    parses the model's arguments against it before our handler runs (no
 *    internal re-validation, which would double-apply transforms);
 *  - any other opaque object — passed through unchanged and validated by
 *    nobody; prefer one of the forms above.
 *
 * Omitting a validator passes arguments through unchanged.
 */
export type ArgValidator<T> = ParseValidator<T> | FnValidator<T> | object;

/**
 * Minimal [Standard Schema](https://standardschema.dev) typing. Used to infer a
 * tool's argument type from its `parameters` schema, so handlers/policies don't
 * restate it. Works with any compliant library (Valibot 1.0, Zod 3.24+,
 * ArkType) without importing one — so the package stays dependency-free.
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly version: number;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly types?: { readonly output: Output };
  };
}

/** The parsed output type of a Standard Schema. */
export type InferArgs<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["output"];

/** The context handed to a governed tool's `execute` handler. */
export interface ExecutionContext extends TrustedContext {
  /** The resource scopes this specific call was authorized against. */
  authorizedScopes: string[];
  /** The raw context object passed in by the host framework, if any. */
  host?: unknown;
  /**
   * Cancellation signal forwarded from the host (Flue passes one). Long-running
   * handlers should honor it.
   */
  signal?: AbortSignal;
}

/**
 * Result of a governance decision, recorded in the audit log. `defer` means the
 * call was suspended awaiting approval.
 */
export type Decision = "allow" | "deny" | "defer";

/**
 * Outcome of a tool invocation, recorded in the audit log. `executing` is the
 * pre-execution intent record for a side-effecting call; `pending` marks a call
 * suspended for approval.
 */
export type Outcome =
  | "executing"
  | "success"
  | "error"
  | "denied"
  | "replayed"
  | "pending";

/**
 * The governed tool produced by `defineGovernedTool` — the intermediate the
 * governance core hands to {@link toFlueTool}, which maps it onto Flue's
 * beta.3+ `ToolDefinition` (`{ name, description, input, run }`). It is NOT the
 * Flue-facing object itself: `parameters` becomes Flue's `input` and `execute`
 * is invoked from Flue's `run({ input, signal })`.
 *
 * `execute` is called with the already-parsed arguments object. The optional
 * second `hostContext` argument is the seam for **non-Flue** runtimes that pass
 * a context object to the tool ({@link hostContextResolver}); Flue passes none,
 * so under Flue supply trusted context via `ContextStore` (AsyncLocalStorage)
 * bound in the surrounding `run(...)` scope. The third argument is the host's
 * cancellation signal, forwarded to the handler's execution context.
 */
export interface FlueCompatibleTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    args: unknown,
    hostContext?: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}
