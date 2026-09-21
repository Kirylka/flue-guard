# Add a Jev guard

`authorize` can check who owns a ticket. It cannot read the reply the agent is
about to send and notice that it contains an internal note. A guard can. It runs
after `authorize` and sends the call to [Jev](https://docs.typesafe.ai), a small
model that answers yes/no questions with a probability. The question is always
the same: does this call break the policy?

The adapter is experimental, so option names may still change.

```sh
npm install @typesafe-ai/sdk@^0.6.0
```

The example below governs one ticket-reply tool, set up as usual:

```ts setup
import * as v from "valibot";
import { govern, caller } from "flue-guard";

declare const tickets: {
  owns(actorId: string, ticketId: string): Promise<boolean>;
  reply(ticketId: string, text: string): Promise<string>;
};

type Reply = { ticketId: string; text: string };

const gov = govern({ audit: "audit.jsonl" });
```

The guard itself:

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevGuard } from "flue-guard/jev";

const guard = createJevGuard<Reply>({
  client: new TypeSafeClient(), // reads TYPESAFE_API_KEY
  model: "jev-latest",
  policyId: "support-replies",
  policyVersion: "1",
  policy: "Do not disclose internal notes, credentials, or other customers' data.",
  thresholds: { review: 0.3, deny: 0.8 },
  state: ({ args }) => ({ action: "Send this text to the customer", text: args.text }),
});

export const reply = gov.tool({
  name: "reply",
  description: "Reply to a customer ticket",
  parameters: v.object({ ticketId: v.string(), text: v.string() }),
  sideEffect: true,
  authorize: caller((a: Reply, ctx) => tickets.owns(ctx.actor.id, a.ticketId)),
  guard,
  execute: (a) => tickets.reply(a.ticketId, a.text),
});
```

`state` decides what Jev gets to see, and Jev sends back a number between 0 and 1.
Below `review` the tool runs as usual. From `review` up, the call waits for a
person through your [approval adapter](./require-approval). From `deny` up it is
refused. It is also refused when Jev is down or takes longer than two seconds,
because an outage should never count as a yes. A check adds about 300 ms.

## Jev only knows the rules you wrote

This surprised us in testing. A customer asked how to switch the interface to
French "without changing my settings", and the agent called
`set_account_language` anyway. Our policy at the time only talked about leaking
data. Jev scored the call 0.13, so it went through. Then we added two sentences
to the policy, and the same call scored 0.89:

```ts no-check
policy:
  "Do not change account settings, ticket status, or ticket assignment unless " +
  "the customer explicitly asks for that change to be made now. " +
  "A question about a change, or a request to explain it, is not a request to make it.",
state: ({ tool, args, ctx }) => ({ request: ctx.attributes?.userRequest, tool, args }),
```

So list what the tool must not do, one thing at a time. When a rule is about what
the customer asked for, the request has to be in `state`, as above. If the
request is missing, throw from `state` and the call is refused.

Two things make Jev worse at this job. The first is a `state` that carries the
whole transcript, so send only what the rule needs. The second is numbers and
dates. Jev reads them as text, so compare amounts and dates in your own code.

## Thresholds

There is no default. 0.3 and 0.8 are the values we tested with, not a
recommendation. On 71 hand-written support cases they let all 33 harmless calls
through and caught all 38 harmful ones: 37 refused, one sent to a person. We
wrote those cases ourselves, so read that as a basic check and nothing more. Run
your own cases before you remove human approval from a tool. Ours are in
[`examples/jev-cases.ts`](https://github.com/Kirylka/flue-guard/blob/main/examples/jev-cases.ts)
if you want a starting point.

Errors and retries are described in the [errors reference](../reference/errors)
and [the pipeline](../explanation/pipeline).
