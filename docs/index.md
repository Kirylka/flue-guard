---
layout: home

hero:
  name: flue-guard
  text: Checks for Flue agent tools
  tagline: Decide who may call a tool before it runs, never run a side effect twice, and keep a log you can verify.
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
    title: Refuses by default
    details: A tool that changes data will not even load without a check. Every call compares the model's arguments with the real caller before your code runs.
  - icon: 🔁
    title: Safe retries
    details: Give a tool an idempotency key, and a retried call returns the first result instead of refunding, emailing, or resetting a second time.
  - icon: 🧾
    title: A log you can verify
    details: Every decision is written to a log where each line holds the hash of the one before. Edit any past line and verifyChain() names it. With an HMAC key, rewriting the whole file fails too.
  - icon: 🧩
    title: Built for Flue
    details: gov.tool() returns a real Flue ToolDefinition. The same decisions and the same hashes on every runtime Flue supports.
---

## In thirty seconds

Flue's own guidance says *"a tool's parameters are model-selected inputs, not
an authorization boundary."* The model writes the arguments. Your application
knows who the caller is. flue-guard compares the two on every call, and writes
the result to a log.

```ts
import * as v from "valibot";
import { govern, caller } from "flue-guard";

declare const accounts: {
  ownedBy(accountId: string, actorId: string): Promise<boolean>;
  sendResetLink(accountId: string): Promise<void>;
};

const gov = govern({ audit: "audit.jsonl" });

export const resetPassword = gov.tool({
  name: "reset_password",
  description: "Send a password reset link.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  // Only the owner of the account may reset it.
  authorize: caller(
    (a: { accountId: string }, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id),
  ),
  // A retry of the same reset returns the first result instead of sending again.
  idempotency: { key: (a) => `reset:${a.accountId}` },
  execute: async (a) => {
    await accounts.sendResetLink(a.accountId);
    return "Sent.";
  },
});
```

Start with the [tutorial](/tutorial). In five minutes you get a refused call
and a log you verify yourself.
