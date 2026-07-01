# Examples & status

← [Back to the README](../README.md)

## See it run

There's a small support-agent example with a mock model, so it runs with no
setup and no API key:

```bash
npm run example
```

It's the same `reset_password` tool from the [guide](./guide.md) plus a refund
tool, and it walks through the whole story: defining an ungated side-effect tool
is refused; resetting your own account works but resetting someone else's is
blocked (the Meta case); a duplicate refund replays instead of paying twice; an
over-threshold refund waits for approval; a cross-customer refund is denied; and
the audit chain verifies clean at the end.

For a real Flue run — an actual dispatched agent turn driving the tool through
Flue's runtime, with a faux model instead of a paid one — there's a spike:

```bash
npm run spike
```

It dispatches two turns: the model resets the caller's own account (executes
once, audited), then is talked into resetting someone else's (denied live, the
side effect never runs, and the refusal surfaces to the model as a tool error).

And to *see* "tamper-evident" mean something, open
[`examples/audit-viewer.html`](../examples/audit-viewer.html) in any browser — no
build, no server. Load an `audit.jsonl` (or click **Load sample**), and it
re-verifies the hash chain locally with Web Crypto, the same algorithm the
library writes with. Hit **Tamper with a line** and watch verification point at
the exact `seq` that breaks — the guarantee, demonstrated rather than asserted.

## Is this real yet

It's pre-release, and honest about it. The governance behavior is covered by
the full unit and end-to-end suite (`npm test`), including on-disk tamper
detection, the Web Crypto
edge path with D1/KV adapters, a regression suite pinning the fixes from several
rounds of security review (gate bypasses, concurrent-append chain corruption,
cross-tool idempotency collisions and delimiter ambiguity, empty idempotency/HMAC
keys, in-flight TTL expiry, duplicate side effects on a completion failure,
auditing of governance-step exceptions, and adversarial audit inputs —
bigint/circular/deeply-nested/changing-getter/prototype-polluting results that
must not break or escape the receipt), and tests that run a governed tool
through the actual `@flue/runtime` `defineTool` and valibot rather than a
stand-in. It has also been run end to end through a real Flue
dispatched agent turn (`npm run spike`) — proving the per-invocation binding and
enforcement work on Flue's detached execution path, and that a denied call comes
back to the model as a tool error. Flue's own API is still in beta (`@flue/runtime`
1.0.0-beta.9), so expect some churn there.

If you want the reasoning instead of just the code:

- [`BUSINESS_REQUIREMENTS.md`](./BUSINESS_REQUIREMENTS.md) — why it exists
- [`FUNCTIONAL_REQUIREMENTS.md`](./FUNCTIONAL_REQUIREMENTS.md) — what it has to do
- [`TECH_ARCHITECTURE.md`](./TECH_ARCHITECTURE.md) — how it's built
- [`TASK_SPECS.md`](./TASK_SPECS.md) — the work, broken down
