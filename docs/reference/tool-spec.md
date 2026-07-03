# Tool spec

The object you pass to `gov.tool(...)` or `defineGovernedTool(...)`. With
`gov.tool`, `parameters` must be a Standard Schema and `TArgs` below is
inferred from it; with `defineGovernedTool<TArgs>`, you state it.

```ts
import type {
  ApprovalPolicy,
  ArgValidator,
  AuthorizeSpec,
  ExecutionContext,
  Redactor,
  TrustedContext,
} from "flue-guard";

interface GovernedToolSpec<TArgs, TResult> {
  name: string;
  description: string;
  parameters?: ArgValidator<TArgs>;
  sideEffect?: boolean;
  requireRoles?: string[];
  scope?: (args: TArgs, ctx: TrustedContext) => string | string[];
  authorize?: AuthorizeSpec<TArgs>;
  idempotency?: { key: (args: TArgs, ctx: TrustedContext) => string; ttlMs?: number };
  approval?: ApprovalPolicy<TArgs>;
  redact?: Redactor;
  toModelOutput?: (result: TResult, ctx: ExecutionContext) => unknown;
  kind?: "scoped" | "primitive";
  egressControlled?: boolean;
  unsafeAllowUnauthorized?: boolean;
  execute: (args: TArgs, ctx: ExecutionContext) => Promise<TResult> | TResult;
}
```

## `name`, `description`

The model-facing tool name and description, passed through to Flue unchanged.
`name` also appears on every audit entry and in every governance error.

## `parameters`

The argument schema. Accepted forms, in order of preference:

1. **A Valibot object schema.** Forwarded to Flue as the tool's `input`, so
   Flue parses the model's arguments against it before the pipeline runs and
   the model sees the real parameter shape. Strongly recommended.
2. **Any other Standard Schema** (Zod 3.24+, ArkType, TypeBox 0.34+), a
   zod-like `{ parse }` object, or a plain `(input) => T` function. The
   library validates arguments internally, but Flue's `input` degrades to an
   unconstrained object passthrough: the model receives no schema guidance
   for this tool, only the description.
3. **Omitted.** Arguments pass through unvalidated as `Record<string, unknown>`.

Validation failures deny the call (`invalid_arguments` on the audit entry)
before any gate or handler runs.

## `sideEffect`

Declares that the tool changes the outside world. Two behaviors switch on:

- Definition fails (`GovernanceConfigError`) unless the spec declares at
  least one gate: `scope`, `authorize`, non-empty `requireRoles`, or a
  triggering `approval`. For `kind: "primitive"`, the required declaration is
  `egressControlled: true` instead.
- Every allowed call writes an `executing` intent record to the audit log
  before the handler runs, and an outcome record after. If the intent append
  fails, the handler never runs.

## `requireRoles`

Roles required to call the tool, checked by the RBAC adapter (any-of match
against `ctx.actor.roles` by default). Failure throws `AccessDeniedError`.
An empty array means unrestricted and does not count as a gate.

## `scope`

Derives the resource scope(s) this specific call touches, from the arguments
and trusted context, e.g. ``(a) => `customer:${a.customerId}` ``. Each derived
scope must be covered by a pattern in `ctx.scopes` or the call throws
`ScopeViolationError`. Patterns are literal except `*`, which matches any run
of characters.

Derived scope strings are recorded on the audit entry unredacted. If `scope`
is a side-effecting tool's only gate, a call that derives no scopes is
refused rather than treated as in scope.

## `authorize`

A per-call check keyed to a declared trusted anchor. Two anchors:

```ts
import { caller, trusted } from "flue-guard";

declare const ownsAccount: (actorId: string, accountId: string) => Promise<boolean>;

// The authenticated caller: the check receives the ExecutionContext.
// Inline in a tool spec, write it as a bare function — shorthand for
// caller(...) with `args` inferred from `parameters`:
//   authorize: (a, ctx) => ownsAccount(ctx.actor.id, a.accountId)
// Standalone (nothing to infer from), use caller() and annotate:
export const byCaller = caller(
  (a: { accountId: string }, ctx) => ownsAccount(ctx.actor.id, a.accountId),
);

// A registered trusted source: the named lookup runs server-side and its
// resolved value is passed to the check.
export const bySource = trusted(
  "accountEmail",
  (a: { resetEmail: string }, emailOnFile) => a.resetEmail === emailOnFile,
);
```

`caller` and `trusted` build the underlying `AuthorizeSpec`:

```ts
import type { ExecutionContext } from "flue-guard";

type AuthorizeSpec<TArgs> =
  | { anchor: "caller"; check: (args: TArgs, ctx: ExecutionContext) => boolean | Promise<boolean> }
  | { anchor: { trustedSource: string }; check: (args: TArgs, source: unknown) => boolean | Promise<boolean> };
```

A `false` result throws `AuthorizationDeniedError`. A spec that names an
unregistered trusted source fails at definition time.

Note on typing: inside a `gov.tool` literal, prefer the bare-function form —
TypeScript infers its `args` from `parameters`. A nested `caller(...)` call
cannot get that inference (the inner generic call is resolved before the
spec's schema type is fixed), so annotate the argument type there, or only
use `caller`/`trusted` for standalone, reusable checks.

## `idempotency`

At-most-once execution per logical operation. `key` must return a stable,
non-empty string; an empty key throws `GovernanceConfigError` at call time.
Keys are namespaced per tool and per tenant, recorded on audit entries
unredacted, and honored for `ttlMs` milliseconds (forever when omitted).
Behavior table and design guidance:
[Make retries safe](/guides/safe-retries).

## `approval`

```ts
import type { TrustedContext } from "flue-guard";

type ApprovalPolicy<TArgs> =
  | boolean
  | ((args: TArgs, ctx: TrustedContext) => boolean | string | undefined);
```

`true` (or `always(reason?)`) requires approval on every call; a predicate
requires it when it returns `true` or a reason string; `false` (or `never()`)
never does, and does not count as a gate. Requires an `ApprovalAdapter` on
the toolkit or the call is denied. See
[Require human approval](/guides/require-approval).

## `redact`

Per-tool override of the toolkit's redactor. Applied to args, results, and
error strings before they are written to the audit log. Never applied to what
the handler or the model receives.

## `toModelOutput`

Shapes the value returned to Flue (and so to the model). The audit log and
the idempotency store both keep the full result; replays route the stored
result through this function again. See
[Shape what the model sees](/guides/shape-model-output).

## `kind`

How the arguments relate to the tool's blast radius. `"scoped"` (default)
means structured arguments with a real target, fully governable in-process.
`"primitive"` means a free-form payload (raw SQL, shell, arbitrary HTTP) that
argument checks cannot bind; primitives are flagged `kind: "primitive"` on
their audit entries.

## `egressControlled`

For a side-effecting primitive: your attestation that its blast radius is
bounded outside the process (egress allowlist, no in-sandbox credential,
database-level controls). The library does not and cannot verify this; the
flag only permits the definition. See
[the trust model](/explanation/trust-model#primitives-are-attested-not-enforced).

## `unsafeAllowUnauthorized`

Escape hatch: permits defining a side-effecting tool with no gate. Off by
default because an ungated side-effecting tool is exactly the bug class this
library exists to prevent. Prefer any real gate.

## `execute`

The handler. Receives validated arguments and the `ExecutionContext`
(including `authorizedScopes` and Flue's `AbortSignal`). Under Flue the
return value must be JSON-plain: no `bigint`, `Date`, class instances, or
circular structures. Handler exceptions propagate to the host unchanged and
are recorded as `allow/error` audit entries.
