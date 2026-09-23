# Require human approval

Some calls should wait for a person: large refunds, deleting data, anything an
agent may suggest but should not decide alone. A tool asks for this with an
`approval` policy. An `ApprovalAdapter` connects it to where your people work:
Slack, a ticket queue, a review page.

If a tool needs approval and the toolkit has no adapter, the call is refused
with `ApprovalDeniedError`. It is never let through silently.

## Declare when approval is needed

The policy decides whether *this call* needs a person. Here, refunds over $50
do:

```ts
import * as v from "valibot";
import { govern } from "flue-guard";
import { autoApprove } from "flue-guard/adapters";

declare const billing: { refund(customerId: string, amount: number): Promise<{ ok: boolean }> };

// autoApprove approves everything. Use it only for local development.
const gov = govern({ audit: "audit.jsonl", approval: autoApprove });

export const issueRefund = gov.tool({
  name: "issue_refund",
  description: "Refund a customer.",
  parameters: v.object({ customerId: v.string(), amount: v.number() }),
  sideEffect: true,
  // Small refunds skip approval, so the tool still needs its own check.
  scope: (a) => `customer:${a.customerId}`,
  approval: (a) => (a.amount > 50 ? `refund over $50 ($${a.amount})` : false),
  execute: (a) => billing.refund(a.customerId, a.amount),
});
```

Return a string to require approval; it is written to the log as the reason.
Return `false` to let the call through. Two shortcuts cover the fixed cases:

- `always("reason")` asks for approval on every call.
- `never()` says in the code that the tool needs no approval. It does **not**
  count as a check, so a tool with `sideEffect: true` still needs `scope`,
  `authorize`, or `requireRoles`.

## Write an adapter that suspends instead of blocking

Real approvals take minutes or hours. Nothing can wait that long inside one
call. So besides "approved" and "denied", an adapter can answer **pending**.

```ts
import type { ApprovalAdapter } from "flue-guard";

declare const tickets: {
  findOrCreate(tool: string, args: unknown, actorId: string): Promise<{
    id: string;
    state: "open" | "approved" | "rejected";
    approver?: string;
    reason?: string;
  }>;
};

export const ticketApproval: ApprovalAdapter = {
  async request(req) {
    const ticket = await tickets.findOrCreate(req.tool, req.args, req.ctx.actor.id);

    if (ticket.state === "approved") {
      return { approved: true, approver: ticket.approver };
    }
    if (ticket.state === "rejected") {
      return { approved: false, reason: ticket.reason };
    }
    // Still waiting: suspend the call. `approved` is ignored when pending.
    return { approved: false, pending: true, ref: ticket.id };
  },
};
```

`{ pending: true }` makes the tool call throw `ApprovalPendingError`. It means
"not yet", not "no". Nothing has run. The log records the call as
`defer/pending`, so a call waiting for a person is on record too.

## Catch the suspension, park the run, resume

When you call governed tools yourself, catch "pending" and let everything else
through:

```ts
import { isApprovalPending, type GovernedToolkit, type TrustedContext } from "flue-guard";

declare const gov: GovernedToolkit;
declare const trustedCtx: TrustedContext;
declare const executeGovernedTools: () => Promise<unknown>;
declare const parkRun: (approvalRef: string | undefined) => Promise<void>;

try {
  await gov.run(trustedCtx, executeGovernedTools);
} catch (err) {
  if (!isApprovalPending(err)) throw err; // a refusal or a bug
  // err.ref is your adapter's id for the request, for example the ticket id.
  // Save the run, answer the user, and resume from your approval webhook.
  await parkRun(err.ref);
}
```

To resume, call the tool again. Every check runs again, and the adapter is
asked again. This time the ticket is approved or rejected, so it gives a real
answer. Tie the approval to the same caller, tenant, tool, and arguments, so
it cannot approve a different action.

A dispatched Flue agent works differently. Flue turns a thrown tool error into
a message the model sees, so `ApprovalPendingError` does not pause the agent,
and your `catch` never sees it. Your server has to save the approval request
and send the agent a new signal once a person has decided.

Because the tool is called twice, two things follow:

- Remembering "already approved" is the adapter's job, not the policy's. The
  policy answers "does this call need approval?". The adapter answers "does it
  have it already?". That is what `ref` is for.
- Give the tool an idempotency key. It is called twice, once to ask and once
  to run, and the side effect must happen only once. See
  [Make retries safe](/guides/safe-retries).

## Related

- [Errors reference](/reference/errors): `ApprovalPendingError` vs
  `ApprovalDeniedError`, and the guard functions.
- [Adapters reference](/reference/adapters#approvaladapter): the full
  `ApprovalRequest`/`ApprovalDecision` contract.
