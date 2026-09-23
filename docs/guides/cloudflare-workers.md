# Run on Cloudflare Workers

flue-guard makes the same decisions and writes the same hashes on every
platform Flue runs on. It hashes with Web Crypto (`crypto.subtle`), which
exists everywhere. On Workers, or any edge runtime, three things change: you
turn on one flag, you cannot write to files, and you provide the stores.

## 1. Enable `nodejs_compat`

`gov.run(...)` passes the caller along with `AsyncLocalStorage`. Workers only
provides it behind a flag, which
[Flue's Cloudflare guide](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
already asks you to set:

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]
```

Node, Deno, Bun, Lambda, and Vercel's edge runtime have `AsyncLocalStorage`
built in; no flag needed there.

## 2. Pass stores, not file paths

`govern({ audit: "audit.jsonl" })` only works on Node. Importing flue-guard is
safe anywhere, because the file code loads only when used. But *passing a file
path* fails where there is no file system. Give the toolkit an `AuditLog` and
an `IdempotencyStore` instead. Nothing else changes:

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

- `D1AuditLog`, an audit log stored in D1. D1 can append atomically across
  isolates, which the chain needs and a shared file cannot do.
- `KvIdempotencyStore`, an idempotency store in KV. KV can return stale data
  for a short time. If two calls with the same key can arrive at once and must
  never both run, keep the claim in a Durable Object instead. It handles one
  request per key at a time.

## 3. Bind context per invocation when Flue dispatches

On Workers, agents usually run through `dispatch()`. Flue runs the turn
separately from your request. A `gov.run(...)` around `dispatch()` does not
carry over to it, even if you wait for the reply, so the tool sees no caller. Bind the caller
inside the agent function instead, from the signal's attributes, which you get
from `useDelivery()`:

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

Your server must check who sent the request before it sets `actorId` and
`tenantId`, and check that they may write to that conversation. Never copy
these attributes from request JSON. Bind the toolkit again on every call of
the agent function, so the tools use the caller of the current message.

When you call a tool yourself and wait for it inside your own callback,
`gov.run(...)` works too. `init().dispatch()` behaves like `dispatch()` and
needs `withContext` as well.

There is no separate build for the edge, on purpose. One import that works
with `nodejs_compat` is less to learn, and Flue needs that flag anyway.

## Related

- [Adapters reference](/reference/adapters): the `AuditLog` and
  `IdempotencyStore` interfaces your D1/KV/DO implementations fulfill.
- [Make retries safe](/guides/safe-retries): why the idempotency claim's
  atomicity decides the strength of the guarantee.
