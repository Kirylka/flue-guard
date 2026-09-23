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
  ToolGuard,
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
  guard?: ToolGuard<TArgs>;
  idempotency?: { key: (args: TArgs, ctx: TrustedContext) => string; ttlMs?: number };
  approval?: ApprovalPolicy<TArgs>;
  canApprove?: (approver: string, args: TArgs, ctx: TrustedContext) => boolean | Promise<boolean>;
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

1. **A Valibot object schema.** Passed to Flue as the tool's `input`. Flue
   checks the model's arguments against it before any step here runs, and the
   model sees the real shape of the parameters. Strongly recommended.
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

Typing: inside `gov.tool({ ... })`, TypeScript reads `caller(...)` before
`parameters`, so it cannot work out the type of `a`. Write it out,
`caller((a: { accountId: string }, ctx) => …)`, or use the object form, which
infers it.

## `guard`

Optional `ToolGuard<TArgs>` with `evaluate({ tool, args, ctx })` and an optional
`timeoutMs` (default 2,000). Runs after authorization and before approval.
Returns `{ decision: "allow" | "deny" | "review", reasonCodes: string[], details?: Record<string, unknown> }`.
Deny blocks, review requires approval, and allow preserves existing approval
requirements. Errors, invalid assessments, cancellation, and timeouts block.
A guard does not count as an authorization gate for side effects.

Parsed args are cloned once with `structuredClone` before evaluation. The guard
and `execute` receive that same mutable clone; other steps retain their inputs.
See [Add a Jev guard](/guides/jev-guard) for the optional adapter and limitations.

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

`true` or `always(reason?)` requires approval on every call. A function
requires it when it returns `true` or a reason string. `false` or `never()`
requires no approval and does not count as a check. A guard that asks for
review also requires approval. Without an `ApprovalAdapter` on the toolkit,
any call that needs approval is refused. See
[Require human approval](/guides/require-approval).

## `canApprove`

`approval` decides whether a person is needed. `canApprove` decides which
person counts. It runs only after the adapter returns an approval, and a
`false` answer denies the call with `ApprovalDeniedError`, audited as
`deny/approval_denied` with the rejected approver recorded.

The common rule is that nobody signs off their own call:

```ts no-check
canApprove: (approver, args, ctx) => approver !== ctx.actor.id,
```

Fail-closed: if you declare `canApprove` and the adapter approves without
naming an approver, the call is denied. There is nobody to check.

## `redact`

Per-tool override of the toolkit's redactor. Applied to args, results, guard assessments, and
error strings before they are written to the audit log. Never applied to what
the handler or the model receives.

## `toModelOutput`

Shapes the value returned to Flue (and so to the model). The audit log and
the idempotency store both keep the full result; replays route the stored
result through this function again. See
[Shape what the model sees](/guides/shape-model-output).

## `kind`

What kind of arguments the tool takes. `"scoped"` (default) means structured
arguments with a real target, such as an account id, that checks can compare.
`"primitive"` means free-form text such as raw SQL, a shell command, or an
arbitrary HTTP request, which has no target to check. Their log entries carry
`kind: "primitive"`.

## `egressControlled`

Required on a primitive with `sideEffect: true`. It is your statement that
something outside this library limits what the tool can reach. Examples: a
network allowlist, no credentials in the sandbox, database permissions. The
library cannot check this. The flag only lets the tool load. See
[the trust model](/explanation/trust-model#free-form-tools-are-declared-not-checked).

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
