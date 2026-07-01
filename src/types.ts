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
 * A schema/validator for tool arguments. Three accepted forms:
 *  - a function `(input) => T`, or a zod-like `{ parse }` — this library
 *    validates arguments internally;
 *  - an **opaque host schema** (e.g. a Flue/Valibot `v.object(...)` or a
 *    TypeBox `Type.Object(...)`) — passed through untouched so the host
 *    framework validates it. Flue parses model arguments against this schema
 *    before our handler runs, so no internal validation is needed.
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
 * A tool object shaped like Flue's `ToolDef` (`@flue/runtime`): a name, a
 * description, a parameter schema and an `execute` function. Pass the result
 * through Flue's `defineTool(...)` and into `init({ tools })`.
 *
 * Flue calls `execute` with the already-parsed arguments object. The optional
 * second `hostContext` argument carries Flue's `FlueContext` for runtimes that
 * pass it; the recommended way to supply trusted context is `ContextStore`
 * (AsyncLocalStorage) bound in the surrounding `run(...)` scope.
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
