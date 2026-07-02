# Why flue-guard exists

## The incident

In spring 2026, attackers took over more than 20,000 Instagram accounts
without breaking into anything. They asked.

Meta ran an AI support agent, High Touch Support, that helped locked-out
users regain access. One of its tools could trigger a password reset. The
tool worked. What it never did was check that the person asking owned the
account they were asking about. Point it at someone else's account, receive a
reset link, walk in. The campaign ran for about seven weeks before detection,
and the victims included a White House handle and a senior US Space Force
account.

(Reporting: [BleepingComputer](https://www.bleepingcomputer.com/news/security/meta-ai-support-data-breach-affects-20-000-instagram-accounts/),
[TechCrunch](https://techcrunch.com/2026/06/01/hackers-hijacked-instagram-accounts-by-tricking-meta-ai-support-chatbot-into-granting-access/),
[SecurityWeek](https://www.securityweek.com/meta-says-20000-instagram-accounts-hacked-via-ai-tool-abuse/).)

The model was not jailbroken and no clever prompt injection was involved.
The agent did a normal thing it was allowed to do. The check "is the caller
allowed to touch this account?" lived nowhere: prompts can't enforce it, and
nothing at the tool boundary asked it. flue-guard exists to give that check a
place to live, to refuse tools that don't have one, and to keep a receipt
either way.

## Flue already says this

Flue's [tools guide](https://flueframework.com/docs/guide/tools/) states the
principle:

> A tool's parameters are model-selected inputs, not an authorization
> boundary. Your application should decide which customer, account,
> repository, or credential a tool can use, then let the model select only
> values within that boundary.

Flue's documented technique is to close over trusted identifiers (the agent
instance `id` your authenticated route selected) so the model can't choose
them. That works, and flue-guard builds on the same idea with three additions
that closures alone don't give you:

1. The gate is declared, and required. A `sideEffect: true` tool without
   an authorization gate refuses to define. The High Touch Support failure
   mode, a dangerous tool whose check lives nowhere, becomes a startup error
   instead of an incident.
2. The decision is recorded. Every call, allowed or refused, lands in a
   hash-chained audit log you can hand to security or finance and verify
   after the fact.
3. Doing it twice is its own failure. Agents retry and re-plan; a
   declared idempotency key makes the side effect run at most once per
   logical operation.

## Division of labor

Flue decides what the agent can do: which tools exist in the session, what
the sandbox allows, how the turn runs. flue-guard decides, per call, whether
*this caller* may do *this action* to *this resource*, whether it is safe to
do again, and whether you can prove what happened. The identity itself comes
from above both: whatever authenticates your users (your IdP, your session
layer) is the source of the `TrustedContext` you bind at the request
boundary.

Top to bottom, each layer feeds the one below it:

| Layer | Responsibility |
| --- | --- |
| Your IdP / auth | Verifies the human, issues claims |
| Your request handler | Maps claims into a `TrustedContext` and binds it (`gov.run` / `withContext`) |
| **flue-guard** | The per-call decision pipeline, hash-chained into the audit log |
| Flue | Harness, sessions, sandbox, model wiring |
| Your substrate | Egress allowlists, credentials, isolation |

The model sits beside this stack, not in it: it supplies arguments and
nothing else. What each layer is trusted to do, and the attacks each one
does and doesn't stop, is spelled out in
[the trust model](/explanation/trust-model).

## Why in-process, per tool

Authorization for a tool call needs the call's arguments, the caller's
identity, and your domain's ownership data, all at the moment of the call.
A gateway in front of the agent sees prompts, not tool targets; harness state
knows modes, not record ownership. The only place all three meet is the tool
boundary itself, so that is where flue-guard runs: as a wrapper around the
handler, inside your process, with no network hop and no extra
infrastructure to deploy.
