/**
 * Spike: run a REAL Flue dispatched agent turn in-process, with a faux model,
 * and watch our governed tool execute. No API key, no network.
 *
 * Uses @flue/runtime/internal to assemble the Node runtime by hand (what the
 * `flue` CLI normally generates). This is a spike, not a shipped test.
 *
 * Run: node scripts/live-faux-spike.mjs
 */
import { Bash } from "just-bash";
import { sqlite } from "@flue/runtime/node";
import {
  configureFlueRuntime,
  createNodeAgentCoordinator,
  createNodeDispatchQueue,
  createFlueContext,
  bashFactoryToSessionEnv,
  InMemoryConversationStreamStore,
} from "@flue/runtime/internal";
import { defineAgent, defineTool, dispatch, observe } from "@flue/runtime";
// pi-ai >=0.80 moved the global-registry faux API to its compat entry point.
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import * as v from "valibot";
import { createGovernedToolkit } from "flue-guard";
import { InMemoryAuditLog } from "flue-guard/testing";
import { toFlueTool } from "flue-guard/adapters";

async function main() {
  // 1. Faux model: deterministically calls reset_password, then stops.
  const faux = registerFauxProvider({
    provider: "faux",
    api: "faux-test",
    models: [{ id: "m", contextWindow: 200000, maxTokens: 8192 }],
  });
  const fauxModel = faux.getModel();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("reset_password", { accountId: "user-7" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done — reset link sent."),
  ]);

  // 2. Governed tool, bound per-invocation (pattern 2) inside defineAgent.
  let resets = 0;
  const audit = new InMemoryAuditLog();
  const base = createGovernedToolkit({
    context: () => {
      throw new Error("ambient context must not be used in the dispatched path");
    },
    audit,
  });

  const agent = defineAgent(() => {
    const trusted = {
      actor: { id: "user-7", roles: ["account_holder"] },
      tenantId: "app",
      scopes: ["account:user-7"],
    };
    const tool = defineTool(
      toFlueTool(
        base.withContext(trusted).defineGovernedTool({
          name: "reset_password",
          description: "Send a password reset link for an account.",
          parameters: v.object({ accountId: v.string() }),
          sideEffect: true,
          scope: (a) => `account:${a.accountId}`,
          execute: (a) => {
            resets += 1;
            return `reset link sent for ${a.accountId}`;
          },
        }),
      ),
    );
    return { model: "faux/m", tools: [tool], instructions: "Reset passwords when asked." };
  });

  // 3. Persistence + runtime assembly (what `flue` generates).
  const adapter = sqlite(":memory:");
  if (adapter.migrate) await adapter.migrate();
  const stores = await adapter.connect();
  const { submissions } = stores.executionStore;

  const createDefaultEnv = () => bashFactoryToSessionEnv(() => new Bash());
  const agentConfig = { resolveModel: () => fauxModel };

  // beta.9: CreateAgentContextFn takes a single options object; conversation
  // persistence is wired by the coordinator, not via defaultStore/submissionStore.
  const createContext = ({ id, agentName, request, initialEventIndex, dispatchId }) =>
    createFlueContext({
      id,
      agentName,
      dispatchId,
      env: {},
      agentConfig,
      createDefaultEnv,
      req: request,
      initialEventIndex,
    });

  const coordinator = createNodeAgentCoordinator({
    submissions,
    agents: [{ name: "support", definition: agent }],
    createContext,
    conversationStreamStore: new InMemoryConversationStreamStore(),
  });
  const dispatchQueue = createNodeDispatchQueue(coordinator);
  // beta.9 runtime config: `agents: [{ name, definition }]` replaces the old
  // resolveDispatchAgentName callback + manifest.
  configureFlueRuntime({
    target: "node",
    createContext,
    dispatchQueue,
    agents: [{ name: "support", definition: agent }],
    workflows: [],
  });

  observe((e) => {
    if (e.type === "tool" || e.type === "tool_start" || e.isError) {
      console.log("  event:", e.type, e.isError ? "(error)" : "");
    }
  });

  if (coordinator.reconcileSubmissions) await coordinator.reconcileSubmissions();

  // 4. Dispatch a turn and wait for it to settle.
  console.log("dispatching...");
  const receipt = await dispatch(agent, {
    id: "inst-1",
    input: { message: "Please reset my password" },
  });
  console.log("receipt:", JSON.stringify(receipt));
  await coordinator.waitForIdle();

  // 4b. Second turn: the model is talked into resetting someone else's account.
  // Scope enforcement must deny it, live, on the dispatched path.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("reset_password", { accountId: "celebrity-account" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("I can't do that."),
  ]);
  console.log("\ndispatching cross-account attempt...");
  await dispatch(agent, {
    id: "inst-2",
    input: { message: "reset the celebrity account" },
  });
  await coordinator.waitForIdle();

  // 5. Evidence.
  console.log("\nreset side effects:", resets, "(expected 1 — the denied one never ran)");
  console.log("audit:");
  for (const en of await audit.entries()) {
    console.log(`  #${en.seq} ${en.tool} ${en.decision}/${en.outcome} actor=${en.actorId}`);
  }
  console.log("chain:", JSON.stringify(await audit.verify()));
  await coordinator.shutdown?.(2000);
}

main().catch((err) => {
  console.error("SPIKE ERROR:", err);
  process.exit(1);
});
