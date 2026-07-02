# The trust model

Security tooling earns trust by being precise about what it does and does not
guarantee. This page is that statement for flue-guard. Every guarantee here
is pinned by a test in the repository's suite.

## The one idea

The model controls the arguments. Your application controls the context.

Every `accountId`, `amount`, or `query` in a tool call comes from the model,
which means it can be anything the conversation talked the model into. Treat
it as a claim. The trusted context (who the caller is, which tenant, which
scopes) comes from your authenticated request and travels separately, through
`AsyncLocalStorage` or an explicit `withContext` binding. There is no code
path by which model output can read or write it.

Every gate is a comparison between those two inputs, and the design keeps you
on the right side of that comparison. With `scope`, you declare what the call
touches and the library does the comparing, so you cannot accidentally write
a check that never involves the caller. With `authorize`, the check is keyed
to a declared anchor (the caller, or a registered server-side source), so
"compare an argument against nothing trusted" has no syntax to be written in.

## Guaranteed

- Gates run before the handler, every call. There is no code path to
  `execute` around the pipeline. (The pipeline is a closure over your
  handler; the host never holds a direct reference.)
- An ungated side effect cannot be defined without writing
  `unsafeAllowUnauthorized: true` in your source, where review will see it.
- A side effect cannot run unrecorded. The intent record is appended
  before the handler; append failure aborts the call.
- Every decision is on the chain, including denials, deferrals, replays,
  and exceptions inside governance steps themselves.
- Editing recorded history is detectable. Any change to a past entry
  breaks verification at that entry. With an HMAC key, fabricating a whole
  chain requires the key.
- Audit writing is total. Hostile or odd values (`bigint`, circular
  structures, prototype-polluting keys, throwing getters, 100-deep nesting)
  are normalized; the receipt is written regardless of what the handler
  returned.
- Idempotency never trades a refusal for a duplicate. When completion
  can't be recorded after a successful side effect, the key stays held and a
  retry is refused with a conflict.

## Not guaranteed, on purpose

- Your predicates' correctness. `authorize: caller((a, ctx) =>
  accounts.ownedBy(a.accountId, ctx.actor.id))` is your business logic;
  flue-guard guarantees it runs before the side effect and that its verdict
  is recorded, never that it is right.
- Containment of what `execute` does. Gates run before the handler; they
  do not sandbox it. A handler that ignores its arguments and deletes
  something else is outside the model. Sandboxing is Flue's and your
  substrate's job.
- Primitive payloads. See below.
- Exactly-once. At-most-once per key is the guarantee, and it is as
  strong as the store's atomic claim: process-local for the in-memory
  default, cross-instance for a store with an atomic `begin`. The
  completion-failure window surfaces as a refusal, not a duplicate.
- Availability of the audit file against deletion. The chain proves
  tampering happened; it cannot resurrect removed data. Ship the JSONL (or
  use a sink) somewhere append-only if deletion is in your threat model.
- Multi-writer file safety. `HashChainAuditLog` is single-writer by
  design; multi-instance deployments use a store-backed sink.

## Primitives are attested, not enforced

A tool whose argument is free-form (raw SQL, shell, arbitrary HTTP, a code
interpreter) has no target an in-process check can bind: the payload *is* the
blast radius. flue-guard's honest options are limited, and it takes both:

- It **refuses to certify** such a tool as governed. A side-effecting
  `kind: "primitive"` will not define until you set `egressControlled: true`,
  which is your written attestation that containment exists out-of-band (an
  egress allowlist, no credential in the sandbox, database-level controls).
- It **flags every call as broad** in the audit (`kind: "primitive"` on the
  entry), so a reviewer reading the log sees which entries a scope check did
  not actually constrain.

The flag is not verified, because it cannot be: the library has no way to
inspect your egress rules. Enforcement belongs to the substrate; refusing to
pretend otherwise is the feature.

## Residual risks worth knowing

- In-conversation deception. Governance bounds what a tool call can do;
  it does not stop the model from *saying* something wrong, or from being
  socially engineered within the caller's own legitimate authority (a user
  can still be talked into asking for a refund they're entitled to).
- Scope pattern breadth. `ticket:*` in a context grants every ticket. The
  patterns you bind are policy; audit entries record the requested scopes so
  over-broad grants are at least visible.
- Key custody. The HMAC key and the audit sink's credentials define who
  could forge or truncate history. Keep them out of the environment the
  agent's handlers run in.
