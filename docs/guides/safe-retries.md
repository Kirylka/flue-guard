# Make retries safe

Agents retry. Models re-plan, harnesses re-deliver, approval resumes re-invoke
the tool. None of that may refund a customer twice. Declare an `idempotency`
policy and the handler runs **at most once per logical operation**; every
repeat replays the recorded result instead.

## Declare a key

```ts
import * as v from "valibot";
import { govern } from "flue-guard";

declare const billing: {
  refund(customerId: string, amount: number): Promise<{ refundId: string; ok: boolean }>;
};

const gov = govern({ audit: "audit.jsonl" });

export const issueRefund = gov.tool({
  name: "issue_refund",
  description: "Refund a customer order.",
  parameters: v.object({ orderId: v.string(), customerId: v.string(), amount: v.number() }),
  sideEffect: true,
  scope: (a) => `customer:${a.customerId}`,
  idempotency: {
    key: (a) => `refund:${a.orderId}`, // one logical operation = one key
    ttlMs: 24 * 60 * 60 * 1000,        // optional: replay window
  },
  execute: (a) => billing.refund(a.customerId, a.amount),
});
```

The first call with `refund:order-812` executes and records its result. Every
later call with the same key (same tenant, same tool, within the TTL) returns
that recorded result, audited as `allow/replayed`, without running
`execute`.

## Design the key

- Key the logical operation, not the attempt. `refund:${a.orderId}` makes
  every retry of "refund order 812" one operation. A timestamp or random id in
  the key defeats the whole mechanism.
- Keys are audited unredacted (they're how you correlate retries in the
  log). Build them from stable identifiers, never secrets or PII.
- Empty keys are rejected, not treated as "no idempotency": a key function
  returning `""` throws `GovernanceConfigError` at call time.
- Keys are namespaced per tool and per tenant automatically. The same key
  string in two tools, or two tenants, can't collide or cross-replay.

## What a retry actually gets

Three cases, all on the audit record:

| Situation | Behavior | Audit outcome |
| --- | --- | --- |
| Key completed within TTL | Recorded result returned, `execute` skipped | `allow/replayed` |
| Key currently executing | Refused with `IdempotencyConflictError` | `deny/idempotency_conflict` |
| Handler threw last time | Key released, retry executes normally | `allow/error`, then a fresh attempt |

One edge is deliberate: if the handler **succeeds** but recording the
completion fails, the key stays held, so a retry is *refused* rather than
silently duplicated. flue-guard never trades a refusal for a duplicate side
effect; true exactly-once across that window needs a transactional store or a
downstream idempotency token.

## Replays and `toModelOutput`

A replay routes the **stored full result** through your `toModelOutput`, so a
replayed call returns exactly what the original returned to the model. With a
serializing store the persisted value is JSON-normalized, so don't rely on
`Date`s or class instances surviving it (they shouldn't be in tool results
under Flue anyway; see
[Shape what the model sees](/guides/shape-model-output)).

## The guarantee is the store's

The default `InMemoryIdempotencyStore` holds within one process, which is
fine for a
single instance, tests, and local runs. Multiple instances need a store with
an atomic claim, such as Redis `SET NX`, Postgres, or Cloudflare KV/Durable
Objects (see [Run on Cloudflare Workers](/guides/cloudflare-workers)):

```ts
import { govern, type IdempotencyStore } from "flue-guard";

declare const redisStore: IdempotencyStore; // your implementation

const gov = govern({ audit: "audit.jsonl", idempotencyStore: redisStore });
```

The interface is four methods (`begin` / `complete` / `fail` / `get`); see
the [Adapters reference](/reference/adapters#idempotencystore). One behavior to
preserve when implementing it: an **in-flight claim never expires by TTL**.
Expiring it would let a slow operation start a second time; it is released
only by `complete()` or `fail()`. If a process crashes mid-flight, call
`fail()` on crash recovery or use a store with leases.
