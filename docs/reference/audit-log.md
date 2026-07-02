# Audit log

Everything on the `flue-guard/audit` subpath: the entry shape, the hashing
functions, and the two built-in hash-chained logs.

## `AuditEntry`

One immutable record per governed decision (two for an executed side effect:
intent, then outcome).

```ts
import type { Decision, Outcome } from "flue-guard";

interface AuditEntry {
  seq: number;              // 0-based position in the chain
  ts: string;               // ISO timestamp
  prevHash: string;         // hash of the previous entry (GENESIS_HASH for seq 0)
  actorId: string;
  tenantId: string;
  tool: string;
  kind?: "primitive";       // present only for broad, free-form-payload tools
  decision: Decision;       // "allow" | "deny" | "defer"
  outcome: Outcome;         // "executing" | "success" | "error" | "denied" | "replayed" | "pending"
  requestedScopes: string[]; // unredacted
  requestId?: string;
  idempotencyKey?: string;  // unredacted
  approver?: string;
  args?: unknown;           // after redaction
  result?: unknown;         // after redaction; present on success/replay
  error?: string;           // governance code or redacted message; on denial/error
  hash: string;             // SHA-256 (or HMAC-SHA256) of all fields above
}
```

`AuditEntryBody` is `AuditEntry` without `hash`. `AuditInput` (what the
pipeline hands to `append`) is `AuditEntryBody` without `seq`, `prevHash`,
and with `ts` optional.

Which `decision`/`outcome` pairs occur when:
[The pipeline](/explanation/pipeline#what-lands-in-the-log).

## `hashEntry`

```ts
import { hashEntry, type AuditEntryBody } from "flue-guard/audit";

declare const body: AuditEntryBody;

const hash: string = await hashEntry(body);            // SHA-256
const mac: string = await hashEntry(body, "chain-key"); // HMAC-SHA256
```

Canonicalizes the body (recursively key-sorted, JSON-safe: `bigint` becomes a
decimal string, circular structures become `[Circular]`, non-finite numbers
become `null`, depth capped) and hashes it with Web Crypto, so the same body
produces the same hash on Node, Workers, Deno, Bun, and Lambda. An empty
string `hmacKey` throws `GovernanceConfigError`.

## `verifyChain`

```ts
import { verifyChain, type AuditEntry } from "flue-guard/audit";

declare const entries: AuditEntry[];

const report = await verifyChain(entries);
// { valid: true }
// { valid: false, brokenAt: 3, reason: "content hash mismatch at seq 3" }
```

Checks, per entry: `seq` is its index, `prevHash` matches the previous hash,
and the content hash recomputes. Pass the same `hmacKey` the log was written
with, or verification fails.

## `GENESIS_HASH`

Sixty-four zeros; the `prevHash` of the first entry.

## `HashChainAuditLog`

```ts
import { HashChainAuditLog } from "flue-guard/audit";

const audit = new HashChainAuditLog({
  path: "audit.jsonl",
  hmacKey: process.env.AUDIT_HMAC_KEY, // optional
});
```

Append-only JSONL file, one entry per line. `entries()` re-reads the file;
`verify()` is `verifyChain` over it. Notes:

- Node only: `node:fs` is imported lazily on first use, so merely importing
  the package is safe on filesystem-less runtimes.
- Single-writer: appends are serialized within one instance, and the chain
  state is cached in memory. Two instances or processes on the same file will
  break the chain. Use a store-backed sink for multi-writer deployments.
- An existing file is read once, lazily, to seed `seq` and `prevHash`, so
  restarts continue the chain.

## `InMemoryAuditLog`

```ts
import { InMemoryAuditLog } from "flue-guard/audit"; // also on flue-guard/testing

const audit = new InMemoryAuditLog({ hmacKey: undefined });
```

The same chain semantics with no persistence. A legitimate runtime sink for
ephemeral runs, and the natural choice in tests. Also exposes `verify()`.

## Writing your own sink

Implement the two-method [`AuditLog`](/reference/adapters#auditlog)
interface. Requirements that keep `verifyChain` meaningful:

1. Assign `seq` densely from 0 and set each entry's `prevHash` to the
   previous entry's `hash` (`GENESIS_HASH` first).
2. Compute `hash` with `hashEntry` over the normalized body.
3. Make append atomic per chain: a database transaction, a Durable Object,
   or an equivalent single-writer point.

[`examples/cloudflare-adapters.ts`](https://github.com/Kirylka/flue-guard/blob/main/examples/cloudflare-adapters.ts)
contains a D1-backed reference implementation.
