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
import { govern } from "flue-guard";
import { D1AuditLog, D1IdempotencyStore, type D1Like } from "flue-guard/d1";

declare const env: { DB: D1Like }; // your D1 binding

const gov = govern({
  audit: new D1AuditLog({ db: env.DB }),
  idempotencyStore: new D1IdempotencyStore({ db: env.DB }),
});
```

Both ship on the `flue-guard/d1` subpath
([reference](/reference/adapters#cloudflare-d1-flue-guard-d1)): the audit log
gets the atomic append the chain needs across isolates (which a shared file
cannot — the file sink is single-writer), and the idempotency store gets an
atomic cross-instance claim. Add `auditTableSql()` / `idempotencyTableSql()`
to your D1 migrations, or call `ensureSchema()` on each adapter at startup.

Prefer KV for idempotency? A KV-backed reference store lives in
[`examples/cloudflare-adapters.ts`](https://github.com/Kirylka/flue-guard/blob/main/examples/cloudflare-adapters.ts)
— but KV is eventually consistent, so for **strict** at-most-once under
concurrent same-key calls use D1 (above) or a Durable Object.

## 3. Bind context per invocation when Flue dispatches

On Workers, agents typically run via Flue's dispatched/addressable path: the
turn is processed detached from your request, so an `AsyncLocalStorage` scope
around `dispatch()` can't reach the tool. Bind the context inside
`defineAgent`, where Flue hands you the agent instance `id` and `env` your
authenticated route selected:

```ts
import { defineAgent, defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { createGovernedToolkit, type AuditLog, type TrustedContext } from "flue-guard";
import { toFlueTool } from "flue-guard/adapters";

declare const d1Audit: AuditLog;
declare const actorForAgent: (agentId: string) => { userId: string; roles: string[]; orgId: string };

// No ambient context on the dispatched path; fail closed if anything tries.
const base = createGovernedToolkit({
  context: () => {
    throw new Error("dispatched tools must be bound with withContext");
  },
  audit: d1Audit,
});

export default defineAgent(({ id }) => {
  // Your route authenticated the caller and chose this agent id.
  const actor = actorForAgent(id);
  const trustedCtx: TrustedContext = {
    actor: { id: actor.userId, roles: actor.roles },
    tenantId: actor.orgId,
    scopes: [`account:${actor.userId}`],
  };

  // Same audit log and idempotency store; per-invocation identity.
  const bound = base.withContext(trustedCtx);

  const resetPassword = defineTool(
    toFlueTool(
      bound.defineGovernedTool<{ accountId: string }>({
        name: "reset_password",
        description: "Send a password reset link.",
        parameters: v.object({ accountId: v.string() }),
        sideEffect: true,
        scope: (a) => `account:${a.accountId}`,
        execute: async (a) => `reset link sent for ${a.accountId}`,
      }),
    ) as ToolDefinition,
  );

  return { model: "anthropic/claude-haiku-4-5", tools: [resetPassword] };
});
```

When your own code drives the prompt and awaits it (workflows, direct
session calls), plain `gov.run(...)` works on Workers too: under
`nodejs_compat` the context flows through your awaited call exactly as on
Node.

There is deliberately no separate "edge build": one import that works under
`nodejs_compat` is less to learn, and Flue itself already requires the flag.

## Related

- [Adapters reference](/reference/adapters): the `AuditLog` and
  `IdempotencyStore` interfaces your D1/KV/DO implementations fulfill.
- [Make retries safe](/guides/safe-retries): why the idempotency claim's
  atomicity decides the strength of the guarantee.
