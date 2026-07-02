# govern() & the toolkit

## `govern`

```ts
import type { GovernOptions, GovernedToolkit } from "flue-guard";

declare function govern(options: GovernOptions): GovernedToolkit;
```

Creates a governed toolkit with Flue's `defineTool` already wired in, so
`toolkit.tool(...)` returns a ready-to-use Flue `ToolDefinition`. This is the
one place the package imports `@flue/runtime` (a peer dependency).

`GovernOptions` is `GovernedToolkitOptions` without `defineTool` (see below).

```ts
import { govern } from "flue-guard";

const gov = govern({ audit: "audit.jsonl" });
```

## `createGovernedToolkit`

```ts
import type { GovernedToolkit, GovernedToolkitOptions } from "flue-guard";

declare function createGovernedToolkit(options: GovernedToolkitOptions): GovernedToolkit;
```

The explicit form of the same toolkit. It has no Flue import; you pass Flue's
`defineTool` yourself if you want the one-call `toolkit.tool(...)` helper.
Use it when you want to control that wiring, or to keep a module free of
`@flue/runtime`:

```ts
import { defineTool } from "@flue/runtime";
import { createGovernedToolkit, type FlueDefineTool } from "flue-guard";

const toolkit = createGovernedToolkit({
  audit: "audit.jsonl",
  defineTool: defineTool as unknown as FlueDefineTool,
});
```

(The cast bridges Flue's generic `defineTool` signature to the non-generic
injection seam; `govern` performs the same cast internally.)

## `GovernedToolkitOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `audit` | `AuditLog \| string` | required | The audit sink. A string is a file path: a `HashChainAuditLog` (hash-chained JSONL, Node only). |
| `context` | `ContextStore \| ContextResolver` | a fresh `ContextStore` | How tools resolve the trusted context. Omit it for the built-in store driven by `toolkit.run(...)`. Pass a `ContextStore` to share one, or a resolver function for custom binding (then `run`/`current`/`peek` throw `GovernanceConfigError`). |
| `idempotencyStore` | `IdempotencyStore` | `InMemoryIdempotencyStore` | Where idempotency claims and results live. Process-local by default. |
| `trustedSources` | `Record<string, TrustedSource>` | `{}` | Named server-side lookups for `trusted(...)` authorization anchors. An unknown name referenced by a tool fails at definition time. |
| `defineTool` | `FlueDefineTool` | none | Flue's `defineTool`. Required for `toolkit.tool(...)`; `govern` supplies it. |
| `rbac` | `RbacAdapter` | `defaultRbac` | Role check for `requireRoles` (any-of match by default). |
| `approval` | `ApprovalAdapter` | none | Decides approval requests. Without one, any call that requires approval is denied. |
| `redaction` | `Redactor` | `defaultRedactor` | Applied to args, results, and error strings before they are written to the audit log. |
| `clock` | `() => number` | none | Injectable clock for deterministic audit timestamps in tests. |

## `GovernedToolkit`

```ts
import type {
  ContextResolver,
  FlueCompatibleTool,
  FlueToolDefinition,
  GovernedFlueToolSpec,
  GovernedToolSpec,
  StandardSchemaV1,
  TrustedContext,
} from "flue-guard";

interface GovernedToolkit {
  tool<S extends StandardSchemaV1, TResult = unknown>(
    spec: GovernedFlueToolSpec<S, TResult>,
  ): FlueToolDefinition;
  defineGovernedTool<TArgs = Record<string, unknown>, TResult = unknown>(
    spec: GovernedToolSpec<TArgs, TResult>,
  ): FlueCompatibleTool;
  withContext(context: TrustedContext | ContextResolver): GovernedToolkit;
  run<T>(context: TrustedContext, fn: () => T): T;
  current(): TrustedContext;
  peek(): TrustedContext | undefined;
}
```

### `toolkit.tool(spec)`

One call from spec to Flue `ToolDefinition`; equivalent to
`defineTool(toFlueTool(defineGovernedTool(spec)))`. `parameters` must be a
Standard Schema and the argument type of `scope`, `idempotency.key`,
`execute`, and `toModelOutput` is inferred from it. Throws
`GovernanceConfigError` if the toolkit was built without `defineTool`.

### `toolkit.defineGovernedTool(spec)`

The lower-level form: wraps a spec into a `FlueCompatibleTool` (the governed
intermediate with an `execute(args, hostContext?, signal?)` method). Adapt it
for Flue with [`toFlueTool`](/reference/adapters#toflueltool-and-hostcontextresolver)
and Flue's `defineTool`. Argument types come from the explicit `TArgs`
generic.

Both definition methods validate the spec eagerly and throw
`GovernanceConfigError` at definition time for: a side-effecting tool without
a gate, a side-effecting primitive without `egressControlled`, and an
`authorize` that references an unregistered trusted source.

### `toolkit.withContext(context)`

Returns a sibling toolkit that resolves the trusted context from the given
fixed value or resolver instead of the ambient store. Audit log, idempotency
store, and all adapters are shared. This is the binding for Flue's dispatched
and addressable agents, where tool calls run detached from your caller and
`AsyncLocalStorage` cannot reach them; see
[Run on Cloudflare Workers](/guides/cloudflare-workers#_3-bind-context-per-invocation-when-flue-dispatches).

### `toolkit.run(context, fn)`

Binds `context` (via the toolkit's `ContextStore`) for everything `fn`
triggers, including every governed tool call inside an awaited agent prompt.
Call it once at your request boundary. Unavailable when the toolkit was
constructed with a custom resolver function.

### `toolkit.current()` / `toolkit.peek()`

The currently bound `TrustedContext`. `current()` throws
`MissingContextError` outside a `run(...)`; `peek()` returns `undefined`.

## `ContextStore`

```ts
import type { ContextResolver, TrustedContext } from "flue-guard";

declare class ContextStore {
  run<T>(context: TrustedContext, fn: () => T): T;
  peek(): TrustedContext | undefined;
  current(): TrustedContext; // throws MissingContextError if absent
  resolver(): ContextResolver;
}
```

The `AsyncLocalStorage`-backed holder behind `toolkit.run`. Construct and
pass one via `options.context` to share a single store across several
toolkits.

## `TrustedContext` and `ExecutionContext`

```ts
interface TrustedContext {
  actor: { id: string; roles: string[] };
  tenantId: string;
  scopes?: string[];      // allow-patterns; `*` matches any run of characters
  requestId?: string;     // correlation id, recorded on audit entries
  attributes?: Record<string, unknown>; // free-form, for handlers/adapters
}

interface ExecutionContext extends TrustedContext {
  authorizedScopes: string[]; // the scopes this call was checked against
  host?: unknown;             // raw host context object, when one exists
  signal?: AbortSignal;       // Flue's cancellation signal, forwarded
}
```

`TrustedContext` is what your application binds; `ExecutionContext` is what
`execute`, `authorize` checks, and `toModelOutput` receive.
