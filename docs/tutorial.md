# Tutorial: your first governed tool

Over the next five minutes you'll build a small Flue tool that sends password
reset links. You'll watch flue-guard refuse a reset for someone else's
account. Then you'll open the log, try to rewrite history, and watch it get
caught.

All you need is Node.js **22.19 or newer** (check with `node --version`). It
runs TypeScript files directly, so there's no build step.

## 1. Set up a project

```bash
mkdir guarded-tool && cd guarded-tool
npm init -y
npm pkg set type=module
npm i flue-guard @flue/runtime valibot
```

## 2. Write the tool

Create `first-tool.ts`:

```ts
// first-tool.ts
import * as v from "valibot";
import { govern, isGovernanceDenial } from "flue-guard";
import { HashChainAuditLog } from "flue-guard/audit";

// A stand-in account store. This mapping is the server-side truth;
// the model can never argue with it.
const owners = new Map([
  ["acct-alice", "alice"],
  ["acct-bob", "bob"],
]);

const audit = new HashChainAuditLog({ path: "audit.jsonl" });
const gov = govern({ audit });

const resetPassword = gov.tool({
  name: "reset_password",
  description: "Send a password reset link for an account.",
  parameters: v.object({ accountId: v.string() }),
  sideEffect: true,
  // The authorization gate: the caller must own the account they name.
  authorize: (a, ctx) => owners.get(a.accountId) === ctx.actor.id,
  execute: async (a) => {
    console.log(`  [side effect] reset link sent for ${a.accountId}`);
    return `Sent a reset link for ${a.accountId}.`;
  },
});

// Bind who is calling. It comes from your auth, never from the model.
await gov.run(
  { actor: { id: "alice", roles: ["account_holder"] }, tenantId: "demo" },
  async () => {
    // Alice resets her own account: allowed.
    console.log((await resetPassword.run({ data: { accountId: "acct-alice" } })).output);

    // "Alice" asks for Bob's account: refused before the side effect runs.
    try {
      await resetPassword.run({ data: { accountId: "acct-bob" } });
    } catch (err) {
      if (!isGovernanceDenial(err)) throw err;
      console.log(`DENIED: ${err.message}`);
    }
  },
);

console.log("audit chain:", await audit.verify());
```

`gov.tool(...)` gives you back an ordinary Flue `ToolDefinition`. Here the
script calls its `run({ data })` itself, which is exactly what Flue does when
the model picks the tool. In a real agent, the model is the one choosing
`accountId`, and that's the whole reason the ownership check is there.

## 3. Run it

```bash
node first-tool.ts
```

You should see:

```
  [side effect] reset link sent for acct-alice
Sent a reset link for acct-alice.
DENIED: "reset_password" was not authorized for this caller/target.
audit chain: { valid: true }
```

Alice's own reset went through. The one for Bob's account was refused
*before* `execute` ran, so no link was ever sent. That's the bug from the
[Instagram incident](/explanation/why-flue-guard), stopped in one line.

## 4. Read the log

Every call was written to `audit.jsonl`. Create `verify-audit.ts`:

```ts
// verify-audit.ts
import { HashChainAuditLog } from "flue-guard/audit";

const audit = new HashChainAuditLog({ path: "audit.jsonl" });
for (const e of await audit.entries()) {
  console.log(`#${e.seq} ${e.tool} ${e.decision}/${e.outcome} actor=${e.actorId}`);
}
console.log(await audit.verify());
```

```bash
node verify-audit.ts
```

```
#0 reset_password allow/executing actor=alice
#1 reset_password allow/success actor=alice
#2 reset_password deny/denied actor=alice
{ valid: true }
```

Three entries, not two. A tool that changes something writes an `executing`
entry *before* it runs and the result after, so nothing can happen without
leaving a trace. And the refused call is in there too: saying no counts as a
decision worth keeping.

## 5. Try to tamper with it

Each entry stores a hash of the previous one, so the log is a chain. Open
`audit.jsonl` in your editor, and on the **first** line change `acct-alice` to
`acct-bob`. Save, then verify again:

```bash
node verify-audit.ts
```

```
{ valid: false, brokenAt: 0, reason: 'content hash mismatch at seq 0' }
```

The line you edited no longer matches its own hash, and the check points
straight at it. That's all "tamper-evident" means, and you've just seen it
work.

## Where to go next

That's it: you have a tool that checks before it acts. Hand it to your agent
like any other Flue tool. In a real agent you'll pick up the caller with
`gov.withSignal(...)` instead of `gov.run(...)`; [Run on Cloudflare Workers](/guides/cloudflare-workers#_3-bind-context-per-invocation-when-flue-dispatches)
shows how and explains why.

- [Choose authorize vs scope](/guides/authorize-vs-scope): which gate fits
  which tool, and how to combine them.
- [Make retries safe](/guides/safe-retries): idempotency keys, so an agent
  retry can't send the reset link twice.
- [Verify & protect the audit log](/guides/protect-the-audit-log): HMAC keys,
  and what the chain does and doesn't prove.
- [The trust model](/explanation/trust-model): what is guaranteed, and what
  is deliberately not.
