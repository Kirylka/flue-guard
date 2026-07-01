# flue-guard

In-process governance for [Flue](https://github.com/withastro/flue) tools: stop
an agent from taking an action it isn't allowed to — on the wrong account, or
twice — and keep a tamper-evident receipt of every one it does.

**ESM-only · Node 20+ · `@flue/runtime` peer dependency.**

## Install

```bash
npm i flue-guard @flue/runtime valibot
```

## Quickstart

```ts
import { createAgent } from "@flue/runtime";
import * as v from "valibot";
import { govern, caller } from "flue-guard";

const gov = govern({ audit: "audit.jsonl" }); // hash-chained JSONL; Flue wired in

const resetPassword = gov.tool({
  name: "reset_password",
  description: "Send a password reset link.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  authorize: caller((a, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id)), // the check Meta missed
  idempotency: { key: (a) => a.accountId },                                   // a retry won't send twice
  execute: async (a) => { await accounts.sendResetLink(a.accountId); return "Sent."; },
});

const agent = createAgent(() => ({ model, tools: [resetPassword] }));

// Bind the caller from YOUR auth (never the model), once per conversation:
await gov.run(
  { actor: { id: "user-7", roles: ["account_holder"] }, tenantId: "app" },
  () => harness.prompt("I'm locked out, reset my password"),
);
```

That's the product — **`govern`, `caller`, `gov.tool`, `gov.run`.** The tool
won't even *define* without an authorization gate; it checks the caller actually
owns the account before the side effect, won't fire twice on a retry, and writes
a tamper-evident line for every call.

> **The one idea:** the model controls the arguments; your application controls
> the context. `authorize`/`scope` compare the untrusted args against the trusted
> context — which travels separately, through `AsyncLocalStorage`, and the model
> can never read or set.

## How it works

Every call runs a fixed pipeline; any step can stop it, and every decision is
hash-chained into the audit log:

```
context → validate → RBAC → scope → authorize → approval → idempotency → execute → audit
```

Prefer the explicit, runtime-agnostic core over the `govern` convenience?
`createGovernedToolkit({ audit, defineTool })` is the same toolkit with Flue's
`defineTool` injected by you instead of for you.

## Documentation

- [Why this exists](./docs/motivation.md) — the Meta incident, and where this sits next to Flue
- [Architecture](./docs/architecture.md) — how identity, governance, and the substrate stack up
- [Guide](./docs/guide.md) — `authorize` vs `scope`, scoped tools vs primitives, context binding, approval
- [Adapters & runtimes](./docs/adapters.md) — swapping defaults, edge / Workers, `nodejs_compat`
- [Examples & status](./docs/examples.md) — runnable example, live Flue spike, the audit viewer, test status

## Entry points

| Import | What's there |
| --- | --- |
| `flue-guard` | `govern`, `createGovernedToolkit`, `caller`, `trusted`, core types, the error taxonomy, adapter **interfaces** |
| `flue-guard/audit` | `hashEntry`, `verifyChain`, `HashChainAuditLog`, `InMemoryAuditLog` |
| `flue-guard/adapters` | default RBAC / redaction / idempotency, scope helpers, `toFlueTool` |
| `flue-guard/testing` | in-memory test doubles |

## License

[MIT](./LICENSE).
