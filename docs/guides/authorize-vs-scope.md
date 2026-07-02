# Choose authorize vs scope

Both are per-call gates that compare the model's untrusted arguments against
the trusted context. They answer different questions:

| Gate | Question it answers | Use when |
| --- | --- | --- |
| `scope` | "Is this call inside the caller's allowed territory?" | The grant is enumerable up front: tenants, customer lists, entitlements |
| `authorize` | "Is this caller allowed to do this to this target?" | The answer needs a lookup: ownership, record state, a server-side anchor |

A side-effecting tool must declare at least one gate (`scope`, `authorize`,
`requireRoles`, or `approval`) or it refuses to define with a
`GovernanceConfigError`. That refusal is the point: the missing check can't
ship by accident.

## Gate by scope: enumerable grants

Declare what the call *wants to touch*; the library compares it to the
`scopes` your application put on the trusted context. You never write the
comparison, so you can't forget to involve the caller.

```ts
import * as v from "valibot";
import { govern } from "flue-guard";

declare const billing: {
  refund(tenantId: string, customerId: string, amount: number): Promise<{ ok: boolean }>;
};

const gov = govern({ audit: "audit.jsonl" });

export const issueRefund = gov.tool({
  name: "issue_refund",
  description: "Refund a customer.",
  parameters: v.object({ customerId: v.string(), amount: v.number() }),
  sideEffect: true,
  // What this call touches. Compared against ctx.scopes on every call.
  scope: (a) => `customer:${a.customerId}`,
  execute: (a, ctx) => billing.refund(ctx.tenantId, a.customerId, a.amount),
});
```

The grant side lives on the context you bind at the request boundary:

```ts
import type { TrustedContext } from "flue-guard";

// From your auth / entitlements, never from the conversation.
export const trustedCtx: TrustedContext = {
  actor: { id: "agent-42", roles: ["support"] },
  tenantId: "acme",
  scopes: ["customer:c-123", "ticket:*"], // `*` matches any run of characters
};
```

A call whose derived scope isn't covered throws `ScopeViolationError` and is
audited as `deny/scope_violation`. Scope strings are recorded **unredacted**
(they're the forensic index), so build them from stable ids, never secrets.

Two fail-closed rules to know:

- If `scope` is the tool's **only** gate and a call derives no scopes, the
  call is refused, because an empty derivation would otherwise be vacuously
  "in scope".
- `ctx.scopes` is optional. Omit it for actors that only use
  `authorize`-gated tools; an empty list denies every scoped call.

## Gate by authorize: looked-up answers

When "allowed?" needs a lookup a static list can't capture (account
ownership, the state of a record), use `authorize`. It is keyed to a
**declared trusted anchor**, so the classic bug (comparing an argument against
nothing trusted) has no shape you can write.

**Anchor 1: the authenticated caller.** The common case:

```ts
import * as v from "valibot";
import { govern, caller } from "flue-guard";

declare const accounts: { ownedBy(accountId: string, actorId: string): Promise<boolean> };

const gov = govern({ audit: "audit.jsonl" });

export const closeAccount = gov.tool({
  name: "close_account",
  description: "Close an account the caller owns.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  authorize: caller(
    (a: { accountId: string }, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
  ),
  execute: async (a) => ({ closed: a.accountId }),
});
```

::: tip Annotate the argument type
TypeScript cannot infer `caller`'s argument type from the surrounding
`gov.tool` literal (the helper call is resolved before `parameters` is), so
state it: `caller((a: { accountId: string }, ctx) => …)`. The plain-object
form `authorize: { anchor: "caller", check: (a, ctx) => … }` infers fully if
you prefer zero annotations.
:::

**Anchor 2: a registered trusted source.** For anonymous-recovery flows where
there is no authenticated actor. The named source is resolved server-side and
its value handed to your check:

```ts
import * as v from "valibot";
import { govern, trusted } from "flue-guard";

declare const accounts: { emailOnFile(accountId: string): Promise<string> };

const gov = govern({
  audit: "audit.jsonl",
  trustedSources: {
    accountEmail: (args) => accounts.emailOnFile((args as { accountId: string }).accountId),
  },
});

export const recoverAccount = gov.tool({
  name: "recover_account",
  description: "Start account recovery when the reset email matches the one on file.",
  parameters: v.object({ accountId: v.string(), resetEmail: v.string() }),
  sideEffect: true,
  authorize: trusted(
    "accountEmail",
    (a: { resetEmail: string }, emailOnFile) => a.resetEmail === emailOnFile,
  ),
  execute: async (a) => ({ recoveryStartedFor: a.accountId }),
});
```

Referencing an unregistered source name fails at definition time, not at call
time. A false answer from either anchor throws `AuthorizationDeniedError` and
audits as `deny/authorization_denied`.

## Combine them

Gates are independent pipeline steps: declare several and they all run, in a
fixed order (`RBAC -> scope -> authorize -> approval`). A typical high-risk tool
uses each for what it's best at:

```ts
import * as v from "valibot";
import { govern, caller } from "flue-guard";

declare const accounts: { ownedBy(accountId: string, actorId: string): Promise<boolean> };
declare const registrar: { transfer(accountId: string, to: string): Promise<void> };

const gov = govern({ audit: "audit.jsonl" });

export const transferDomain = gov.tool({
  name: "transfer_domain",
  description: "Transfer a domain to another registrar.",
  parameters: v.object({ accountId: v.string(), to: v.string() }),
  sideEffect: true,
  requireRoles: ["account_admin"],                    // coarse: who may ever call this
  scope: (a) => `account:${a.accountId}`,             // territory: within the caller's grants
  authorize: caller(                                  // ownership: this caller, this account
    (a: { accountId: string }, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
  ),
  approval: true,                                     // and a human signs off
  execute: async (a) => registrar.transfer(a.accountId, a.to),
});
```

## When neither can help: primitives

`scope` and `authorize` govern tools with a structured *target*. A free-form
payload (raw SQL, shell, arbitrary HTTP) has no target an in-process check
can bind. Declare those `kind: "primitive"`; a side-effecting primitive
refuses to define unless you set `egressControlled: true`, your attestation
that its blast radius is bounded out-of-band. See
[the trust model](/explanation/trust-model#primitives-are-attested-not-enforced)
for what that flag does and doesn't mean.

## Related

- [Tool spec reference](/reference/tool-spec): every field, including
  `requireRoles`, `kind`, and `unsafeAllowUnauthorized`.
- [Require human approval](/guides/require-approval): the fourth gate.
- [The pipeline](/explanation/pipeline): the order everything runs in.
