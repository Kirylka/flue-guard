/**
 * Flue 2 integration. Tool schemas remain `input`; parsed arguments arrive
 * as `data`, and handler results travel in a separate `{ output }` envelope.
 * Trusted identity is bound by ContextStore or toolkit.withContext(), never
 * inferred from model-selected arguments. For dispatched agents, bind from
 * authenticated delivery attributes inside the agent function.
 */

import type { ContextResolver } from "./context.js";
import { isApprovalPending, MissingContextError } from "./errors.js";
import * as v from "valibot";
import type { FlueCompatibleTool, TrustedContext } from "./types.js";

/** The subset of Flue's tool context consumed by the governance adapter. */
export interface FlueRunContext {
  data?: unknown;
  signal?: AbortSignal;
  /** Flue's id for this call; stable if Flue re-runs the same call. */
  toolCallId?: string;
}

/**
 * What the model sees when a call is waiting for a person. The turn ends right
 * after it (`terminate: true`), so the model does not retry or improvise; your
 * server delivers the decision later as a new signal.
 */
export interface PendingApprovalOutput {
  status: "pending_approval";
  tool: string;
  /** The approval adapter's handle for the request, e.g. a ticket id. */
  ref?: string;
  reason?: string;
}

/**
 * Flue-compatible definition with the concrete governed `run` signature.
 * Schema fields match Flue's public contract so this can be passed directly
 * to defineTool() or useTool(). No output schema is emitted by the adapter;
 * Flue validates JSON compatibility when it consumes the result envelope.
 */
export interface FlueToolDefinition {
  name: string;
  description: string;
  input: v.GenericSchema<Record<string, unknown>, unknown>;
  output: v.GenericSchema<unknown, NonNullable<unknown> | null> | undefined;
  /** Bound on one call; Flue 2.3+ enforces it, older versions ignore it. */
  timeoutMs?: number;
  run: (context: FlueRunContext) => Promise<{ output: unknown; terminate?: boolean }>;
}

/**
 * Passthrough `input` schema for tools whose `parameters` can't be handed to
 * Flue as-is. Flue only invokes `run` with the arguments it parsed against a
 * declared `input` — with no `input`, the model's arguments are dropped
 * entirely and the handler (and every scope/authorize/idempotency predicate)
 * would compute over `{}`. So the arguments must always travel through Flue,
 * even when validation is ours.
 */
const passthroughInput = v.looseObject({});

/**
 * The `input` schema to emit for a governed tool. A genuine Valibot schema is
 * forwarded as-is (Flue validates the model's arguments against it and the
 * model sees the real parameter shape). Anything else — a function, a zod-like
 * `{ parse }`, or a non-Valibot Standard Schema (all validated internally by
 * the governance core), or no validator at all — degrades to an unconstrained
 * object passthrough: the model sees no parameter constraints, but its
 * arguments still arrive intact for the internal validator and the governance
 * predicates to work on.
 */
function asFlueInput(parameters: unknown): FlueToolDefinition["input"] {
  if (!parameters || typeof parameters !== "object") return passthroughInput;
  const std = (parameters as { "~standard"?: { vendor?: unknown } })[
    "~standard"
  ];
  return std && std.vendor === "valibot"
    ? (parameters as FlueToolDefinition["input"])
    : passthroughInput;
}

/**
 * Adapt a governed tool to Flue 2. Always wrap the handler result, including
 * objects with `output` or `terminate` keys: those are application data and
 * must never be interpreted as runtime control fields.
 *
 * A call suspended for approval does not reach the model as an error. Flue
 * would show a thrown error to the model and keep the turn going, so the
 * adapter returns a {@link PendingApprovalOutput} with `terminate: true`
 * instead, and the turn ends. Every other error is thrown as before.
 */
export function toFlueTool(governed: FlueCompatibleTool): FlueToolDefinition {
  return {
    name: governed.name,
    description: governed.description,
    input: asFlueInput(governed.parameters),
    output: undefined,
    ...(governed.timeoutMs !== undefined ? { timeoutMs: governed.timeoutMs } : {}),
    run: async ({ data, signal, toolCallId }) => {
      try {
        return {
          output: await governed.execute(data ?? {}, undefined, signal, { toolCallId }),
        };
      } catch (err) {
        if (!isApprovalPending(err)) throw err;
        const output: PendingApprovalOutput = {
          status: "pending_approval",
          tool: governed.name,
          ...(err.ref !== undefined ? { ref: err.ref } : {}),
          ...(err.reason !== undefined ? { reason: err.reason } : {}),
        };
        return { output, terminate: true };
      }
    },
  };
}

/**
 * Build a {@link ContextResolver} that derives the trusted context from a
 * context object passed as the second argument to a governed tool's `execute`.
 * This suits custom runtimes that hand a context to tools; note that **Flue does
 * not** — its `run` provides no trusted caller identity — so under Flue use
 * {@link ContextStore} instead. Throws {@link MissingContextError}
 * (fail-closed) if absent.
 */
export function hostContextResolver<H>(
  extract: (host: H) => TrustedContext | Promise<TrustedContext>,
): ContextResolver {
  return (hostContext?: unknown) => {
    if (hostContext == null) throw new MissingContextError();
    return extract(hostContext as H);
  };
}
