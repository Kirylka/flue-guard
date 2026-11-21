# flue-guard

[![npm](https://img.shields.io/npm/v/flue-guard)](https://www.npmjs.com/package/flue-guard)
[![CI](https://github.com/Kirylka/flue-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kirylka/flue-guard/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-site-blue)](https://kirylka.github.io/flue-guard/)

**[Documentation](https://kirylka.github.io/flue-guard/)** · ESM-only · Node
22.19+ · peer `@flue/runtime` ^2.0.8

When you give an agent a tool, the model decides when to call it and writes
the arguments. That's the whole point, and it's also the problem. If the tool
resets a password, the model is the one typing the account id. Flue says it
plainly: [a tool's parameters are model-selected inputs, not an authorization
boundary](https://flueframework.com/docs/guide/tools/#protect-access).

So the "is this person allowed to do that?" check has to live somewhere the
model can't reach. flue-guard is that place. It wraps a Flue tool and asks
three questions before your code runs:

- **May this caller touch this record?** If not, your handler never runs.
- **Has this already happened?** A retry gets the first result back, so
  nobody is refunded twice.
- **What do we write down?** Every decision, yes or no, goes into a
  hash-chained log you can check later.

You don't need it for an agent that reads public help articles. You do once a
tool changes something real: a password, a refund, an account. A careful
prompt is not a check. And if you forget the check, flue-guard won't let the
tool load, so the mistake shows up on your machine instead of in an incident
report.

## Quickstart

```bash
npm i flue-guard @flue/runtime valibot
```

```ts
'use agent';
import { useDelivery, useModel, useTool } from "@flue/runtime";
import * as v from "valibot";
import { govern } from "flue-guard";

// Your application's data layer:
declare const accounts: {
  ownedBy(accountId: string, actorId: string): Promise<boolean>;
  sendResetLink(accountId: string): Promise<void>;
};

const gov = govern({ audit: "audit.jsonl" });

export function SupportAgent() {
  useModel("anthropic/claude-haiku-4-5");
  // Your server authenticates the sender before attaching these attributes.
  // Without them, every governed tool refuses the call.
  const bound = gov.withSignal(useDelivery(), (attrs) =>
    attrs.actorId && attrs.tenantId
      ? { actor: { id: attrs.actorId, roles: ["account_holder"] }, tenantId: attrs.tenantId }
      : undefined,
  );
  useTool(bound.tool({
    name: "reset_password",
    description: "Send a password reset link.",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    authorize: (a, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
    idempotency: { key: (a) => `reset:${a.accountId}` },
    execute: async (a) => {
      await accounts.sendResetLink(a.accountId);
      return "Sent.";
    },
  }));
  return "Help the caller access their own account.";
}
```

From your authenticated server route, deliver a signal with `dispatch`:

```ts
import { dispatch, type Agent } from "@flue/runtime";

declare const SupportAgent: Agent; // import your registered agent
// Derived from your server's authentication, never copied from request JSON:
declare const caller: { id: string; tenantId: string; conversationId: string };

await dispatch(SupportAgent, {
  id: caller.conversationId,
  message: {
    kind: "signal",
    type: "support.request",
    body: "I'm locked out, reset my password",
    attributes: { actorId: caller.id, tenantId: caller.tenantId },
  },
});
```

Here's what you get. Before anything is sent, the tool checks that the caller
owns the account. If the model retries, the caller gets the first result
instead of a second email. Every decision lands in the audit log. (Arguments
that don't match the schema never get this far: Flue turns them away first,
and you'll find them in Flue's events rather than in this log.)

Notice where the caller comes from: your server, never the chat. Flue runs a
dispatched agent separately from your request, so the identity rides along
on the signal, and `withSignal` picks it up.
[Run on Cloudflare Workers](https://kirylka.github.io/flue-guard/guides/cloudflare-workers#_3-bind-context-per-invocation-when-flue-dispatches)
explains why `gov.run` around `dispatch()` is not enough.

## Documentation

| | |
| --- | --- |
| [Tutorial](https://kirylka.github.io/flue-guard/tutorial) | Your first governed tool: a denied call and a verified audit line, in five minutes |
| [How-to guides](https://kirylka.github.io/flue-guard/guides/authorize-vs-scope) | Authorize vs scope, human approval, safe retries, audit protection, Cloudflare Workers, shaping model output, [the Jev guard](https://kirylka.github.io/flue-guard/guides/jev-guard) |
| [Reference](https://kirylka.github.io/flue-guard/reference/entry-points) | Every entry point, tool-spec field, error, and adapter interface |
| [Explanation](https://kirylka.github.io/flue-guard/explanation/why-flue-guard) | Why it exists, the pipeline, the trust model |

## Things that trip people up

- **Return plain JSON.** Flue turns your result into JSON for the model, and
  it refuses `bigint`, `Date`, class instances, and objects that point back at
  themselves. Strings, numbers, arrays and plain objects are all fine.
- **Use Valibot for `parameters`.** Other validators still work, and the
  arguments are still checked, but the model only sees "some object". With
  Valibot it sees the real fields.
- **Keep secrets out of keys and scopes.** Idempotency keys and scopes go into
  the log as-is, because that's how you find related entries later. Build them
  from ids, never from emails, tokens or anything personal.
- **One file, one writer.** The file log assumes one process. If you run
  several instances, keep the log in a database instead, like the
  [D1 example](https://github.com/Kirylka/flue-guard/blob/main/examples/cloudflare-adapters.ts).

## Entry points

| Import | What's there |
| --- | --- |
| `flue-guard` | `govern`, `createGovernedToolkit`, `caller`, `trusted`, core types, the errors, adapter **interfaces** |
| `flue-guard/audit` | `hashEntry`, `verifyChain`, `HashChainAuditLog`, `InMemoryAuditLog` |
| `flue-guard/adapters` | default RBAC / redaction / idempotency, scope helpers, `toFlueTool` |
| `flue-guard/testing` | in-memory test doubles |
| `flue-guard/jev` | `createJevGuard` (experimental; needs `@typesafe-ai/sdk`) |

Start with `govern()`. You'll rarely need `createGovernedToolkit`; it builds the
same toolkit, but you pass Flue's `defineTool` in yourself.

## See it run

Clone this repo, then:

```bash
npm run example   # mock-model walkthrough: denials, replay, approval, audit verify
npm run spike     # a real Flue dispatched turn with a faux model, no API key
```

For something more hands-on, open
[`examples/audit-viewer.html`](./examples/audit-viewer.html). It checks an
`audit.jsonl` file in your browser, and lets you edit a line and watch the
check catch it.

## Optional guard step

`authorize` answers "who may do this?". It can't read the reply your agent is
about to send and notice that an internal note slipped in. A `guard` can. It
reads the whole call and says yes, no, or "ask a person". The one we ship,
`flue-guard/jev`, asks TypeSafe's Jev model whether the call breaks a policy
you wrote in plain English. It adds to `authorize`; it never replaces it. It's
experimental and needs `@typesafe-ai/sdk`. See
[Add a Jev guard](https://kirylka.github.io/flue-guard/guides/jev-guard).

## License

[MIT](./LICENSE).
