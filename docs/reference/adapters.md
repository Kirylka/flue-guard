# Adapters

Every moving part of the pipeline is an interface with a working default.
The interfaces live on the package root (`flue-guard`); the built-in
implementations live on `flue-guard/adapters`. Swap any of them in
`govern(...)` options without touching a tool.

| Seam | Interface | Default | Swap in for |
| --- | --- | --- | --- |
| Audit | `AuditLog` | `HashChainAuditLog` (file path) | A database, D1, a WORM store |
| Idempotency | `IdempotencyStore` | `InMemoryIdempotencyStore` | Redis, Postgres, KV, Durable Objects |
| RBAC | `RbacAdapter` | `defaultRbac` | OPA, a permissions service |
| Approval | `ApprovalAdapter` | none (fail closed) | Slack, tickets, a review UI |
| Redaction | `Redactor` | `defaultRedactor` | A dedicated PII engine |

## `AuditLog`

```ts
import type { AuditEntry, AuditInput } from "flue-guard";

interface AuditLog {
  /** Append an entry and return the fully populated, hashed record. */
  append(input: AuditInput): Promise<AuditEntry>;
  /** All entries, in order. */
  entries(): Promise<AuditEntry[]>;
}
```

`append` receives everything except `seq`, `prevHash`, `ts` (optional), and
`hash`; the log assigns those. Implementations must serialize concurrent
appends (two interleaved appends would share a parent hash and break the
chain) and should use [`hashEntry`](/reference/audit-log#hashentry) so
`verifyChain` can check the result. Entry shape and built-in logs:
[Audit log reference](/reference/audit-log).

## `IdempotencyStore`

```ts
import type { IdempotencyStatus } from "flue-guard";

interface IdempotencyStore {
  begin(tenantId: string, key: string, ttlMs?: number): Promise<BeginResult>;
  complete(tenantId: string, key: string, result: unknown): Promise<void>;
  fail(tenantId: string, key: string): Promise<void>;
  get(tenantId: string, key: string): Promise<IdempotencyRecord | undefined>;
}

type BeginResult =
  | { status: "started" }                                  // caller owns the key; execute
  | { status: "replay"; record: IdempotencyRecord }        // completed within TTL; reuse result
  | { status: "in_flight"; record: IdempotencyRecord };    // someone else is executing

interface IdempotencyRecord {
  key: string;
  tenantId: string;
  status: IdempotencyStatus; // "in_flight" | "completed" | "failed"
  result?: unknown;
  createdAt: number;
  completedAt?: number;
  ttlMs?: number;
}
```

Contract points an implementation must keep:

- `begin` must claim the key atomically. The atomicity of that claim is the
  strength of the whole at-most-once guarantee.
- An `in_flight` record never expires by TTL. It is released only by
  `complete()` or `fail()` (or a lease mechanism you add).
- `complete` stores the result for replay; serializing stores return the
  JSON-normalized value on replay.

The built-in `InMemoryIdempotencyStore` (also on `flue-guard/testing`)
accepts an injectable `clock` for tests. Keys arrive already namespaced per
tool; records are namespaced per tenant by the `tenantId` argument.

## `RbacAdapter`

```ts
import type { TrustedContext } from "flue-guard";

interface RbacAdapter {
  can(request: RbacRequest): boolean | Promise<boolean>;
}

interface RbacRequest {
  tool: string;
  requiredRoles: string[]; // any-of; empty means unrestricted
  ctx: TrustedContext;
}
```

`defaultRbac` returns `true` when `requiredRoles` is empty or any required
role appears in `ctx.actor.roles`. A `false` answer throws
`AccessDeniedError` and audits `deny/access_denied`.

## `ApprovalAdapter`

```ts
import type { TrustedContext } from "flue-guard";

interface ApprovalAdapter {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

interface ApprovalRequest<TArgs = unknown> {
  tool: string;
  args: TArgs;
  ctx: TrustedContext;
  reason?: string; // why the policy triggered, e.g. "refund exceeds $50"
}

interface ApprovalDecision {
  approved: boolean;
  pending?: boolean;  // not yet decided: suspend the call (ApprovalPendingError)
  ref?: string;       // adapter's handle for the pending approval (e.g. ticket id)
  approver?: string;  // recorded on the audit entry
  reason?: string;
}
```

When `pending` is `true`, `approved` is ignored and the call suspends. On
resume the tool is re-invoked and the adapter consulted again, so the adapter
is where "already approved" memory lives. `autoApprove` (from
`flue-guard/adapters`) approves everything and is for local development.
Usage patterns: [Require human approval](/guides/require-approval).

## `Redactor`

```ts
type Redactor = (value: unknown) => unknown;
```

Transforms a value before it is written to the audit log; never applied to
handler inputs or model output. Builders on `flue-guard/adapters`:

| Builder | Produces |
| --- | --- |
| `defaultRedactor` | Masks common sensitive field names, emails, and long digit runs |
| `redactFields(fields?, { maskStrings? })` | Field-name masking (case-insensitive), recursing through objects and arrays |
| `textRedactor(transform, { fields? })` | Wraps a string-based PII library into a structural redactor |
| `composeRedactors(...rs)` | Runs redactors left to right |
| `identityRedactor` | No-op (audit everything verbatim) |

All built-ins handle circular and deep values without throwing and never
mutate their input.

## Scope matchers

Used by the pipeline's scope step; exported for building custom tooling:

```ts
import { deniedScopes, normalizeScopes, scopeAllowed } from "flue-guard/adapters";

scopeAllowed("customer:c-1", ["customer:*"]);        // true
normalizeScopes("customer:c-1");                      // ["customer:c-1"]
deniedScopes(["customer:c-1", "ticket:t-9"], ["customer:*"]); // ["ticket:t-9"]
```

Patterns are literal except `*`, which matches any run of characters
(including `:` and `/`). A bare `*` grants everything.

## `toFlueTool` and `hostContextResolver`

The manual Flue wiring path, for when you use `defineGovernedTool` directly:

```ts
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { createGovernedToolkit } from "flue-guard";
import { toFlueTool } from "flue-guard/adapters";

const toolkit = createGovernedToolkit({ audit: "audit.jsonl" });

export const ping = defineTool(
  toFlueTool(
    toolkit.defineGovernedTool<{ target: string }>({
      name: "ping",
      description: "Ping a target.",
      parameters: v.object({ target: v.string() }),
      execute: async (a) => `pong: ${a.target}`,
    }),
  ) as ToolDefinition,
);
```

`toFlueTool` maps the governed intermediate onto Flue's beta.3+ contract: a
genuine Valibot `parameters` schema becomes the tool's `input` as-is; any
other validator becomes an unconstrained object passthrough (arguments still
arrive for internal validation, but the model gets no schema guidance). The
governed handler runs from Flue's `run({ input, signal })`.

`hostContextResolver(extract)` builds a `ContextResolver` for **non-Flue**
hosts that pass a context object to tools. Flue's `run` receives no host
context, so under Flue bind context with `run(...)` or `withContext(...)`
instead.
