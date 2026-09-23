# Why flue-guard exists

## The incident

In spring 2026, attackers took over more than 20,000 Instagram accounts
without breaking into anything. They asked.

Meta ran an AI support agent, High Touch Support, that helped locked-out
users regain access. One of its tools could trigger a password reset. The
tool worked. It never checked that the person asking owned the account they
asked about. Name someone else's account, get the reset link, take over the
account. The attacks ran for about seven weeks before anyone noticed. The
victims included a White House account and a senior US Space Force account.

(Reporting: [BleepingComputer](https://www.bleepingcomputer.com/news/security/meta-ai-support-data-breach-affects-20-000-instagram-accounts/),
[TechCrunch](https://techcrunch.com/2026/06/01/hackers-hijacked-instagram-accounts-by-tricking-meta-ai-support-chatbot-into-granting-access/),
[SecurityWeek](https://www.securityweek.com/meta-says-20000-instagram-accounts-hacked-via-ai-tool-abuse/).)

Nobody broke the model, and no clever prompt injection was needed. The agent
did a normal thing it was allowed to do. The question "may this caller touch
this account?" was asked nowhere. A prompt cannot enforce it, and the tool
never asked it. flue-guard gives that check a fixed place. It refuses tools
that have no check, and it records every call either way.

## Flue already says this

Flue's [tools guide](https://flueframework.com/docs/guide/tools/) states the
principle:

> A tool's parameters are model-selected inputs, not an authorization
> boundary. Your application should decide which customer, account,
> repository, or credential a tool can use, then let the model select only
> values within that boundary.

Flue's own advice is to capture trusted ids in a closure, such as the agent
`id` your authenticated route picked, so the model cannot choose them. That
works. flue-guard builds on the same idea and adds three things a closure
alone does not give you:

1. The check is declared, and required. A `sideEffect: true` tool with no
   check will not load. The High Touch Support mistake, a dangerous tool with
   no check anywhere, becomes an error at startup instead of an incident.
2. The decision is recorded. Every call, allowed or refused, goes into a log
   you can give to security or finance, and they can verify it later.
3. Doing something twice is its own failure. Agents retry and change plans.
   An idempotency key makes the side effect run at most once per operation.

## Division of labor

Flue decides what the agent can do: which tools exist, what the sandbox
allows, how a turn runs. flue-guard decides on each call whether *this caller*
may do *this action* to *this record*. It also decides whether the call may run
again, and it keeps the proof. Neither of them knows who the user is. That
comes from your login system, and your request handler turns it into the
`TrustedContext` it binds.

Top to bottom, each layer feeds the one below it:

| Layer | Responsibility |
| --- | --- |
| Your IdP / auth | Verifies the human, issues claims |
| Your request handler | Maps claims into a `TrustedContext` and binds it (`gov.run` / `withContext`) |
| **flue-guard** | The per-call decision pipeline, hash-chained into the audit log |
| Flue | Harness, sessions, sandbox, model wiring |
| Your substrate | Egress allowlists, credentials, isolation |

The model is not a layer in this list. It supplies arguments and nothing else. What each layer is trusted to do, and the attacks each one
does and doesn't stop, is spelled out in
[the trust model](/explanation/trust-model).

## Why in-process, per tool

To decide on a tool call you need three things at the moment of the call: the
arguments, who the caller is, and who owns what in your data. A gateway in
front of the agent sees prompts, not tool arguments. The agent framework knows
which tools are on, not who owns a record. Only the tool call itself has all
three. So flue-guard wraps your handler, inside your process. There is no extra
network call and no extra service to run.
