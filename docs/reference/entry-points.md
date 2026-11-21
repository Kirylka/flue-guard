# Entry points

flue-guard is ESM-only, requires Node >= 22.19, and declares peer
dependencies `@flue/runtime ^2.0.8` and `valibot ^1.0.0`.

Five import paths. The root has what most apps need: `govern`, the types, and
the adapter *interfaces*. Implementations live on subpaths so the root stays
small.

| Import | Contents |
| --- | --- |
| `flue-guard` | `govern`, `createGovernedToolkit`, `caller`, `trusted`, `always`, `never`, `ContextStore`, the errors, core types, adapter interfaces |
| `flue-guard/audit` | `HashChainAuditLog`, `InMemoryAuditLog`, `hashEntry`, `verifyChain`, `GENESIS_HASH` |
| `flue-guard/adapters` | Built-in adapter implementations and helpers: `defaultRbac`, `autoApprove`, redactors, `InMemoryIdempotencyStore`, scope matchers, `toFlueTool`, `hostContextResolver` |
| `flue-guard/jev` | Optional `createJevGuard`, `JevGuardOptions`, `JevHazard`, `JevThreshold`; requires optional peer `@typesafe-ai/sdk` 0.6 or 0.7. [Guide](/guides/jev-guard) |
| `flue-guard/testing` | `InMemoryAuditLog`, `InMemoryIdempotencyStore` (re-exported test doubles) |

## `flue-guard` (root)

**Functions & classes**

| Export | Description |
| --- | --- |
| `govern(options)` | Create a toolkit with Flue's `defineTool` wired in; the way in. [Reference](/reference/toolkit#govern) |
| `createGovernedToolkit(options)` | The explicit form: same toolkit, you inject `defineTool`. [Reference](/reference/toolkit#creategovernedtoolkit) |
| `caller(check)` | Authorization anchored to the authenticated caller; same as passing `check` itself. [Reference](/reference/tool-spec#authorize) |
| `trusted(source, check)` | Authorization anchored to a registered trusted source. [Reference](/reference/tool-spec#authorize) |
| `always(reason?)` / `never()` | Shortcuts for "always ask" and "never ask" approval policies. [Reference](/reference/tool-spec#approval) |
| `ContextStore` | `AsyncLocalStorage`-backed trusted-context holder. [Reference](/reference/toolkit#contextstore) |
| Error classes & guards | `GovernanceError` and subclasses, `isGovernanceError`, `isGovernanceDenial`, `isApprovalPending`. [Reference](/reference/errors) |

**Types**

| Export | Description |
| --- | --- |
| `GovernOptions`, `GovernedToolkitOptions` | Options for `govern` / `createGovernedToolkit` |
| `GovernedToolkit` | The toolkit: `tool`, `defineGovernedTool`, `withContext`, `withSignal`, `run`, `current`, `peek` |
| `GovernedToolSpec`, `GovernedFlueToolSpec` | The tool spec (explicit-generic and schema-inferred forms) |
| `ToolGuard`, `GuardRequest`, `GuardAssessment` | Provider-neutral semantic guard interfaces |
| `AuthorizeSpec`, `CallerCheck`, `TrustedSource` | Authorization gate shapes |
| `SignalDelivery` | The part of Flue's `useDelivery()` result that `withSignal` reads |
| `PendingApprovalOutput` | What the model sees when a call waits for approval under Flue |
| `ToolCallInfo` | The host's call id, passed to a governed tool's `execute` |
| `TrustedContext`, `ExecutionContext` | The context your app binds / the one handlers receive |
| `ContextResolver` | `(hostContext?) => TrustedContext \| Promise<TrustedContext>` |
| `Decision`, `Outcome` | Audit vocabulary: `allow\|deny\|defer`, `executing\|success\|error\|denied\|replayed\|pending` |
| `ArgValidator`, `ParseValidator`, `FnValidator`, `StandardSchemaV1`, `InferArgs` | Parameter-schema typing |
| `FlueCompatibleTool`, `FlueToolDefinition`, `FlueDefineTool` | The governed tool before and after it becomes a Flue tool |
| `GovernanceErrorCode` | Union of every machine-readable error code |
| Adapter interfaces | `AuditLog`, `AuditEntry`, `AuditEntryBody`, `AuditInput`, `IdempotencyStore`, `IdempotencyRecord`, `IdempotencyStatus`, `BeginResult`, `RbacAdapter`, `RbacRequest`, `ApprovalAdapter`, `ApprovalPolicy`, `ApprovalRequest`, `ApprovalDecision`, `Redactor`. [Reference](/reference/adapters) |

## `flue-guard/audit`

| Export | Description |
| --- | --- |
| `HashChainAuditLog` | Append-only hash-chained JSONL file log (single-writer) |
| `InMemoryAuditLog` | Full hash-chained in-memory log |
| `hashEntry(body, hmacKey?)` | Compute an entry's chain hash (Web Crypto) |
| `verifyChain(entries, hmacKey?)` | Walk a chain; report the first inconsistency |
| `GENESIS_HASH` | The 64-zero hash the first entry chains from |

Details: [Audit log reference](/reference/audit-log).

## `flue-guard/adapters`

| Export | Description |
| --- | --- |
| `defaultRbac` | Any-of role match against `ctx.actor.roles` |
| `autoApprove` | Approval adapter that approves everything (local dev) |
| `defaultRedactor` | Masks common sensitive field names + PII-like strings |
| `redactFields(fields?, options?)` | Build a structural field-masking redactor |
| `textRedactor(transform, options?)` | Adapt a string-based PII library into a `Redactor` |
| `composeRedactors(...redactors)` | Run redactors left to right |
| `identityRedactor` | Changes nothing |
| `InMemoryIdempotencyStore` | Process-local idempotency store (the default) |
| `scopeAllowed(requested, allowed)` | Does any allowed pattern match this scope? |
| `normalizeScopes(scopes)` | Scope declaration -> `string[]` |
| `deniedScopes(requested, allowed)` | The requested scopes not covered by allowed |
| `toFlueTool(governed)` | Governed tool -> Flue `ToolDefinition` (manual wiring path) |
| `hostContextResolver(extract)` | Context resolver for non-Flue hosts that pass a context object |

Details: [Adapters reference](/reference/adapters).

## `flue-guard/testing`

| Export | Description |
| --- | --- |
| `InMemoryAuditLog` | Same class as `flue-guard/audit` exports; here for discoverability in tests |
| `InMemoryIdempotencyStore` | Same class as `flue-guard/adapters` exports |
