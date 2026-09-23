# Shape what the model sees

Whatever a tool returns goes into the model's context and affects the rest of
the run. Two separate options control what leaves the tool. They answer
different questions:

| Option | Question | Affects |
| --- | --- | --- |
| `toModelOutput` | "What should the *model* see of this result?" | The value returned to Flue/the model. The audit log still records the full result. |
| `redact` | "What may be *written to the audit log*?" | The audit entry only. The handler and the model are untouched. |

The common mistake is to use one for the other's job. `toModelOutput` does
**not** keep a secret out of the log. `redact` does **not** keep it away from
the model.

Every example below uses this toolkit:

```ts setup
import * as v from "valibot";
import { govern } from "flue-guard";

const gov = govern({ audit: "audit.jsonl" });
```

## Trim the model's view with `toModelOutput`

Return the full data for your records, and give the model only what it needs.

```ts
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

The log records the **full** result, masked as usual. The model gets
`{ id, plan }`. When a retry returns a stored result, that stored result goes
through `toModelOutput` again, so the retry returns exactly what the first
call did. The stored copy is plain JSON, so `Date`s and class instances do not
survive it.

## Keep results JSON-plain

Flue converts what the model sees to JSON, and **rejects** `bigint`, `Date`,
class instances, and objects that refer to themselves. Return plain objects,
arrays, strings, numbers, booleans, and `null`. Convert at the end of your
handler:

```ts
declare const orders: {
  find(orderId: string): Promise<{ id: string; total: bigint; placedAt: Date }>;
};

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

The audit log is more forgiving than Flue. It converts those values itself, so
an entry is always written. The rejection above is about what Flue sends to
the model.

## Keep secrets out of the audit with `redact`

The default masking already covers common sensitive field names, emails, and
long runs of digits. When a tool handles something the defaults do not know about,
add fields for that tool:

```ts
import { composeRedactors, defaultRedactor, redactFields } from "flue-guard/adapters";

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

Two values are never masked, on purpose: **idempotency keys** and **requested
scopes**. Never build them from secrets
([why](/guides/protect-the-audit-log#know-what-is-and-isn-t-redacted)).

## Related

- [Tool spec reference](/reference/tool-spec): `toModelOutput` and `redact`
  field contracts.
- [Make retries safe](/guides/safe-retries): how replays interact with
  `toModelOutput`.
