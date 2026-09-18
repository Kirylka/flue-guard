import { test } from "node:test";
import assert from "node:assert/strict";
import { hostContextResolver, toFlueTool } from "../src/flue.js";
import { createGovernedToolkit } from "../src/toolkit.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { MissingContextError } from "../src/errors.js";
import type { TrustedContext } from "../src/types.js";

test("hostContextResolver extracts trusted context from a runtime host object", async () => {
  // For non-Flue runtimes that pass a context object into execute as 2nd arg.
  // (Flue provides no caller identity, so bind it with ContextStore/withContext.)
  interface RuntimeHost {
    session: { userId: string; tenant: string };
  }
  const resolver = hostContextResolver<RuntimeHost>((host) => ({
    actor: { id: host.session.userId, roles: ["agent"] },
    tenantId: host.session.tenant,
    scopes: ["customer:*"],
  }));

  const audit = new InMemoryAuditLog();
  const toolkit = createGovernedToolkit({ context: resolver, audit });
  const tool = toolkit.defineGovernedTool({
    name: "lookup",
    description: "l",
    execute: (_a, ctx) => ({ tenant: ctx.tenantId, actor: ctx.actor.id }),
  });

  const host: RuntimeHost = { session: { userId: "u-7", tenant: "globex" } };
  const result = (await tool.execute({}, host)) as TrustedContext extends never
    ? never
    : { tenant: string; actor: string };
  assert.deepEqual(result, { tenant: "globex", actor: "u-7" });

  const entries = await audit.entries();
  assert.equal(entries[0]!.tenantId, "globex");
  assert.equal(entries[0]!.actorId, "u-7");
});

test("toFlueTool forwards Flue's run({ signal }) to the handler's context", async () => {
  const audit = new InMemoryAuditLog();
  const ctx: TrustedContext = {
    actor: { id: "a1", roles: ["agent"] },
    tenantId: "acme",
    scopes: [],
  };
  const toolkit = createGovernedToolkit({ context: () => ctx, audit });
  let seen: AbortSignal | undefined;
  const governed = toolkit.defineGovernedTool({
    name: "long_job",
    description: "a cancellable job",
    execute: (_a, gctx) => {
      seen = gctx.signal;
      return "done";
    },
  });

  const tool = toFlueTool(governed);
  const controller = new AbortController();
  const out = await tool.run({ signal: controller.signal });

  assert.deepEqual(out, { output: "done" });
  assert.equal(seen, controller.signal);
});

test("hostContextResolver throws if no host context is provided", () => {
  const resolver = hostContextResolver<{ x: number }>((h) => ({
    actor: { id: "a", roles: [] },
    tenantId: String(h.x),
    scopes: [],
  }));
  assert.throws(() => resolver(undefined), MissingContextError);
});

test("Flue 2 data reaches authorization and structured output stays inside the envelope", async () => {
  const toolkit = createGovernedToolkit({
    context: () => ({ actor: { id: "alice", roles: [] }, tenantId: "acme" }),
    audit: new InMemoryAuditLog(),
  });
  const tool = toFlueTool(toolkit.defineGovernedTool<{ accountId: string }>({
    name: "lookup_account",
    description: "Look up the caller's account",
    authorize: { anchor: "caller", check: (args, ctx) => args.accountId === ctx.actor.id },
    execute: (args) => ({ accountId: args.accountId, terminate: true }),
  }));
  const context = { data: { accountId: "alice" }, signal: new AbortController().signal };
  assert.deepEqual(await tool.run(context), {
    output: { accountId: "alice", terminate: true },
  });
});
