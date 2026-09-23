# Choose authorize vs scope

Both run on every call. Both compare the arguments the model wrote with what
your application knows about the caller. They answer different questions:

| Gate | Question it answers | Use when |
| --- | --- | --- |
| `scope` | "Is this call inside the caller's allowed territory?" | The grant is enumerable up front: tenants, customer lists, entitlements |
| `authorize` | "Is this caller allowed to do this to this target?" | The answer needs a lookup: ownership, record state, a server-side anchor |

A tool with `sideEffect: true` must declare at least one check: `scope`,
`authorize`, `requireRoles`, or `approval`. Without one, defining the tool
throws `GovernanceConfigError`. That is on purpose: a tool with no check fails
at startup instead of in production.

Every example below uses this toolkit:

```ts setup
import * as v from "valibot";
import { govern, caller, trusted } from "flue-guard";

const gov = govern({ audit: "audit.jsonl" });
```

## Gate by scope: enumerable grants

You declare what the call *wants to touch*. The library compares that with the
`scopes` your application put on the context. You never write the comparison
yourself, so you cannot forget to include the caller in it.

```ts
declare const billing: {
  refund(tenantId: string, customerId: string, amount: number): Promise<{ ok: boolean }>;
};

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

A call outside the caller's scopes throws `ScopeViolationError`. The log shows
it as `deny/scope_violation`. Scope strings are written to the log
**unmasked**, because that is how you search it later. Build them from stable
ids, never from secrets.

Two rules that refuse rather than allow:

- If `scope` is the tool's **only** check and returns no scopes for a call,
  the call is refused. An empty list would otherwise count as "nothing out of
  scope" and let the call through.
- `ctx.scopes` is optional. Leave it out for callers that only use tools
  checked by `authorize`. An empty list refuses every call to a scoped tool.

## Gate by authorize: looked-up answers

Some answers need a lookup that a fixed list cannot hold: who owns an account,
what state a record is in. Use `authorize` for those. Every `authorize` check
names what it compares against: the caller, or a lookup you registered. So you
cannot write the usual bug: a check that looks only at the arguments and never
at anything your server knows.

**Anchor 1: the authenticated caller.** The common case:

```ts
declare const accounts: { ownedBy(accountId: string, actorId: string): Promise<boolean> };

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
TypeScript cannot work out the type of `a` inside `caller(...)`, because it
reads `caller` before `parameters`. So write it out:
`caller((a: { accountId: string }, ctx) => …)`. If you prefer no annotation,
the object form `{ anchor: "caller", check: (a, ctx) => … }` infers the type.
:::

**Anchor 2: a lookup you registered.** For account recovery, where nobody is
logged in. Your server runs the named lookup and passes the result to your
check:

```ts
declare const accounts: { emailOnFile(accountId: string): Promise<string> };

// Trusted sources are a toolkit-level option, so this example needs its own.
const govWithSources = govern({
  audit: "audit.jsonl",
  trustedSources: {
    accountEmail: (a: { accountId: string }) => accounts.emailOnFile(a.accountId),
  },
});

export const recoverAccount = govWithSources.tool({
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

A name that was never registered fails when the tool is defined, not when it
is called. A `false` answer from either kind of check throws
`AuthorizationDeniedError`, logged as `deny/authorization_denied`.

## Combine them

Each check is its own step. Declare several and they all run, always in the
same order: `requireRoles`, `scope`, `authorize`, `guard`, `approval`. A risky tool can
use each one for what it does best:

```ts
declare const accounts: { ownedBy(accountId: string, actorId: string): Promise<boolean> };
declare const registrar: { transfer(accountId: string, to: string): Promise<void> };

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

`scope` and `authorize` need a clear *target*, like an account id. Raw SQL, a
shell command, or an arbitrary HTTP request has no target to check: the text
itself is what does the damage. Mark those tools `kind: "primitive"`. One that
changes data will not load until you also set `egressControlled: true`. That
flag is your statement that something outside this library limits what the
tool can reach, such as a network allowlist or a read-only database user. See
[the trust model](/explanation/trust-model#free-form-tools-are-declared-not-checked)
for what the flag does and does not do.

## Related

- [Tool spec reference](/reference/tool-spec): every field, including
  `requireRoles`, `kind`, and `unsafeAllowUnauthorized`.
- [Require human approval](/guides/require-approval): the fourth gate.
- [The pipeline](/explanation/pipeline): the order everything runs in.
