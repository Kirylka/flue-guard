# Verify & protect the audit log

Every governed call appends one entry (two for side effects: intent +
outcome) to an `AuditLog`. Each entry stores the SHA-256 hash of the previous
entry, so the log is a chain: altering or deleting any historical line breaks
every hash after it. This guide covers proving that, strengthening it with an
HMAC key, and the operational limits.

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

`brokenAt` is the sequence number of the first inconsistent entry: the exact
line someone edited, reordered, or deleted after. (The
[tutorial](/tutorial#_5-try-to-tamper-with-it) walks through breaking one on
purpose; [`examples/audit-viewer.html`](https://github.com/Kirylka/flue-guard/blob/main/examples/audit-viewer.html)
does the same in a browser, no build required.)

## Add an HMAC key

A plain hash chain proves *continuity*: no line was changed after being
written. It cannot stop an attacker with file access from rewriting the whole
file and recomputing every hash. Key the chain and it can:

```ts
import { HashChainAuditLog } from "flue-guard/audit";

const audit = new HashChainAuditLog({
  path: "audit.jsonl",
  hmacKey: process.env.AUDIT_HMAC_KEY, // HMAC-SHA256 instead of plain SHA-256
});

// Verify with the same key the log was written with:
console.log(await audit.verify());
```

Without the key, a forged chain can't produce valid MACs. Keep the key out of
the environment the agent's tools run in (a verifier-side secret is ideal).
An **empty** `hmacKey` is rejected with `GovernanceConfigError`, because an
empty string is almost always an unset environment variable, and treating it as "no
key" would silently downgrade the guarantee.

## Know what is (and isn't) redacted

Redaction runs on what gets *written to the log*, never on what the handler
executes with. The default redactor masks common sensitive field names
(`password`, `token`, `cardNumber`, …) plus emails and long digit runs inside
strings. Swap or extend it globally, or per tool:

```ts
import * as v from "valibot";
import { govern } from "flue-guard";
import { textRedactor } from "flue-guard/adapters";

declare const redactString: (s: string) => string; // e.g. from a PII library

const gov = govern({
  audit: "audit.jsonl",
  redaction: textRedactor(redactString), // global: walks objects, masks fields + strings
});

export const lookupCustomer = gov.tool({
  name: "lookup_customer",
  description: "Fetch a customer profile.",
  parameters: v.object({ customerId: v.string() }),
  redact: (value) => "[custom per-tool redaction]", // per-tool override
  execute: async (a) => ({ id: a.customerId }),
});
```

Deliberately **not** redacted, because they are the log's correlation index:
**idempotency keys** and **requested scopes**. Build both from stable ids,
never secrets or PII. Error strings *are* run through the redactor, since an
exception message can carry a secret the handler touched.

## Operational limits

- The file sink is single-writer. `HashChainAuditLog` serializes appends
  within one instance; two processes (or two instances) writing the same file
  will assign duplicate sequence numbers and break the chain. Multi-instance
  deployments need a sink with an atomic append: a database, or the D1
  reference adapter ([Cloudflare guide](/guides/cloudflare-workers)).
- If the audit sink fails, the call fails. For side effects the intent
  record is written *before* the handler, and a failed append aborts the
  call, so a side effect can never run unrecorded.
- Audit values are normalized to JSON-safe form before hashing:
  `bigint` becomes a decimal string, circular structures become `[Circular]`,
  and non-finite numbers become `null`, so a hostile or odd tool result
  can't break the receipt.

## Related

- [Audit log reference](/reference/audit-log): `AuditEntry` fields,
  `hashEntry`, custom `AuditLog` sinks.
- [The trust model](/explanation/trust-model): precisely what the chain
  proves, and against which attacker.
