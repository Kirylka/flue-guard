# The pipeline

Every call to a governed tool goes through the same steps in the same order.
No step can be skipped, and any step can stop the call.

```
context -> validate -> roles -> scope -> authorize -> guard -> approval
        -> idempotency -> execute -> audit
```

## The steps

1. **Context.** Find out who is calling: from `run(...)`, or from the value
   given to `withContext(...)`. No caller means no call
   (`MissingContextError`), and that refusal is logged too.
2. **Validate.** Check the arguments the model wrote. Flue has already checked
   a Valibot `parameters` schema. Other validators run here. Invalid arguments
   stop the call before any check sees them.
3. **Roles.** `requireRoles`, matched against the caller's roles. By default
   any one listed role is enough. It is the cheapest check, so it runs first.
4. **Scope.** The tool says what this call touches. The library compares that
   with what the caller may touch. This step keeps tenants apart.
5. **Authorize.** Your own check, tied to the caller or to a lookup you
   registered. This is where ownership is checked.
6. **Guard.** An optional check that reads the call itself and allows it,
   refuses it, or asks for review. If it fails or times out, the call stops.
7. **Approval.** If the policy asks for it, or the guard asked for review, the
   adapter answers approved, denied, or pending. Pending stops the call before
   anything has run.
8. **Idempotency.** The key is claimed atomically. If the same key finished
   within the TTL, the stored result is returned. If it is still running, the
   call is refused.
9. **Execute.** Your handler runs with the checked arguments and the
   `ExecutionContext`.
10. **Audit.** Not really a last step. Each step writes its result to the log
   as it happens.

The order is deliberate. Cheap, fixed checks run before slow ones that need a
lookup, and all of them run before anything changes. Approval comes after
`authorize`, so a person is only asked about calls the caller is allowed to
make. Idempotency comes last, so a stored result is only returned to a call
that passed every check again.

## What lands in the log

| Situation | Records written (`decision`/`outcome`) |
| --- | --- |
| Allowed, no side effect | `allow/success` |
| Allowed, `sideEffect: true` | `allow/executing` before the handler, then `allow/success` |
| Handler threw | `allow/executing` if it changes data, then `allow/error` |
| Any check refused | `deny/denied`, with the error code |
| Approval pending | `defer/pending`, with the adapter's `ref` |
| Stored result returned | `allow/replayed`, with the stored result |
| Guard failed or timed out | `deny/error`, code `guard_unavailable` |
| A check itself crashed | `deny/error`, code `governance_error: …` |

Two rules hold for every call:

- A change never happens without a record. The `executing` entry is written
  before the handler. If that write fails, the handler does not run.
- Every decision is in the log: refusals, pending approvals, stored results,
  handler errors, and errors thrown by a check or an adapter. An error that no
  step recorded is written exactly once by a final catch.

## Where the pieces live

`createGovernedToolkit` holds everything the tools share: the audit log, the
idempotency store, the adapters for roles, approval, and masking, and the way
the caller is found. Every tool you define from it uses the same ones. Each
tool's spec only adds what is specific to that tool: its schema, its checks,
its key, its handler.

Everything specific to Flue lives in one small module. `toFlueTool` turns a
governed tool into Flue's `ToolDefinition` (`input` and
`run({ data, signal })`, tested against `@flue/runtime` 2.0.8), and `govern()`
passes Flue's `defineTool` in for you. The rest of the library never imports
Flue. That is why its checks can be tested without Flue, and why
`createGovernedToolkit` accepts your own `defineTool` if you need one.
