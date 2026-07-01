/**
 * Approval adapters (a supporting feature).
 *
 * Human-in-the-loop approval is becoming a standard primitive in agent
 * runtimes. This library does not reimplement pause/resume; it provides a thin
 * seam so a governed tool can require approval and delegate the actual decision
 * to your own workflow (Slack, a ticket, Flue's session state, etc.).
 *
 * Fail-closed: if a tool requires approval and no adapter is configured, the
 * call is denied.
 */

import type { TrustedContext } from "./types.js";

export interface ApprovalRequest<TArgs = unknown> {
  tool: string;
  args: TArgs;
  ctx: TrustedContext;
  /** Why approval was triggered, e.g. "refund exceeds $50". */
  reason?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /**
   * Not yet decided. The call is suspended (an `ApprovalPendingError` is
   * thrown) so the harness can pause and resume later; on resume the tool is
   * re-invoked and the adapter is consulted again. `approved` is ignored when
   * `pending` is true.
   */
  pending?: boolean;
  /** Adapter's handle for a pending/again-consulted approval (e.g. ticket id). */
  ref?: string;
  approver?: string;
  reason?: string;
}

export interface ApprovalAdapter {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * A tool's approval policy. Either always require approval (`true`) or decide
 * per call from the arguments and context (return a reason string to require
 * approval, or `false`/`undefined` to skip it).
 */
export type ApprovalPolicy<TArgs = unknown> =
  | boolean
  | ((args: TArgs, ctx: TrustedContext) => boolean | string | undefined);

/** Adapter that auto-approves everything. Useful for local development. */
export const autoApprove: ApprovalAdapter = {
  async request() {
    return { approved: true, approver: "auto" };
  },
};
