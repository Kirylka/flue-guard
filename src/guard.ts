import type { ExecutionContext } from "./types.js";
import { GovernanceConfigError, GuardUnavailableError } from "./errors.js";

export interface GuardAssessment {
  decision: "allow" | "deny" | "review";
  reasonCodes: string[];
  /** Provider-specific evidence, such as model, probabilities, and policy version. */
  details?: Record<string, unknown>;
}

export interface GuardRequest<TArgs = unknown> {
  tool: string;
  args: TArgs;
  ctx: ExecutionContext;
}

export interface ToolGuard<TArgs = unknown> {
  /** Total evaluation deadline in milliseconds. Defaults to 2,000. */
  timeoutMs?: number;
  evaluate(request: GuardRequest<TArgs>): Promise<GuardAssessment>;
}

export function guardTimeout(timeoutMs: number | undefined, tool: string): number {
  const timeout = timeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new GovernanceConfigError(tool, "guard.timeoutMs must be a positive 32-bit integer.");
  }
  return timeout;
}

function isAssessment(value: unknown): value is GuardAssessment {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<GuardAssessment>;
  return (
    (result.decision === "allow" || result.decision === "deny" || result.decision === "review") &&
    Array.isArray(result.reasonCodes) &&
    result.reasonCodes.every((reason) => typeof reason === "string") &&
    (result.details === undefined ||
      (result.details !== null && typeof result.details === "object" && !Array.isArray(result.details)))
  );
}

/** Bound the wait even when a custom evaluator ignores cancellation. */
export async function evaluateGuard<TArgs>(
  guard: ToolGuard<TArgs>,
  request: GuardRequest<TArgs>,
): Promise<GuardAssessment> {
  const controller = new AbortController();
  const parentSignal = request.ctx.signal;
  const abort = () => controller.abort();
  const timeoutMs = guardTimeout(guard.timeoutMs, request.tool);
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(abort, timeoutMs);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  let rejectAborted: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(new GuardUnavailableError(request.tool));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
      if (controller.signal.aborted) rejectAborted();
    });
    const evaluation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new GuardUnavailableError(request.tool);
      return guard.evaluate({ ...request, ctx: { ...request.ctx, signal: controller.signal } });
    });
    const result: unknown = await Promise.race([evaluation, interrupted]);
    // A busy event loop can delay the timer until after the evaluator resolves.
    if (performance.now() >= deadline) abort();
    if (controller.signal.aborted || !isAssessment(result)) {
      throw new GuardUnavailableError(request.tool);
    }
    return result;
  } catch {
    // Provider error bodies may contain credentials or submitted state.
    throw new GuardUnavailableError(request.tool);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
    if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
  }
}
