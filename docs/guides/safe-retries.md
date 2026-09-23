# Make retries safe

Agents retry. The model changes its plan, the host delivers a message again,
an approval resumes and calls the tool a second time. None of that may refund a
customer twice. Give the tool an `idempotency` key, and your code runs **at most
once per operation**. Every repeat gets the first result back instead.

Both examples below use this toolkit:

```ts setup
import * as v from "valibot";
import { govern } from "flue-guard";

const gov = govern({ audit: "audit.jsonl" });
```

## Declare a key

```ts
declare const billing: {
  refund(customerId: string, amount: number): Promise<{ refundId: string; ok: boolean }>;
};

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

The first call with `refund:order-812` runs and stores its result. A later
call with the same key, for the same tenant and tool and within the TTL, gets
that stored result. `execute` does not run again. The log shows the repeat as
`allow/replayed`.

## Design the key

- Build the key from the operation, not the attempt. With
  `refund:${a.orderId}`, every retry of "refund order 812" is the same
  operation. A timestamp or a random id in the key breaks this completely.
- Keys are written to the log unmasked, because that is how you find the
  retries of one call. Build them from stable ids, never from secrets or
  personal data.
- An empty key is an error, not "no idempotency". A key function that returns
  `""` throws `GovernanceConfigError` when the tool is called.
- Keys are separated by tool and by tenant for you. The same key in two tools
  or two tenants never mixes up their results.

## What a retry actually gets

Three cases, all recorded in the log:

| Situation | Behavior | Audit outcome |
| --- | --- | --- |
| Key completed within TTL | Recorded result returned, `execute` skipped | `allow/replayed` |
| Key currently executing | Refused with `IdempotencyConflictError` | `deny/idempotency_conflict` |
| Handler threw last time | Key released, retry executes normally | `allow/error`, then a fresh attempt |

One case is deliberate. If your code **succeeds** but storing the result
fails, the key stays locked. A retry is then *refused* instead of quietly
running the side effect again. flue-guard always prefers a refusal to a
duplicate. If you need exactly-once even here, use a store with transactions,
or pass an idempotency key to the service you are calling as well.

## Replays and `toModelOutput`

A repeat passes the **stored full result** through your `toModelOutput`, so it
returns exactly what the first call returned to the model. A store that saves
to disk or a database keeps plain JSON, so `Date`s and class instances do not
survive. They should not be in tool results under Flue anyway; see
[Shape what the model sees](/guides/shape-model-output).

## The guarantee is the store's

The default `InMemoryIdempotencyStore` only works inside one process. That is
fine for one instance, tests, and local runs. Several instances need a store
that can claim a key atomically, such as Redis `SET NX`, Postgres, or a
Cloudflare Durable Object (see [Run on Cloudflare Workers](/guides/cloudflare-workers)):

```ts
import { type IdempotencyStore } from "flue-guard";

declare const redisStore: IdempotencyStore; // your implementation

const govWithRedis = govern({ audit: "audit.jsonl", idempotencyStore: redisStore });
```

The interface has four methods: `begin`, `complete`, `fail`, and `get`. See
the [Adapters reference](/reference/adapters#idempotencystore). If you write
your own, keep one rule: **a claim that is still running never expires**.
Expiring it would let a slow operation start a second time. Only `complete()`
or `fail()` releases it. If a process crashes in the middle, call `fail()`
when it restarts, or use a store with leases.
