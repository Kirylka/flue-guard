---
layout: home

hero:
  name: flue-guard
  text: Governance layer for Flue tools
  tagline: Per-call authorization, idempotency, and a tamper-evident audit trail for agent tools, in-process.
  actions:
    - theme: brand
      text: Tutorial (5 minutes)
      link: /tutorial
    - theme: alt
      text: Why it exists
      link: /explanation/why-flue-guard
    - theme: alt
      text: GitHub
      link: https://github.com/Kirylka/flue-guard

features:
  - icon: 🚫
    title: Fail-closed authorization
    details: A side-effecting tool won't even define without a gate. Every call checks the untrusted arguments against the trusted caller context before the handler runs.
  - icon: 🔁
    title: Safe retries
    details: Declare an idempotency key and an agent retry replays the first result instead of refunding, emailing, or resetting twice.
  - icon: 🧾
    title: Tamper-evident audit
    details: Every decision is hash-chained into an append-only log. Edit any past line and verifyChain() points at it; add an HMAC key and a full rewrite can't be forged either.
  - icon: 🧩
    title: Native to Flue
    details: gov.tool() returns a real Flue ToolDefinition. One flag on Cloudflare Workers; identical decisions and hashes on every Flue target.
---

## Thirty seconds

Flue's own guidance: *"a tool's parameters are model-selected inputs, not an
authorization boundary."* flue-guard is that boundary. The model controls the
arguments; your application controls the context. Every call is decided by
comparing the two, then written to a hash-chained receipt.

```ts
import * as v from "valibot";
import { govern } from "flue-guard";

declare const accounts: {
  ownedBy(accountId: string, actorId: string): Promise<boolean>;
  sendResetLink(accountId: string): Promise<void>;
};

const gov = govern({ audit: "audit.jsonl" }); // hash-chained JSONL receipt

export const resetPassword = gov.tool({
  name: "reset_password",
  description: "Send a password reset link.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  // The check that was missing in the Meta incident (args inferred):
  authorize: (a, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
  idempotency: { key: (a) => `reset:${a.accountId}` }, // a retry won't send twice
  execute: async (a) => {
    await accounts.sendResetLink(a.accountId);
    return "Sent.";
  },
});
```

Bind the caller once per run, from your auth. The model can never read or
set it:

```ts
import { govern, type GovernedToolkit } from "flue-guard";

declare const gov: GovernedToolkit;
declare const session: { prompt(text: string): Promise<unknown> };

await gov.run(
  { actor: { id: "user-7", roles: ["account_holder"] }, tenantId: "acme" },
  () => session.prompt("I'm locked out, reset my password"),
);
```

Start with the [tutorial](/tutorial): from `npm i` to a denied call and a
verified audit line in under five minutes.
