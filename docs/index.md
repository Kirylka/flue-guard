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
  # Icons: Lucide (ISC license), inlined so they follow the theme color.
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--vp-c-brand-1)"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>'
    title: Refuses by default
    details: A tool that changes data will not load without a check. Every call is checked against the real caller.
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--vp-c-brand-1)"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>'
    title: Safe retries
    details: Give a tool an idempotency key, and a retried call returns the first result. Nothing is refunded twice.
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--vp-c-brand-1)"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
    title: A log you can verify
    details: Each entry holds the hash of the one before. Edit a past line, and <code>verifyChain()</code> points to it.
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--vp-c-brand-1)"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>'
    title: Built for Flue
    details: <code>gov.tool()</code> returns a real Flue tool. Same decisions and hashes on every runtime Flue runs on.
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
