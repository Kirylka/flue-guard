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

**ESM-only · Node 22.19+ · peer `@flue/runtime` >=1.0.0-beta.9**

## Quickstart

```bash
npm i flue-guard @flue/runtime valibot
```

```ts
import { defineAgent, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { govern } from "flue-guard";

// Stand-ins for your app's data layer and Flue session:
declare const accounts: {
  ownedBy(accountId: string, actorId: string): Promise<boolean>;
  sendResetLink(accountId: string): Promise<void>;
};
declare const session: { prompt(text: string): Promise<unknown> };

const gov = govern({ audit: "audit.jsonl" }); // hash-chained JSONL receipt

const resetPassword = gov.tool({
  name: "reset_password",
  description: "Send a password reset link.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  // The check the Meta incident was missing: caller must own the account.
  // (args are inferred from `parameters` — no annotation needed)
  authorize: (a, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
  // A retry replays the first result instead of sending a second link.
  idempotency: { key: (a) => `reset:${a.accountId}` },
  execute: async (a) => {
    await accounts.sendResetLink(a.accountId);
    return "Sent.";
  },
});

const agent = defineAgent(() => ({
  model: "anthropic/claude-haiku-4-5",
  tools: [resetPassword] as ToolDefinition[],
}));

// At your request boundary: bind who is calling, from your own auth.
// The model can never read or set this.
await gov.run(
  { actor: { id: "user-7", roles: ["account_holder"] }, tenantId: "acme" },
  () => session.prompt("I'm locked out, reset my password"),
);
```

That is the whole API for most uses: `govern`, `gov.tool`, `gov.run`. The tool refuses to define without an authorization gate, checks
ownership before the side effect, won't fire twice on a retry, and writes a
tamper-evident line for every call, denials included.

The one idea underneath: the model controls the arguments, your application
controls the context. `authorize` and `scope` compare the untrusted arguments
against the trusted context, which travels through `AsyncLocalStorage` where
the model can never touch it.

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
  multi-instance deployments use the store-backed adapters in
  `flue-guard/d1` (Cloudflare D1, or any D1-shaped SQLite binding).

## Entry points

| Import | What's there |
| --- | --- |
| `flue-guard` | `govern`, `createGovernedToolkit`, `caller`, `trusted`, core types, the error taxonomy, adapter **interfaces** |
| `flue-guard/audit` | `hashEntry`, `verifyChain`, `HashChainAuditLog`, `InMemoryAuditLog` |
| `flue-guard/adapters` | default RBAC / redaction / idempotency, scope helpers, `toFlueTool` |
| `flue-guard/d1` | `D1AuditLog`, `D1IdempotencyStore` — multi-instance store-backed adapters (Cloudflare D1) |
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
