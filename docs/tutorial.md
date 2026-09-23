# Tutorial: your first governed tool

In the next five minutes you will build a Flue tool that sends password reset
links. You will watch flue-guard refuse a call for an account the caller does
not own. Then you will check the log and see that it cannot be edited unnoticed.

You need Node.js **22.19 or newer** (`node --version`), which runs TypeScript
files directly.

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
import { govern, caller, isGovernanceDenial } from "flue-guard";
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
  authorize: caller(
    (a: { accountId: string }, ctx) => owners.get(a.accountId) === ctx.actor.id,
  ),
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

`gov.tool(...)` returns a normal Flue `ToolDefinition`. The script calls its
`run({ data })` directly. That is the same method Flue calls when the model
picks the tool.
In a real agent the model chooses `accountId`. That is exactly why the
ownership check exists.

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

The first call executed. The second was refused *before* `execute` ran: no
reset link for Bob's account was ever sent.

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

Three entries. A tool that changes something writes an `executing` entry
*before* it runs and a result entry after, so a side effect can never happen
without a record. The refused call is recorded too.

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

The edited line no longer matches its own hash, and verification names that
exact line. That is what "tamper-evident" means here, and you just saw it
happen.

## Where to go next

You have a governed tool. Give it to your agent like any other Flue tool. In
a real agent you bind the caller with `gov.withContext(...)` instead of
`gov.run(...)`; [Run on Cloudflare Workers](/guides/cloudflare-workers#_3-bind-context-per-invocation-when-flue-dispatches)
shows how and explains why.

- [Choose authorize vs scope](/guides/authorize-vs-scope): which gate fits
  which tool, and how to combine them.
- [Make retries safe](/guides/safe-retries): idempotency keys, so an agent
  retry can't send the reset link twice.
- [Verify & protect the audit log](/guides/protect-the-audit-log): HMAC keys,
  and what the chain does and doesn't prove.
- [The trust model](/explanation/trust-model): what is guaranteed, and what
  is deliberately not.
