# Errors

Everything the governance layer throws extends `GovernanceError`, so a host
can distinguish a governance decision from an ordinary handler failure.
Handler exceptions are never wrapped; they propagate as thrown.

```ts
import type { GovernanceErrorCode } from "flue-guard";
import { GovernanceError } from "flue-guard";

declare const err: GovernanceError;

const code: GovernanceErrorCode = err.code; // machine-readable, e.g. "scope_violation"
const tool: string | undefined = err.tool;  // the tool the decision applied to
```

## Classes and codes

| Class | `code` | Thrown when |
| --- | --- | --- |
| `MissingContextError` | `missing_context` | A governed tool ran with no trusted context bound (no surrounding `run(...)`, or the resolver threw). |
| `AccessDeniedError` | `access_denied` | The actor lacks every role in `requireRoles`. Carries `requiredRoles: string[]`. |
| `ScopeViolationError` | `scope_violation` | A derived scope is outside `ctx.scopes`, or a scope-only-gated side effect derived no scopes. Carries `requested: string[]` and `allowed: string[]`. |
| `AuthorizationDeniedError` | `authorization_denied` | The `authorize` check returned `false`. |
| `ApprovalPendingError` | `approval_pending` | Approval is required and not yet decided. A suspend signal; carries `ref?: string`, the adapter's handle. |
| `ApprovalDeniedError` | `approval_denied` | Approval was required and not granted, or required with no adapter configured. |
| `IdempotencyConflictError` | `idempotency_conflict` | Another in-flight call holds the same idempotency key. Carries `key: string`. |
| `GovernanceConfigError` | `config_error` | The tool or toolkit is misdefined: ungated side effect, unattested side-effecting primitive, unknown trusted source, `tool()` without `defineTool`, empty idempotency key, empty HMAC key. Usually thrown at definition time. |

`GovernanceErrorCode` is the union of the eight codes above.

## Guard functions

```ts
import {
  isApprovalPending,
  isGovernanceDenial,
  isGovernanceError,
  type GovernedToolkit,
  type TrustedContext,
} from "flue-guard";

declare const gov: GovernedToolkit;
declare const trustedCtx: TrustedContext;
declare const session: { prompt(text: string): Promise<unknown> };

try {
  await gov.run(trustedCtx, () => session.prompt("close my account"));
} catch (err) {
  if (isApprovalPending(err)) {
    // Suspend signal: park the run against err.ref and resume later.
  } else if (isGovernanceDenial(err)) {
    // Governance refused the call. Tell the model/user "not allowed",
    // rather than "the tool failed". Do not retry.
  } else if (isGovernanceError(err)) {
    // config_error: a bug in a tool definition or the toolkit wiring.
    throw err;
  } else {
    // An ordinary handler failure.
    throw err;
  }
}
```

- `isGovernanceError(err)` matches any `GovernanceError`.
- `isGovernanceDenial(err)` matches refusals only: `missing_context`,
  `access_denied`, `scope_violation`, `authorization_denied`,
  `approval_denied`, `idempotency_conflict`. It excludes `approval_pending`
  (not a refusal) and `config_error` (a bug, not a decision).
- `isApprovalPending(err)` matches the suspend signal and narrows to
  `ApprovalPendingError`, so `err.ref` is typed.

## How errors surface through Flue

Inside a Flue run, a governed tool that throws produces a tool error the
model can see and react to; the agent turn continues. The error entries were
already written to the audit log by the time the model hears about it.
Denials also carry enough context on the audit entry (`error` code,
`requestedScopes`, `args` after redaction) to reconstruct the refusal later.
