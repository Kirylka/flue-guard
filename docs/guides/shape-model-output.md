# Shape what the model sees

A tool's return value lands in the model's context window and steers the rest
of the run. Two separate seams control what leaves the tool, and they answer
different questions:

| Seam | Question | Affects |
| --- | --- | --- |
| `toModelOutput` | "What should the *model* see of this result?" | The value returned to Flue/the model. The audit log still records the full result. |
| `redact` | "What may be *written to the audit log*?" | The audit entry only. The handler and the model are untouched. |

Using one for the other's job is the classic mistake: `toModelOutput` does
**not** keep a secret out of the audit trail, and `redact` does **not** keep
tokens out of the model's context.

## Trim the model's view with `toModelOutput`

Context hygiene: return rich data for your records, hand the model only what
it needs.

```ts
import * as v from "valibot";
import { govern } from "flue-guard";

const gov = govern({ audit: "audit.jsonl" });

export const lookupCustomer = gov.tool({
  name: "lookup_customer",
  description: "Fetch a customer profile.",
  parameters: v.object({ customerId: v.string() }),
  execute: async (a) => ({
    id: a.customerId,
    plan: "pro",
    internalNotes: "vip, exec escalation 2026-03", // for the audit, not the model
    usageHistory: new Array(500).fill("…"),          // too big for context
  }),
  // The model receives only this:
  toModelOutput: (r) => ({ id: r.id, plan: r.plan }),
});
```

The audit entry records the **full** result (after redaction); the model gets
`{ id, plan }`. On an idempotent replay, the *stored* full result is routed
through `toModelOutput` again, so a replayed call returns exactly what the
original did. Note the stored value is JSON-normalized, so don't rely on
`Date`s or class instances surviving the store.

## Keep results JSON-plain

Flue serializes what the model sees (the handler's return, or
`toModelOutput`'s) and **rejects** `bigint`, `Date`, class instances, and
circular structures (`@flue/runtime` beta.3+ behavior). Return plain objects,
arrays, strings, finite numbers, booleans, and `null`. Convert at the edge of
your handler:

```ts
import * as v from "valibot";
import { govern } from "flue-guard";

declare const orders: {
  find(orderId: string): Promise<{ id: string; total: bigint; placedAt: Date }>;
};

const gov = govern({ audit: "audit.jsonl" });

export const lookupOrder = gov.tool({
  name: "lookup_order",
  description: "Look up an order.",
  parameters: v.object({ orderId: v.string() }),
  execute: async (a) => {
    const order = await orders.find(a.orderId);
    return {
      id: order.id,
      total: order.total.toString(),      // bigint -> string
      placedAt: order.placedAt.toISOString(), // Date -> string
    };
  },
});
```

(The audit log is more forgiving than Flue: it normalizes `bigint`, circular
and deep values itself so the *receipt* never breaks. The rejection above is
about what Flue will serialize for the model.)

## Keep secrets out of the audit with `redact`

The default redactor already masks common sensitive field names and PII-like
strings. Override per tool when a tool handles something the defaults don't
know about:

```ts
import * as v from "valibot";
import { govern } from "flue-guard";
import { composeRedactors, defaultRedactor, redactFields } from "flue-guard/adapters";

const gov = govern({ audit: "audit.jsonl" });

export const rotateCredential = gov.tool({
  name: "rotate_credential",
  description: "Rotate a service credential.",
  parameters: v.object({ serviceId: v.string() }),
  sideEffect: true,
  scope: (a) => `service:${a.serviceId}`,
  // Defaults + mask this tool's extra sensitive fields in the audit entry.
  redact: composeRedactors(defaultRedactor, redactFields(["privateKey", "seedPhrase"])),
  execute: async (a) => ({ serviceId: a.serviceId, rotated: true }),
});
```

Remember the two on-purpose exceptions: **idempotency keys** and **requested
scopes** are recorded unredacted for correlation, so never build them from
secrets ([details](/guides/protect-the-audit-log#know-what-is-and-isnt-redacted)).

## Related

- [Tool spec reference](/reference/tool-spec): `toModelOutput` and `redact`
  field contracts.
- [Make retries safe](/guides/safe-retries): how replays interact with
  `toModelOutput`.
