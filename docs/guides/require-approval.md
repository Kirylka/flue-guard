# Require human approval

Some calls should wait for a person: large refunds, destructive changes,
anything a policy says an agent may propose but not decide. A governed tool
opts in with an `approval` policy; an `ApprovalAdapter` connects that to your
actual workflow: Slack, a ticket queue, a review UI.

Approval is **fail-closed**: if a tool requires approval and no adapter is
configured, the call is denied (`ApprovalDeniedError`), never silently
allowed.

## Declare when approval is needed

The policy decides *whether this call* needs approval. Three forms:

```ts
import * as v from "valibot";
import { govern, always, never } from "flue-guard";
import { autoApprove } from "flue-guard/adapters";

declare const billing: { refund(customerId: string, amount: number): Promise<{ ok: boolean }> };

// autoApprove: local development only; approves everything.
const gov = govern({ audit: "audit.jsonl", approval: autoApprove });

export const issueRefund = gov.tool({
  name: "issue_refund",
  description: "Refund a customer.",
  parameters: v.object({ customerId: v.string(), amount: v.number() }),
  sideEffect: true,
  scope: (a) => `customer:${a.customerId}`,

  // Pick ONE of:
  approval: always("side effect"),
  // approval: (a) => (a.amount > 50 ? `refund over $50 ($${a.amount})` : false),
  // approval: never(),

  execute: (a) => billing.refund(a.customerId, a.amount),
});
```

- `always(reason?)`: every call, with the reason recorded in the audit entry.
- A predicate `(args, ctx) => …`: return a reason string to require approval
  for this call, `false`/`undefined` to skip it.
- `never()`: explicitly no approval. It deliberately does **not** count as an
  authorization gate, so a side-effecting tool still needs `scope`,
  `authorize`, or `requireRoles` alongside it.

## Write an adapter that suspends instead of blocking

Real approvals take minutes or hours; blocking the agent's event loop that
long isn't an option. The adapter's contract has a third answer besides
approve/deny: **pending**.

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

Returning `{ pending: true }` makes the tool call throw
`ApprovalPendingError`, which is a *suspend signal* rather than a denial. No
side effect has run, and the deferral is written to the audit log as
`defer/pending`, so a call waiting on a human is on the record.

## Catch the suspension, park the run, resume

At the boundary where you drive the agent, treat the pending signal
differently from a refusal:

```ts
import { isApprovalPending, isGovernanceDenial, type GovernedToolkit, type TrustedContext } from "flue-guard";

declare const gov: GovernedToolkit;
declare const trustedCtx: TrustedContext;
declare const session: { prompt(text: string): Promise<unknown> };
declare const parkRun: (approvalRef: string | undefined) => Promise<void>;

try {
  await gov.run(trustedCtx, () => session.prompt("refund order 812, $120"));
} catch (err) {
  if (isApprovalPending(err)) {
    // err.ref is your adapter's handle (the ticket id).
    // Persist the run, return to the user, resume on your approval webhook.
    await parkRun(err.ref);
  } else if (isGovernanceDenial(err)) {
    // A real refusal. Surface it; don't retry.
    throw err;
  } else {
    throw err;
  }
}
```

Resuming **re-invokes the tool**: the whole pipeline runs again and the
adapter is consulted again. This time the ticket is `approved` or `rejected`
and it answers for real. Flue can persist and resume sessions; the re-invoked
call is indistinguishable from the first, by design.

Two consequences of the re-invoke model:

- "Approve once" memory belongs in the adapter, not the policy. The policy
  answers "does this call need approval?"; the adapter answers "does it
  already have it?" (that's what `ref` is for).
- Pair approval with an idempotency key. The tool runs twice (suspend,
  then resume); the side effect must not. See
  [Make retries safe](/guides/safe-retries).

## Related

- [Errors reference](/reference/errors): `ApprovalPendingError` vs
  `ApprovalDeniedError`, and the guard functions.
- [Adapters reference](/reference/adapters#approvaladapter): the full
  `ApprovalRequest`/`ApprovalDecision` contract.
