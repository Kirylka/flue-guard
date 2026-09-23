# Verify & protect the audit log

Every governed call adds one entry to the audit log. A tool that changes data
adds two: one before it runs and one after. Each entry stores the SHA-256 hash
of the entry before it, so the entries form a chain. Change or delete any past
line, and every hash after it stops matching. This guide shows how to check
that, how to make it stronger with an HMAC key, and where its limits are.

## Verify a chain

Both built-in logs have a `verify()` method; for entries from anywhere else,
`verifyChain` is the same check:

```ts
import { HashChainAuditLog, verifyChain } from "flue-guard/audit";

const audit = new HashChainAuditLog({ path: "audit.jsonl" });

console.log(await audit.verify());
// { valid: true }
// or: { valid: false, brokenAt: 2, reason: 'content hash mismatch at seq 2' }

// Equivalent, for entries you loaded yourself:
console.log(await verifyChain(await audit.entries()));
```

`brokenAt` is the number of the first entry that does not match: the line
someone edited, moved, or deleted something after. (The
[tutorial](/tutorial#_5-try-to-tamper-with-it) walks through breaking one on
purpose; [`examples/audit-viewer.html`](https://github.com/Kirylka/flue-guard/blob/main/examples/audit-viewer.html)
does the same in a browser, no build required.)

## Add an HMAC key

A plain hash chain proves that no single line was changed after it was
written. It cannot stop someone with access to the file from rewriting the
whole file and computing every hash again. An HMAC key stops that:

```ts
import { HashChainAuditLog } from "flue-guard/audit";

const audit = new HashChainAuditLog({
  path: "audit.jsonl",
  hmacKey: process.env.AUDIT_HMAC_KEY, // HMAC-SHA256 instead of plain SHA-256
});

// Verify with the same key the log was written with:
console.log(await audit.verify());
```

Without the key, nobody can produce a chain that passes verification. Keep the
key away from the machine where the agent's tools run. Ideally only the side
that verifies the log has it.

An **empty** `hmacKey` is rejected with `GovernanceConfigError`. An empty
string is almost always an environment variable that was never set, and
treating it as "no key" would quietly make the log weaker.

## Know what is (and isn't) redacted

Masking applies only to what is *written to the log*. Your handler always gets
the real values. By default, fields with sensitive names (`password`, `token`,
`cardNumber`, …) are masked, and so are emails and long runs of digits inside
strings.

To use a stronger masking library for the whole log, wrap its string function:

```ts
import { govern } from "flue-guard";
import { textRedactor } from "flue-guard/adapters";

declare const maskPersonalData: (text: string) => string; // from your PII library

// Still masks sensitive field names, and runs every string through your function.
const gov = govern({ audit: "audit.jsonl", redaction: textRedactor(maskPersonalData) });
```

To add fields for a single tool, set `redact` on that tool. See
[Shape what the model sees](/guides/shape-model-output#keep-secrets-out-of-the-audit-with-redact).

Two things are **not** masked, because they are how you find related entries:
**idempotency keys** and **requested scopes**. Build both from stable ids,
never from secrets or personal data. Error messages *are* masked, because an
exception can carry a secret the handler touched.

## Operational limits

- Only one process may write a log file. `HashChainAuditLog` puts writes in
  order inside one process. Two processes writing the same file will reuse
  entry numbers and break the chain. With several instances, use a store that
  appends atomically: a database, or the D1 example in the
  [Cloudflare guide](/guides/cloudflare-workers).
- If writing to the log fails, the call fails. For a tool that changes data,
  the first entry is written *before* your code runs. If that write fails,
  your code does not run, so a change can never happen without a record.
- Odd values are converted before hashing: `bigint` becomes a string, a loop
  of references becomes `[Circular]`, and `NaN` or `Infinity` becomes `null`.
  A strange tool result cannot stop the entry from being written.

## Related

- [Audit log reference](/reference/audit-log): `AuditEntry` fields,
  `hashEntry`, custom `AuditLog` sinks.
- [The trust model](/explanation/trust-model): precisely what the chain
  proves, and against which attacker.
