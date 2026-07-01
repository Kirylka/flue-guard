# Why flue-guard exists

← [Back to the README](../README.md)

## A real example, because we just got one

In spring 2026, attackers took over more than 20,000 Instagram accounts without
breaking into anything. They asked.

Meta had an AI support agent called High Touch Support that helped locked-out
users get back into their accounts. One of its tools could trigger a password
reset. The tool worked. The problem was what it didn't do: it never checked that
the person asking actually owned the account they were asking about. So you
could point it at someone else's account, get a reset link, and walk in. Even
accounts without 2FA. The campaign ran for about seven weeks before anyone
noticed, and the list of victims included a White House handle and a senior US
Space Force account.

(Reporting: [BleepingComputer](https://www.bleepingcomputer.com/news/security/meta-ai-support-data-breach-affects-20-000-instagram-accounts/),
[TechCrunch](https://techcrunch.com/2026/06/01/hackers-hijacked-instagram-accounts-by-tricking-meta-ai-support-chatbot-into-granting-access/),
[SecurityWeek](https://www.securityweek.com/meta-says-20000-instagram-accounts-hacked-via-ai-tool-abuse/).)

The model wasn't jailbroken. There was no clever prompt injection. The agent did
a normal thing it was allowed to do, and the only thing standing between "help a
user" and "hand over 20,000 accounts" was a check that lived nowhere. Not in the
prompt, because prompts aren't security. It needed to live at the exact spot
where the tool does the dangerous part: *is the person asking allowed to touch
this account?*

That check is the whole reason this library exists.

## Where this fits with Flue

Flue gives you a real agent harness: sandboxing, sessions, MCP, tools, the works.
It can already say "this tool is only callable when the agent is in this state."
That's useful, and it's not what bit Meta.

The questions that bit Meta are different. "Is this caller allowed to act on
*this* account?" "Did we already do this once, so don't do it again on a retry?"
"Can we hand finance a log of every account change and show it hasn't been
touched?" Those aren't questions about harness state. They're questions about
the specific call, the specific caller, and the specific record. They belong
right next to the tool, and that's where this library puts them.

Short version: Flue decides what the agent can do. This decides who it's allowed
to do it to, whether it's safe to do twice, and whether you can prove what it
did.

---

Next: [Architecture](./architecture.md) — how identity, governance, and the
substrate stack up.
