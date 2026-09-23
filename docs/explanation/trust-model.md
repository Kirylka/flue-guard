# The trust model

This page says exactly what flue-guard guarantees and what it does not. Every
guarantee below has a test in the repository.

## The one idea

The model writes the arguments. Your application knows the caller.

Every `accountId`, `amount`, or `query` in a tool call comes from the model.
The conversation can talk the model into any value, so treat each one as a
claim, not a fact. The caller's identity, tenant, and scopes come from your
authenticated request. They travel separately, through `AsyncLocalStorage` or
an explicit `withContext`. Nothing the model outputs can read or change them.

Every check compares those two things, and the API keeps you from getting the
comparison backwards. With `scope`, you only say what the call touches, and
the library does the comparing. So you cannot write a scope check that forgets
the caller. With `authorize`, every check names what it compares against: the
caller, or a lookup you registered. So a check that looks only at the
arguments cannot be written at all.

## Guaranteed

- Checks run before your code, on every call. Your handler is only reachable
  through the checks; the host never gets a direct reference to it.
- A tool that changes data cannot be defined without a check, unless you write
  `unsafeAllowUnauthorized: true` in the source, where a reviewer will see it.
- A change never happens without a record. The first entry is written before
  your code runs, and if that write fails, your code does not run.
- Every decision is in the log: refusals, calls waiting for approval, repeats,
  and errors thrown by the checks themselves.
- Editing the history is detected. Changing any past entry makes verification
  fail at that entry. With an HMAC key, building a whole fake log also needs
  the key.
- An entry is always written. Odd values such as `bigint`, objects that refer
  to themselves, dangerous keys like `__proto__`, getters that throw, or deep
  nesting are converted first.
- A repeat is refused rather than run twice. If your code succeeded but the
  result could not be stored, the key stays locked and a retry gets a conflict.

## Not guaranteed, on purpose

- **That your checks are right.** In
  `caller((a, ctx) => accounts.ownedBy(a.accountId, ctx.actor.id))`, the
  ownership logic is yours. flue-guard guarantees it runs before the change
  and that its answer is logged. It cannot know whether the answer is correct.
- **What your code does once it runs.** Checks run before the handler. They
  do not limit what it does next. A handler that ignores its arguments and
  deletes something else is outside what this library can see. Limiting that
  is the job of Flue's sandbox and your infrastructure.
- **Tools that take free-form text.** See below.
- **Exactly once.** The guarantee is *at most* once per key. It is only as
  strong as the store: one process for the default in-memory store, all
  instances for a store that claims keys atomically. The one gap, a stored
  result that failed to save, ends in a refusal, never a second run.
- **Protection against deleting the log.** The chain shows that something was
  changed. It cannot bring deleted entries back. If deletion is a risk for
  you, copy the log somewhere that only allows appending.
- **Several writers on one file.** `HashChainAuditLog` expects one writer.
  With several instances, use a store-backed log.

## Free-form tools are declared, not checked

Some tools take raw SQL, a shell command, an arbitrary HTTP request, or code
to run. There is no target in them to check. The text itself decides what
happens. So flue-guard does two things, and only two:

- It **does not treat such a tool as safe** on its own. A tool marked
  `kind: "primitive"` that changes data will not load until you also set
  `egressControlled: true`. That flag is your written statement that
  something else limits what the tool can reach: a network allowlist, no
  credentials in the sandbox, a read-only database user.
- It **marks every call as broad** in the log (`kind: "primitive"` on the
  entry). A reviewer can see which entries no scope check actually limited.

The library does not check the flag, because it cannot see your network rules.
Limiting these tools is your infrastructure's job. Saying so plainly is the
point.

## Risks that remain

- **The model can still say wrong things.** The checks limit what a tool call
  can do. They do not stop the model from saying something false. They also do
  not stop a user from being talked into a request they are allowed to make,
  such as a refund they are entitled to.
- **Wide scope patterns.** `ticket:*` gives access to every ticket. The
  patterns you bind are your policy. The log records the scopes each call
  asked for, so a grant that is too wide is at least visible.
- **Who holds the keys.** Whoever has the HMAC key, or write access to the
  log's storage, could fake or cut the history. Keep both away from the
  machine where the agent's tools run.
