# flue-guard

Governance for [Flue](https://flueframework.com) tools. flue-guard stops an
agent from acting on the wrong resource, acting twice, or acting unrecorded:
per-call authorization checked against your app's trusted context, idempotent
side effects, and a hash-chained audit log, all in-process.

Flue's own guidance is that [a tool's parameters are model-selected inputs,
not an authorization boundary](https://flueframework.com/docs/guide/tools/#protect-access).
flue-guard is that boundary, as a library.

**ESM-only · Node 22.19+ · peer `@flue/runtime` >=1.0.0-beta.9**

## Quickstart

```bash
npm i flue-guard @flue/runtime valibot
```

```ts
import { defineAgent, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { govern, caller } from "flue-guard";

declare const accounts: {
  ownedBy(accountId: string, actorId: string): Promise<boolean>;
  sendResetLink(accountId: string): Promise<void>;
};

const gov = govern({ audit: "audit.jsonl" }); // hash-chained JSONL receipt

const resetPassword = gov.tool({
  name: "reset_password",
  description: "Send a password reset link.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  // The check the Meta incident was missing: caller must own the account.
  authorize: caller(
    (a: { accountId: string }, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
  ),
  // A retry replays the first result instead of sending a second link.
  idempotency: { key: (a) => `reset:${a.accountId}` },
  execute: async (a) => {
    await accounts.sendResetLink(a.accountId);
    return "Sent.";
  },
});

export const agent = defineAgent(() => ({
  model: "anthropic/claude-haiku-4-5",
  tools: [resetPassword] as ToolDefinition[],
}));
```

Bind the caller once per run, from your auth, never from the model:

```ts
import type { GovernedToolkit } from "flue-guard";

declare const gov: GovernedToolkit;
declare const session: { prompt(text: string): Promise<unknown> };

await gov.run(
  { actor: { id: "user-7", roles: ["account_holder"] }, tenantId: "acme" },
  () => session.prompt("I'm locked out, reset my password"),
);
```

That is the whole API for most uses: `govern`, `gov.tool`, `caller`,
`gov.run`. The tool refuses to define without an authorization gate, checks
ownership before the side effect, won't fire twice on a retry, and writes a
tamper-evident line for every call, denials included.

The one idea underneath: the model controls the arguments, your application
controls the context. `authorize` and `scope` compare the untrusted arguments
against the trusted context, which travels through `AsyncLocalStorage` where
the model can never read or set it.

## Documentation

The docs site: **<https://kirylka.github.io/flue-guard/>**

- [Tutorial: your first governed tool](https://kirylka.github.io/flue-guard/tutorial): from `npm i` to a denied call and a verified audit line, in five minutes
- [Choose authorize vs scope](https://kirylka.github.io/flue-guard/guides/authorize-vs-scope)
- [Require human approval](https://kirylka.github.io/flue-guard/guides/require-approval)
- [Make retries safe](https://kirylka.github.io/flue-guard/guides/safe-retries)
- [Verify & protect the audit log](https://kirylka.github.io/flue-guard/guides/protect-the-audit-log)
- [Run on Cloudflare Workers](https://kirylka.github.io/flue-guard/guides/cloudflare-workers)
- [Shape what the model sees](https://kirylka.github.io/flue-guard/guides/shape-model-output)
- [API reference](https://kirylka.github.io/flue-guard/reference/entry-points)
- [Why flue-guard exists](https://kirylka.github.io/flue-guard/explanation/why-flue-guard) · [The pipeline](https://kirylka.github.io/flue-guard/explanation/pipeline) · [The trust model](https://kirylka.github.io/flue-guard/explanation/trust-model)

## Sharp edges

- Results must be JSON-plain. Flue serializes what the model sees (the
  handler's return, or `toModelOutput`'s) and rejects `bigint`, `Date`, class
  instances, and circular structures.
- Use Valibot for `parameters`. Any other validator still governs and
  validates internally, but Flue's schema guidance for the model degrades to
  an unconstrained object. With Valibot, the model sees the real shape.
- Idempotency keys and requested scopes are audited unredacted (they are
  the log's correlation index). Build them from stable ids, never from
  secrets or PII.
- The file audit sink is single-writer. One process, one instance. For
  multi-instance deployments use a store-backed sink (a database, or the
  [D1 reference adapter](https://github.com/Kirylka/flue-guard/blob/main/examples/cloudflare-adapters.ts)).

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

```bash
npm run example   # mock-model walkthrough: denials, replay, approval, audit verify
npm run spike     # a real Flue dispatched turn with a faux model, no API key
```

[`examples/audit-viewer.html`](./examples/audit-viewer.html) verifies an
`audit.jsonl` hash chain in your browser and lets you tamper with a line to
watch verification catch it.

## License

[MIT](./LICENSE).
