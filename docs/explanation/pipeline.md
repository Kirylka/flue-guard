# The pipeline

Every call to a governed tool runs the same fixed sequence. No step is
skippable, the order never varies, and any step can stop the call.

```
context -> validate -> RBAC -> scope -> authorize -> approval
        -> idempotency -> execute -> audit
```

## The steps

1. **Context.** The trusted context is resolved (from the ambient
   `ContextStore` bound by `run(...)`, or the fixed value from
   `withContext(...)`). No context, no call: `MissingContextError`, and even
   that refusal is audited.
2. **Validate.** The raw model arguments are parsed. A Valibot `parameters`
   schema was already applied by Flue before the tool ran; other validators
   run here. Invalid arguments deny the call before any gate sees them.
3. **RBAC.** `requireRoles` against the adapter (any-of role match by
   default). Coarse, cheap, first.
4. **Scope.** The tool derives what this call touches; the library compares
   it against what the context allows. This is the tenant-isolation step.
5. **Authorize.** The per-call predicate, anchored to the caller or a
   registered trusted source. This is the ownership step.
6. **Approval.** If the policy triggers, the adapter answers approve, deny,
   or pending; pending suspends the call before anything ran.
7. **Idempotency.** The key is claimed atomically. A completed record within
   TTL short-circuits to the stored result; an in-flight claim refuses the
   call.
8. **Execute.** Your handler, with validated args and the
   `ExecutionContext`.
9. **Audit.** Interleaved with all of the above rather than last: each
   step's verdict is appended to the hash chain as it happens.

The order encodes a policy: cheap, static checks run before expensive,
dynamic ones, and everything runs before the side effect. Approval comes
after authorization so a human is only asked about calls the caller could
legitimately make. Idempotency comes last so a replayed call is one that
passed every gate on its first run and would have passed them again.

## What lands in the log

| Situation | Records written (`decision`/`outcome`) |
| --- | --- |
| Allowed, no side effect | `allow/success` |
| Allowed, `sideEffect: true` | `allow/executing` (intent, before the handler), then `allow/success` |
| Handler threw | intent (if side-effecting), then `allow/error` |
| Any gate refused | `deny/denied`, with the error code |
| Approval pending | `defer/pending`, with the adapter's `ref` |
| Idempotent replay | `allow/replayed`, with the stored result |
| Governance step itself crashed | `deny/error`, code `governance_error: …` |

Two invariants hold everywhere:

- A side effect can never run unrecorded. The `executing` intent is
  appended before the handler; if the append fails, the handler never runs.
- Every decision is on the chain. Denials, deferrals, replays, handler
  errors, and even exceptions thrown by a gate or an adapter are recorded
  (the catch-all writes exactly one record for exceptions no step recorded).

## Where the pieces live

`createGovernedToolkit` is the composition root: it holds the cross-cutting
collaborators (audit log, idempotency store, RBAC/approval/redaction
adapters, context resolution) and every tool defined from it shares them.
The spec you write per tool contributes only the call-specific logic: the
schema, the gates, the key, the handler.

The Flue-specific surface is one adapter module. `toFlueTool` maps the
governed intermediate onto Flue's `ToolDefinition` contract
(`input`/`run({ input, signal })`, verified against `@flue/runtime` beta.9),
and `govern()` pre-wires Flue's `defineTool`. The governance core itself
never imports Flue, which is what keeps definition-time checks testable
without a harness and lets `createGovernedToolkit` accept a different
`defineTool` if you ever need to wire one yourself.
