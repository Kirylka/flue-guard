# Optional Jev guard for Flue agents

Status: proposed design, researched September 18, 2026. The Flue 2 upgrade is
implemented separately. The interfaces below are proposals, not shipped APIs.
No live Jev request or guard-quality evaluation has been performed.

## Recommendation

Add an optional per-tool `guard` step after deterministic authorization and
before approval, idempotency, and execution. Keep the core provider-independent;
put the TypeSafe adapter behind `flue-guard/jev` with an optional SDK peer.
The existing `parameters`, `scope`, `authorize`, and `execute` remain unchanged.

Jev is useful for judging whether a proposed action follows the user's request,
whether supplied content attempts to redirect the agent, and whether the action
violates a written business policy. Ownership, tenant boundaries, arithmetic,
allowlists, and permission grants stay in application code. A semantic guard
must not satisfy the existing requirement for an authorization gate on a
side-effecting tool.

TypeSafe's [guardrail cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails)
uses several hazard questions in one request and application-owned routing
thresholds. Its [known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
explicitly include susceptibility to adversarial state. A typed answer can still
be a wrong judgment; this integration must not promise injection immunity.

## Alternatives considered

| Approach | Benefit | Limitation |
| --- | --- | --- |
| Call Jev inside `authorize: caller(...)` today | No new core API; async checks already work | Conflates authority with semantic judgment, loses structured assessment metadata, and only offers allow/deny |
| Implement Jev as an `ApprovalAdapter` | Reuses existing allow/deny/pending plumbing | Could replace a human approval requirement and makes model assessment look like an approver |
| Separate `guard` with an optional Jev adapter | Independent authorization, assessment, and approval; explicit audit evidence | Adds a pipeline step, error codes, and audit metadata |

Choose the third approach. Start with governed custom tools. Built-in shell/file
tools, MCP tools, subagent delegation, model input, and final model output are
outside that coverage unless explicitly wrapped. Whole-agent interception is a
separate project; merely mounting one guarded tool does not protect the rest.

## Proposed API

Add `guard?: ToolGuard<TArgs>` to `GovernedToolSpec`. Export the provider-neutral
interfaces from the root and `createJevGuard` only from the optional subpath.

```ts no-check
interface GuardRequest<TArgs> {
  tool: string;
  args: Readonly<TArgs>;
  ctx: ExecutionContext;
}

interface GuardAssessment {
  decision: "allow" | "deny" | "review";
  reasonCodes: string[];
  policyId: string;
  policyVersion: string;
  provider: string;
  model: string;
  probabilities: Record<string, number>;
  durationMs: number;
}

interface ToolGuard<TArgs> {
  evaluate(request: GuardRequest<TArgs>): Promise<GuardAssessment>;
}
```

`createJevGuard<TArgs>` accepts an injected `TypeSafeClient`, an explicit model,
policy id/version, a fixed dictionary of hazard questions, per-question review
and deny thresholds, a total timeout, and an application-owned `state(request)`
projector. The projector returns JSON-plain data. It must select only the context
needed for judgment; sending all of `ctx`, credentials, or the entire transcript
by default is prohibited by this adapter's contract.

The state should distinguish:

- The authenticated sender's request, retrieved from a server-bound source or
  `ctx.attributes`. This records provenance; the request text remains untrusted.
- The proposed tool name and parsed arguments, supplied by the pipeline.
- Relevant retrieved content, explicitly marked as untrusted evidence.
- Policy definitions, controlled by the application and never by model arguments.

Each field needs an explicit source. If the required user request or relevant
evidence is unavailable, do not silently evaluate an empty state and allow it.
Return a review requirement for missing evidence, or a guard error for invalid
configuration. Copying projected provider state alone does not bind execution
to the assessed action. For guarded tools, create one detached, deeply frozen
snapshot of parsed arguments and trusted identity/attributes before RBAC and
authorization. Use that same snapshot for authorization, guard projection,
approval identity, idempotency, audit, output shaping, and execution. Snapshot
again after a custom validator if it returned shared references. Preserve the
AbortSignal separately as a live cancellation capability; do not serialize it.
The initial guarded-tool contract requires JSON-plain arguments and context
attributes; reject unsupported values before assessment. The unguarded path
retains its existing behavior. Validate and snapshot the projected provider
state as well, including externally retrieved evidence.

## TypeSafe call and routing

Use `@typesafe-ai/sdk` and `client.systemOne({ model, state, questions }, options)`.
The JavaScript API exposes named answers and the actual responding model in
`result.model`. See the [client reference](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient)
and [response contract](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult).

Start with three Noul questions, batched in a single request:

| Question | Explicit yes criterion |
| --- | --- |
| `intentMismatch` | The proposed action is outside what the authenticated sender requested |
| `injectionAttempt` | Untrusted evidence contains instructions attempting to override the task or policy |
| `policyViolation` | The proposed action violates the specific application policy supplied in the question |

Use concrete per-tool criteria, including benign counterexamples such as quoting
an injection string for analysis. Never ask Jev to infer ownership or calculate
whether an amount exceeds a numeric limit; compute those facts first.

Noul returns a yes-probability in `answer.noul`; it has **no `confidence` field**.
Choice and Score expose confidence derived from their probability distribution.
Do not interpret a low hazard probability as low confidence.
[TypeSafe confidence semantics](https://docs.typesafe.ai/confidence)

Routing is deterministic: validate all required values as finite numbers in
`[0, 1]`; deny if any hazard reaches its deny threshold; otherwise review if any
reaches its review threshold; otherwise allow. Denial takes precedence over
review. Validate `0 <= review < deny <= 1` at construction. Require explicit
thresholds; the library cannot supply a universally safe default. Fit thresholds
against representative labeled cases, then freeze them for held-out evaluation.

## Pipeline and approval behavior

The new order is:

`context → validation → RBAC → scope → authorize → guard → approval → idempotency → intent audit → execute → outcome audit`

| Guard result | Pipeline behavior |
| --- | --- |
| Allow | Continue; any existing approval requirement still applies |
| Deny | Audit `deny/denied` with `guard_denied`; throw `GuardDeniedError`; no approval or execution |
| Review | Require the existing approval adapter, combining guard reasons with any tool approval reason |
| Timeout, abort, network error, malformed answer | Audit `deny/error` with `guard_unavailable`; throw `GuardUnavailableError`; no execution |

A review cannot proceed without an approval adapter. A pending response reuses
`ApprovalPendingError`; an approved response may resolve review, but never
override a deterministic denial or a guard denial. Add the assessment as an
optional field of `ApprovalRequest` so the reviewer sees the basis of review.

On retry, rerun authorization and the guard before consulting approval or
returning an idempotent replay. This preserves the current pipeline's check-
before-replay ordering. An approval reference must bind tenant, actor, tool,
canonical arguments, request/evidence identity, and policy version. A stale
approval must not authorize a different action. The approval adapter owns this
binding and expiry; use durable storage rather than an in-process promise.

Flue turns thrown tool errors into model-visible tool errors. A pending exception
does **not** automatically pause a dispatched session. The host must persist the
approval request, surface it to a reviewer, and deliver a fresh authenticated
signal after resolution. Restrict tool availability while approval is pending
where appropriate; idempotency prevents repeating the approved side effect.

## Failure budget and audit

Combine the tool cancellation signal with a configured total deadline. Pass it
to the SDK, set its per-attempt timeout, and set `retry.maxRetries: 0` initially.
The SDK timeout alone is per attempt, so it does not bound total retries.
[Request options](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions),
[retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)

Do not turn outages into low-risk assessments. Keep provider bodies and keys out
of model-visible errors. A configured guard must complete before an idempotency
claim or side-effect intent is written. Recheck cancellation before execution.

Add optional `guard: GuardAssessment` metadata to audit records. Include it on
denial, pending approval, intent, success, replay, and subsequent error records;
provider failures record a sanitized error category and requested model instead
of fabricated probabilities. Use separate typed error metadata for that case.
Do not log raw projected state by default. Reason codes come from code, not
generated prose. The existing canonical hash covers the added fields, while old
entries remain valid when the field is absent. Update custom adapters and the
audit viewer to preserve/display this metadata.

## Implementation and evaluation stages

1. Add the neutral guard step and error taxonomy in `src/toolkit.ts`,
   `src/errors.ts`, and a new `src/guard.ts`; extend audit and approval types.
   Test ordering, every outcome, missing approval, cancellation, and audit
   failures with deterministic in-memory guards. Hold a provider response open,
   mutate the original arguments and context, and verify execution and approval
   binding still use the assessed snapshot; attempts to mutate the snapshot
   must not change it.
2. Add `src/jev.ts`, the optional package export/peer, and contract tests using
   an injected SDK client with a controlled transport. Verify exact questions,
   state minimization, malformed responses, model metadata, and deadline behavior.
3. Exercise the adapter through the real Flue faux-model loop. Test a denied tool
   cannot execute, review remains pending until separately approved, changed
   arguments invalidate approval, and retries cannot duplicate side effects.
4. Run a separately invoked live evaluation with a user-provided API key and a
   pinned available model. Keep network calls out of the default test suite.
   Report unsafe-action false negatives, benign-action false positives, review
   rate, p50/p95 latency, failures, and token usage. Include quoted attacks,
   indirect injection in tool results, ambiguous requests, missing evidence,
   tenant switching, encoded content, and long distracting inputs.

First deploy the assessment in an evaluation environment where writes are
stubbed or independently approved. Enable automatic allow only for tool/policy
combinations with reviewed evaluation results. A model or policy version change
requires rerunning that evaluation; `jev-latest` is unsuitable for a frozen
quality baseline.
