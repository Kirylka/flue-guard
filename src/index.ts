/**
 * `flue-guard` — the golden path.
 *
 * Four concepts cover almost everything: `govern`, `caller`, `gov.tool`, and
 * `gov.run`. This entry point exports those, the core types, the error
 * taxonomy, and the adapter *interfaces* you implement to customize a seam.
 *
 * The built-in adapter implementations, hashing/verification utilities, and
 * test doubles live on subpaths so they don't crowd the root surface:
 *   - `flue-guard/audit`     — hashEntry, verifyChain, audit-log impls
 *   - `flue-guard/adapters`  — default RBAC/redaction/idempotency, toFlueTool
 *   - `flue-guard/testing`   — in-memory test doubles
 *
 * ESM-only. Node 22+.
 */

// --- The golden path -------------------------------------------------------
export { govern } from "./govern.js";
export type { GovernOptions } from "./govern.js";
export { createGovernedToolkit, caller, trusted } from "./toolkit.js";
export type {
  GovernedToolkit,
  GovernedToolkitOptions,
  GovernedToolSpec,
  GovernedFlueToolSpec,
  AuthorizeSpec,
  TrustedSource,
  FlueDefineTool,
} from "./toolkit.js";

// --- Core types ------------------------------------------------------------
export type {
  TrustedContext,
  ExecutionContext,
  FlueCompatibleTool,
  StandardSchemaV1,
  InferArgs,
  Decision,
  Outcome,
  ArgValidator,
  ParseValidator,
  FnValidator,
} from "./types.js";
export type { FlueToolDefinition } from "./flue.js";

// --- Trusted-context propagation -------------------------------------------
export { ContextStore } from "./context.js";
export type { ContextResolver } from "./context.js";

// --- Error taxonomy --------------------------------------------------------
export * from "./errors.js";

// --- Adapter interfaces (the seams you implement) --------------------------
// Implementations live on `/adapters`, `/audit`, and `/testing`.
export type { AuditLog, AuditEntry, AuditEntryBody, AuditInput } from "./audit.js";
export type {
  IdempotencyStore,
  IdempotencyRecord,
  IdempotencyStatus,
  BeginResult,
} from "./idempotency.js";
export type { RbacAdapter, RbacRequest } from "./rbac.js";
export type {
  ApprovalAdapter,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalDecision,
} from "./approval.js";
export { always, never } from "./approval.js";
export type { Redactor } from "./redaction.js";
