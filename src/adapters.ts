/**
 * `flue-guard/adapters` — the built-in adapter implementations and
 * helpers behind the toolkit's defaults. The toolkit works without importing
 * any of these; reach for them only when you're customizing a seam.
 *
 * The adapter *interfaces* (`AuditLog`, `IdempotencyStore`, `RbacAdapter`,
 * `ApprovalAdapter`, `Redactor`) live on the package root — implement those.
 */

// RBAC
export { defaultRbac } from "./rbac.js";

// Approval
export { autoApprove } from "./approval.js";

// Redaction
export {
  redactFields,
  textRedactor,
  composeRedactors,
  defaultRedactor,
  identityRedactor,
} from "./redaction.js";

// Idempotency (the process-local default store)
export { InMemoryIdempotencyStore } from "./idempotency.js";

// Scope matching
export { scopeAllowed, normalizeScopes, deniedScopes } from "./scope.js";

// Flue adapter (manual path: defineGovernedTool + toFlueTool)
export { toFlueTool, hostContextResolver } from "./flue.js";
