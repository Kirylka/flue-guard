# Entry points

flue-guard is ESM-only, requires Node >= 22.19, and declares peer
dependencies `@flue/runtime >=1.0.0-beta.9 <1.0.0` and `valibot ^1.0.0`.

Four import paths. The root carries the golden path, the types, and the
adapter *interfaces*; implementations live on subpaths so they don't crowd it.

| Import | Contents |
| --- | --- |
| `flue-guard` | `govern`, `createGovernedToolkit`, `caller`, `trusted`, `always`, `never`, `ContextStore`, the error taxonomy, core types, adapter interfaces |
| `flue-guard/audit` | `HashChainAuditLog`, `InMemoryAuditLog`, `hashEntry`, `verifyChain`, `GENESIS_HASH` |
| `flue-guard/adapters` | Built-in adapter implementations and helpers: `defaultRbac`, `autoApprove`, redactors, `InMemoryIdempotencyStore`, scope matchers, `toFlueTool`, `hostContextResolver` |
| `flue-guard/testing` | `InMemoryAuditLog`, `InMemoryIdempotencyStore` (re-exported test doubles) |

## `flue-guard` (root)

**Functions & classes**

| Export | Description |
| --- | --- |
| `govern(options)` | Create a toolkit with Flue's `defineTool` wired in; the way in. [Reference](/reference/toolkit#govern) |
| `createGovernedToolkit(options)` | The explicit form: same toolkit, you inject `defineTool`. [Reference](/reference/toolkit#creategovernedtoolkit) |
| `caller(check)` | Authorization anchored to the authenticated caller. [Reference](/reference/tool-spec#authorize) |
| `trusted(source, check)` | Authorization anchored to a registered trusted source. [Reference](/reference/tool-spec#authorize) |
| `always(reason?)` / `never()` | Approval policy sugar. [Reference](/reference/tool-spec#approval) |
| `ContextStore` | `AsyncLocalStorage`-backed trusted-context holder. [Reference](/reference/toolkit#contextstore) |
| Error classes & guards | `GovernanceError` and subclasses, `isGovernanceError`, `isGovernanceDenial`, `isApprovalPending`. [Reference](/reference/errors) |

**Types**

| Export | Description |
| --- | --- |
| `GovernOptions`, `GovernedToolkitOptions` | Options for `govern` / `createGovernedToolkit` |
| `GovernedToolkit` | The toolkit: `tool`, `defineGovernedTool`, `withContext`, `run`, `current`, `peek` |
| `GovernedToolSpec`, `GovernedFlueToolSpec` | The tool spec (explicit-generic and schema-inferred forms) |
| `AuthorizeSpec`, `TrustedSource` | Authorization gate shapes |
| `TrustedContext`, `ExecutionContext` | The context your app binds / the one handlers receive |
| `ContextResolver` | `(hostContext?) => TrustedContext \| Promise<TrustedContext>` |
| `Decision`, `Outcome` | Audit vocabulary: `allow\|deny\|defer`, `executing\|success\|error\|denied\|replayed\|pending` |
| `ArgValidator`, `ParseValidator`, `FnValidator`, `StandardSchemaV1`, `InferArgs` | Parameter-schema typing |
| `FlueCompatibleTool`, `FlueToolDefinition`, `FlueDefineTool` | The governed intermediate and Flue-facing shapes |
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
