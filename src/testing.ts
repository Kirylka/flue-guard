/**
 * `flue-guard/testing` — in-process test doubles. Handy in unit tests
 * and ephemeral/local runs where you don't want a real audit file or store.
 *
 * `InMemoryAuditLog` is also a legitimate runtime sink (it's a full hash-chained
 * implementation); it lives here as well as in `/audit` for discoverability.
 */

export { InMemoryAuditLog } from "./audit.js";
export { InMemoryIdempotencyStore } from "./idempotency.js";
