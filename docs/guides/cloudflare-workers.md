# Run on Cloudflare Workers

flue-guard makes the same decisions and produces the same audit hashes on
every target Flue deploys to, because hashing is Web Crypto
(`crypto.subtle`), the one API that exists everywhere. Running on Workers (or any edge runtime)
changes exactly three things: one compatibility flag, no file-backed sinks,
and durable stores you provide.

## 1. Enable `nodejs_compat`

`gov.run(...)` propagates the trusted context with `AsyncLocalStorage`.
Workers gates that behind a flag ([Flue's Cloudflare guide](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
already requires it):

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]
```

Node, Deno, Bun, Lambda, and Vercel's edge runtime have `AsyncLocalStorage`
built in; no flag needed there.

## 2. Pass stores, not file paths

`govern({ audit: "audit.jsonl" })` is a Node convenience. The file sink loads
`node:fs` lazily, so merely importing flue-guard is safe on a
filesystem-less runtime, but *using* a path there isn't. Hand the toolkit an
`AuditLog` and an `IdempotencyStore` instead; nothing else changes:

```ts
import { govern, type AuditLog, type IdempotencyStore } from "flue-guard";

declare const d1Audit: AuditLog;            // D1-backed (reference impl below)
declare const kvIdempotency: IdempotencyStore; // KV-backed (reference impl below)

const gov = govern({
  audit: d1Audit,
  idempotencyStore: kvIdempotency,
});
```

[`examples/cloudflare-adapters.ts`](https://github.com/Kirylka/flue-guard/blob/main/examples/cloudflare-adapters.ts)
contains copy-pasteable reference implementations:

- `D1AuditLog`, a D1-backed hash-chained `AuditLog`. D1 gives you the
  atomic append the chain needs across isolates, which a shared file cannot
  (the file sink is single-writer).
- `KvIdempotencyStore`, a KV-backed `IdempotencyStore`. KV is eventually
  consistent, so for **strict** at-most-once under concurrent same-key calls,
  put the claim in a Durable Object (single-threaded per key) instead.

## 3. Bind context per invocation when Flue dispatches

On Workers, agents typically run via Flue's dispatched/addressable path: the
turn is processed detached from your request, so an `AsyncLocalStorage` scope
around `dispatch()` cannot reach the tool. Bind context inside the agent
function using authenticated signal attributes from `useDelivery()`:

```ts
'use agent';
import { useDelivery, useModel, useTool } from "@flue/runtime";
import * as v from "valibot";
import { govern, type AuditLog } from "flue-guard";

declare const d1Audit: AuditLog;
const base = govern({ audit: d1Audit });

export function SupportAgent() {
  useModel("anthropic/claude-haiku-4-5");
  const delivery = useDelivery();
  const attrs = delivery.kind === "signal" ? delivery.attributes : undefined;
  if (!attrs?.actorId || !attrs.tenantId) throw new Error("Missing authenticated caller");
  const bound = base.withContext({
    actor: { id: attrs.actorId, roles: ["account_holder"] },
    tenantId: attrs.tenantId,
    scopes: [`account:${attrs.actorId}`],
  });
  useTool(bound.tool({
    name: "reset_password",
    description: "Send a password reset link.",
    parameters: v.object({ accountId: v.string() }),
    sideEffect: true,
    scope: (a) => `account:${a.accountId}`,
    execute: async (a) => `reset link sent for ${a.accountId}`,
  }));
  return "Help the caller access their own account.";
}
```

Your server must authenticate the sender before setting `actorId` and
`tenantId`, and authorize access to the destination conversation. Do not
copy those attributes from untrusted request JSON. Bind the toolkit afresh
on each render, so tool closures use the current delivery's identity.

For direct execution inside your own awaited callback, `gov.run(...)` also
works under `nodejs_compat`. Flue's `init().dispatch()` uses the same detached
submission mechanism as top-level `dispatch()` and needs `withContext` too.

There is deliberately no separate "edge build": one import that works under
`nodejs_compat` is less to learn, and Flue itself already requires the flag.

## Related

- [Adapters reference](/reference/adapters): the `AuditLog` and
  `IdempotencyStore` interfaces your D1/KV/DO implementations fulfill.
- [Make retries safe](/guides/safe-retries): why the idempotency claim's
  atomicity decides the strength of the guarantee.
