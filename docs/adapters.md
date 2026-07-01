# Adapters, defaults & runtimes

← [Back to the README](../README.md)

## When the defaults aren't enough

Every moving part is an interface with a working in-process default. Swap any of
them without touching a tool. The interfaces live on the package root; the
default implementations live on `flue-guard/adapters`.

| Piece | Default | What you'd swap in |
| --- | --- | --- |
| Idempotency | `InMemoryIdempotencyStore` | Redis or Postgres with an atomic claim |
| Audit | `HashChainAuditLog` (JSONL file) | a database, WORM, or object-store sink |
| Approval | none (calls that need it are refused) | Slack, a ticket queue, Flue session state |
| RBAC | any-of role match | OPA or your own permissions service |
| Redaction | regex defaults | OpenRedaction or `@redactpii/node` via `textRedactor` |

Two switches worth knowing:

```ts
import { HashChainAuditLog } from "flue-guard/audit";
import { textRedactor } from "flue-guard/adapters";
import { redactString } from "@redactpii/node";

// Keyed audit: a full-file rewrite can't forge a valid chain without the key.
new HashChainAuditLog({ path: "audit.jsonl", hmacKey: process.env.AUDIT_KEY });

// Heavier PII redaction without taking on the dependency here:
govern({ redaction: textRedactor((s) => redactString(s)), /* … */ });
```

## Runs wherever Flue runs

No per-runtime matrix to learn. The governance *decisions* and the audit hash
are identical on Node, Cloudflare Workers, Deno, Bun, Lambda, and edge — hashing
is Web Crypto (`crypto.subtle`, the one path everywhere), and context
propagation is a *pattern* choice (`gov.run` where your code drives the prompt,
`gov.withContext` where Flue dispatches it), not a deployment-target choice.

What's runtime-specific is kept out of the import path. The only built-in that
touches `node:fs` is the file audit sink (`HashChainAuditLog` with a path), and
it loads `node:fs` **lazily**, the first time you write — so importing the
package on a filesystem-less runtime doesn't pull Node built-ins in. On such a
runtime you don't take the file default; you hand the toolkit a store, and
nothing else changes:

```ts
createGovernedToolkit({ audit: myAuditLog, idempotencyStore: myStore, defineTool });
```

[`examples/cloudflare-adapters.ts`](../examples/cloudflare-adapters.ts) has
copy-pasteable reference stores for Workers — a **D1**-backed `AuditLog` and a
**KV**-backed `IdempotencyStore` (use a **Durable Object** for strict
at-most-once under concurrency). On a runtime without a filesystem you simply
pass a store instead of a path; nothing else changes.

**One flag on Cloudflare Workers.** `ContextStore` (the backing for `gov.run`)
uses `AsyncLocalStorage`, so on Workers enable the Node compatibility flag in
`wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
```

That's the same flag Flue itself relies on, so if Flue runs, this does too.
`AsyncLocalStorage` is built in on Node, Deno, Bun, Lambda, and Vercel's edge
runtime — Workers is the one that gates it behind a flag. If you'd rather not use
`AsyncLocalStorage` at all, take the dispatched path: `gov.withContext(...)`
binds the context per invocation with no ambient store (see
[binding context](./guide.md#binding-context-two-patterns)). We're deliberately
not shipping a separate edge build until there's real demand for one — a single
import that works under `nodejs_compat` is less for you to learn.
