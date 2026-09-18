# flue-guard

[![npm](https://img.shields.io/npm/v/flue-guard)](https://www.npmjs.com/package/flue-guard)
[![CI](https://github.com/Kirylka/flue-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kirylka/flue-guard/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-site-blue)](https://kirylka.github.io/flue-guard/)

Governance for [Flue](https://flueframework.com) tools: per-call
authorization, safe retries, and a tamper-evident audit log, in-process.
It stops an agent from acting on the wrong resource, acting twice, or acting
unrecorded.

Flue's own guidance says [a tool's parameters are model-selected inputs, not
an authorization boundary](https://flueframework.com/docs/guide/tools/#protect-access).
flue-guard is that boundary, as a library.

**ESM-only · Node 22.19+ · peer `@flue/runtime` ^2.0.8**

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

## Upgrading from Flue beta

This release targets Flue **2.0.8 or newer within 2.x**. The governance spec
(`parameters`, `authorize`, `execute`) stays the same. Direct invocations of
the adapted tool now use `tool.run({ data: args })` and return `{ output }`.
Agents use `'use agent'`, `useModel`, and `useTool`; see the
[Flue migration guide](https://flueframework.com/docs/guide/migration/).

## Documentation

| | |
| --- | --- |
| [Tutorial](https://kirylka.github.io/flue-guard/tutorial) | Your first governed tool: a denied call and a verified audit line, in five minutes |
| [How-to guides](https://kirylka.github.io/flue-guard/guides/authorize-vs-scope) | Authorize vs scope, human approval, safe retries, audit protection, Cloudflare Workers, shaping model output |
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

## License

[MIT](./LICENSE).
