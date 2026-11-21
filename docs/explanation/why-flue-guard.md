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

Nobody broke the model. Nobody needed a clever prompt injection. The agent
did a normal thing it was allowed to do. The question "may this person touch
this account?" just wasn't asked anywhere. A prompt can't enforce it, and the
tool never asked it.

That's the gap flue-guard fills. It gives the check one fixed place, refuses
to load a tool that doesn't have one, and writes down every call either way.

## Flue already says this

Flue's [tools guide](https://flueframework.com/docs/guide/tools/) states the
principle:

> A tool's parameters are model-selected inputs, not an authorization
> boundary. Your application should decide which customer, account,
> repository, or credential a tool can use, then let the model select only
> values within that boundary.

Flue's own advice is to keep trusted ids in a closure, like the agent `id`
your logged-in route picked, so the model can't choose them. That works, and
flue-guard starts from the same idea. It adds three things a closure won't
give you on its own:

1. **The check is required.** A `sideEffect: true` tool with no check won't
   load. The High Touch Support mistake, a dangerous tool with no check
   anywhere, becomes an error when you start the app instead of an incident
   seven weeks later.
2. **The decision is written down.** Every call, allowed or refused, goes
   into a log you can hand to security or finance, and they can verify it
   themselves.
3. **Twice is also a failure.** Agents retry and change their minds. An
   idempotency key makes sure the side effect happens at most once.

## Division of labor

Flue decides what the agent *can* do: which tools exist, what the sandbox
allows, how a turn runs. flue-guard decides, call by call, whether *this
person* may do *this thing* to *this record*, whether it already happened,
and keeps the receipt. Neither of them knows who the user is. That comes from
your login system, and your server hands it over as a `TrustedContext`.

From top to bottom, each part hands something to the next:

| Part | What it does |
| --- | --- |
| Your login system | Checks who the person is |
| Your server | Turns that into a `TrustedContext` and passes it on (`gov.run`, `withContext`, `withSignal`) |
| **flue-guard** | Checks every tool call and writes each decision to the log |
| Flue | Runs the agent: turns, sessions, sandbox, models |
| Your infrastructure | Limits what code can reach: network rules, credentials, isolation |

Notice the model isn't on the list. It writes arguments, and that's all it
gets to do. [The trust model](/explanation/trust-model) goes through what each
part is trusted with, and which attacks it does and doesn't stop.

## Why in-process, per tool

To decide on a tool call you need three things at once: the arguments, who's
asking, and who owns what in your data. A gateway in front of the agent sees
prompts, not tool arguments. The agent framework knows which tools are on, not
who owns a record. Only the tool call itself has all three.

So flue-guard sits right there, wrapped around your handler, in your own
process. No extra network hop, no extra service to run and keep alive.
