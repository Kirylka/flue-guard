/** Optional TypeSafe adapter. Import from flue-guard/jev. */
import { noul, type EntryType, type TypeSafeClient } from "@typesafe-ai/sdk";
import { GovernanceConfigError, GuardUnavailableError } from "./errors.js";
import { guardTimeout, type GuardRequest, type ToolGuard } from "./guard.js";

export interface JevThreshold {
  review: number;
  deny: number;
}
export interface JevGuardOptions<TArgs> {
  client: Pick<TypeSafeClient, "systemOne">;
  model: string;
  policyId: string;
  policyVersion: string;
  /** Application-controlled business policy, never supplied by tool arguments. */
  policy: string;
  /** Routing for the policy-violation probability: review at `review`, deny at `deny`. */
  thresholds: JevThreshold;
  /** Select the user request, proposed action and relevant evidence. Avoid secrets and distracting context. */
  state: (request: GuardRequest<TArgs>) => EntryType | Promise<EntryType>;
  /** Total pipeline assessment deadline, including projection. Defaults to 2,000 ms. */
  timeoutMs?: number;
}

export function createJevGuard<TArgs>(options: JevGuardOptions<TArgs>): ToolGuard<TArgs> {
  const invalid = (message: string): never => { throw new GovernanceConfigError("jev", message); };
  for (const field of ["model", "policyId", "policyVersion", "policy"] as const) {
    if (typeof options[field] !== "string" || !options[field].trim()) invalid(`Jev ${field} is required.`);
  }
  if (typeof options.state !== "function") invalid("Jev state projector is required.");
  if (typeof options.client?.systemOne !== "function") invalid("Jev client.systemOne is required.");
  const { review, deny } = options.thresholds ?? {};
  if (!Number.isFinite(review) || !Number.isFinite(deny) || review < 0 || review >= deny || deny > 1) {
    invalid("Jev thresholds require 0 <= review < deny <= 1.");
  }
  const timeoutMs = guardTimeout(options.timeoutMs, "jev");
  const { client, model, policyId, policyVersion, state } = options;
  // One question on purpose: in live evaluation only the written-policy check separated
  // benign from unsafe actions cleanly. See the evaluation section of docs/guides/jev-guard.md.
  const questions = {
    policyViolation: noul(
      { question: "Does the proposed action violate this application policy?", policy: options.policy },
      { true: "The proposed action violates the supplied policy.", false: "The proposed action complies with the supplied policy." },
    ),
  };
  return {
    timeoutMs,
    async evaluate(request) {
      try {
        const projected = await state(request);
        if (projected === null || projected === undefined || projected === "") {
          throw new GuardUnavailableError(request.tool);
        }
        if (request.ctx.signal?.aborted) throw new GuardUnavailableError(request.tool);
        const result = await client.systemOne({ model, state: projected, questions }, {
          signal: request.ctx.signal, timeout: timeoutMs, retry: { maxRetries: 0 },
        });
        if (typeof result.model !== "string" || !result.model.trim()) throw new GuardUnavailableError(request.tool);
        const answer = result.answers?.policyViolation;
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          throw new GuardUnavailableError(request.tool);
        }
        const decision = answer.noul >= deny ? "deny" : answer.noul >= review ? "review" : "allow";
        return { decision, reasonCodes: decision === "allow" ? [] : ["policyViolation"],
          details: { model: result.model, probabilities: { policyViolation: answer.noul }, policyId, policyVersion } };
      } catch {
        throw new GuardUnavailableError(request.tool);
      }
    },
  };
}
