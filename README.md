# flue-guard

[![npm](https://img.shields.io/npm/v/flue-guard)](https://www.npmjs.com/package/flue-guard)
[![CI](https://github.com/Kirylka/flue-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kirylka/flue-guard/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-site-blue)](https://kirylka.github.io/flue-guard/)

**[Documentation](https://kirylka.github.io/flue-guard/)** · ESM-only · Node
22.19+ · peer `@flue/runtime` ^2.0.8

Every tool you hand an agent is a function the model chooses to call, with
arguments the model writes. Flue says this plainly: [a tool's parameters are
model-selected inputs, not an authorization
boundary](https://flueframework.com/docs/guide/tools/#protect-access). The check
has to live somewhere else. flue-guard is that somewhere.

It wraps a Flue tool and runs your checks before the handler. Is this caller
allowed to touch this record? Has this operation already run? What gets written
down about it? A denied call never reaches your code. A retried call never
repeats the side effect. Every decision lands in a hash-chained log you can
verify later.

You want it as soon as a tool does something real. An agent that reads a public
help article is fine without a gate. One that resets a password, issues a
refund, or closes an account is not: the model picks the account id, and a
careful prompt is not a check. flue-guard refuses to define a side-effecting
tool that has no gate at all, so the missing check cannot ship by accident.

## Quickstart

```bash
npm i flue-guard @flue/runtime valibot
```

```ts
'use agent';
import { useDelivery, useModel, useTool } from "@flue/runtime";
import * as v from "valibot";
import { govern, caller } from "flue-guard";

// Your application's data layer:
declare const accounts: {
  ownedBy(accountId: string, actorId: string): Promise<boolean>;
  sendResetLink(accountId: string): Promise<void>;
};

const gov = govern({ audit: "audit.jsonl" });

export function SupportAgent() {
  useModel("anthropic/claude-haiku-4-5");
  const delivery = useDelivery();
  const attrs = delivery.kind === "signal" ? delivery.attributes : undefined;
  if (!attrs?.actorId || !attrs.tenantId) throw new Error("Missing authenticated caller");

  // Your server authenticates the sender before attaching these attributes.
  const bound = gov.withContext({
    actor: { id: attrs.actorId, roles: ["account_holder"] },
    tenantId: attrs.tenantId,
  });
  useTool(bound.tool({
    name: "reset_password",
    description: "Send a password reset link.",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    authorize: caller((a: { accountId: string }, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id)),
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

The tool checks ownership before the side effect, replays a completed retry,
and records governance decisions in a hash-chained audit log. Flue performs
input validation before calling the guard; failures at that earlier layer
appear in Flue's events, not the governance log.

The model controls the arguments; your application controls the identity.
Use `withContext` inside dispatched agents because their execution is detached
from the request. `gov.run(context, fn)` supplies ambient context for direct
calls that execute within `fn`; wrapping `dispatch()` or `init().dispatch()`
in it does not bind the later agent execution.

## Documentation

| | |
| --- | --- |
| [Tutorial](https://kirylka.github.io/flue-guard/tutorial) | Your first governed tool: a denied call and a verified audit line, in five minutes |
| [How-to guides](https://kirylka.github.io/flue-guard/guides/authorize-vs-scope) | Authorize vs scope, human approval, safe retries, audit protection, Cloudflare Workers, shaping model output, [the Jev guard](https://kirylka.github.io/flue-guard/guides/jev-guard) |
| [Reference](https://kirylka.github.io/flue-guard/reference/entry-points) | Every entry point, tool-spec field, error, and adapter interface |
| [Explanation](https://kirylka.github.io/flue-guard/explanation/why-flue-guard) | Why it exists, the pipeline, the trust model |

## Sharp edges

- Results must be JSON-plain. Flue serializes what the model sees (the
  handler's return, or `toModelOutput`'s) and rejects `bigint`, `Date`, class
  instances, and circular structures.
- Use Valibot for `parameters`. Any other validator still governs and
  validates internally, but Flue's schema guidance for the model degrades to
  an unconstrained object. With Valibot, the model sees the real shape.
- Idempotency keys and requested scopes are audited unredacted (they are the
  log's correlation index). Build them from stable ids, never from secrets
  or PII.
- The file audit sink is single-writer: one process, one instance. For
  multi-instance deployments use a store-backed sink such as the
  [D1 reference adapter](https://github.com/Kirylka/flue-guard/blob/main/examples/cloudflare-adapters.ts).

## Entry points

| Import | What's there |
| --- | --- |
| `flue-guard` | `govern`, `createGovernedToolkit`, `caller`, `trusted`, core types, the error taxonomy, adapter **interfaces** |
| `flue-guard/audit` | `hashEntry`, `verifyChain`, `HashChainAuditLog`, `InMemoryAuditLog` |
| `flue-guard/adapters` | default RBAC / redaction / idempotency, scope helpers, `toFlueTool` |
| `flue-guard/testing` | in-memory test doubles |
| `flue-guard/jev` | `createJevGuard` (experimental; needs `@typesafe-ai/sdk`) |

`govern()` is the way in. `createGovernedToolkit` is the explicit form of the
same toolkit, with Flue's `defineTool` injected by you instead of for you, for
when you want to control that wiring yourself.

## See it run

Clone this repo, then:

```bash
npm run example   # mock-model walkthrough: denials, replay, approval, audit verify
npm run spike     # a real Flue dispatched turn with a faux model, no API key
```

[`examples/audit-viewer.html`](./examples/audit-viewer.html) verifies an
`audit.jsonl` hash chain in your browser and lets you tamper with a line to
watch verification catch it.

## Optional guard step

`authorize` decides who may call a tool. It cannot read the reply the agent is
about to send and notice an internal note in it. A `guard` can: it reads the
call and allows it, refuses it, or hands it to a human. The adapter we ship,
`flue-guard/jev`, asks TypeSafe's Jev model whether the call breaks a policy you
wrote in plain English. It never replaces `authorize`. Experimental, and it
needs `@typesafe-ai/sdk`. See
[Add a Jev guard](https://kirylka.github.io/flue-guard/guides/jev-guard).

## License

[MIT](./LICENSE).
