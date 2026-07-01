# flue-guard — Implementation Task Specs

**Status:** Draft v0.1 (specs — work breakdown, not implementation)
**Last updated:** 2026-06-17
**Companions:** `BUSINESS_REQUIREMENTS.md`, `FUNCTIONAL_REQUIREMENTS.md`,
`TECH_ARCHITECTURE.md`
**Convention:** Each task lists objective, deliverables, dependencies,
acceptance criteria, and traceability (FR-* / architecture §). Tasks are sized
to be implementable and independently verifiable.

---

## Dependency graph & suggested sequence

```
T-0 scaffold
 └─ T-1 types+errors
     ├─ T-2 context
     ├─ T-3 scope
     ├─ T-4 redaction
     ├─ T-5 audit
     ├─ T-6 idempotency
     ├─ T-7 rbac
     └─ T-8 approval
          └─ T-9 toolkit/pipeline  (integrates T-2..T-8)
              └─ T-10 flue adapter
                  └─ T-11 public surface (index)
                      ├─ T-12 support-agent example
                      ├─ T-13 test suite
                      └─ T-14 README + docs
```

T-2 … T-8 are independent of one another and may be done in parallel after T-1.

---

## T-0 — Project scaffold
- **Objective:** A buildable, typed, MIT-licensed package skeleton.
- **Deliverables:** `package.json` (ESM, `type: module`, build/test/example
  scripts), `tsconfig.json` (NodeNext, strict, declaration), `.gitignore`,
  reference the existing `LICENSE` (MIT), empty `src/`, `test/`, `examples/`.
- **Dependencies:** none.
- **Acceptance:** `npm run build` succeeds on an empty `src/index.ts`; package
  has zero runtime dependencies.
- **Traceability:** C-8, C-12, C-13; arch §3, §10.

## T-1 — Core types & errors
- **Objective:** Shared contracts and the error hierarchy.
- **Deliverables:** `src/types.ts` (`TrustedContext`, `ExecutionContext`,
  `ArgValidator`, `GovernedToolSpec`, `FlueCompatibleTool`, `Decision`,
  `Outcome`); `src/errors.ts` (`GovernanceError` + `MissingContext`,
  `AccessDenied`, `ScopeViolation`, `ApprovalDenied`, `IdempotencyConflict`).
- **Dependencies:** T-0.
- **Acceptance:** Types compile; every error carries a machine code and extends
  `GovernanceError`.
- **Traceability:** FR-1.1, FR-9.1; arch §4.

## T-2 — Trusted context
- **Objective:** Server-authoritative context propagation.
- **Deliverables:** `src/context.ts` — `ContextStore` (AsyncLocalStorage) with
  `run/peek/current/resolver`, and the `ContextResolver` type.
- **Dependencies:** T-1.
- **Acceptance:** `current()` inside `run()` returns the bound context; outside
  it throws `MissingContextError`; nested runs isolate correctly.
- **Traceability:** FR-2.1/2.2/2.3, C-5; arch §7.

## T-3 — Scope matching
- **Objective:** Wildcard tenant/resource scope checks.
- **Deliverables:** `src/scope.ts` — `normalizeScopes`, `scopeAllowed`,
  `deniedScopes` with single-`*` wildcard semantics.
- **Dependencies:** T-1.
- **Acceptance:** `customer:*` matches `customer:c-1`; exact match works; `*`
  matches all; unrelated scopes are denied; regex metacharacters are escaped.
- **Traceability:** FR-3.1/3.2/3.3; arch §2 step 4.

## T-4 — Redaction
- **Objective:** Audit-time PII masking that never touches execution values.
- **Deliverables:** `src/redaction.ts` — `Redactor` type, `redactFields`,
  `defaultRedactor`, `identityRedactor`.
- **Dependencies:** T-1.
- **Acceptance:** Sensitive field names → `[redacted]`; emails/long digit runs
  masked in strings; nested objects/arrays handled; input object not mutated.
- **Traceability:** FR-8.1/8.2; arch §5 step 8.

## T-5 — Tamper-evident audit log
- **Objective:** Hash-chained, verifiable audit records.
- **Deliverables:** `src/audit.ts` — `AuditEntry`, canonical serialization,
  `hashEntry`, `verifyChain`, `InMemoryAuditLog`, `HashChainAuditLog` (JSONL),
  `AuditLog` interface, `GENESIS_HASH`.
- **Dependencies:** T-1.
- **Acceptance:** Appends chain correctly; `verifyChain` passes for a clean
  log; **mutating any historical entry makes `verifyChain` report the first
  broken seq**; hashing is order-independent; file log reseeds from disk on
  construction; append failure surfaces as an error (no silent drop).
- **Traceability:** FR-7.1–7.5, C-7; arch §6, §11.

## T-6 — Idempotency store
- **Objective:** At-most-once external writes per logical key.
- **Deliverables:** `src/idempotency.ts` — `IdempotencyStore` interface,
  records/states, `InMemoryIdempotencyStore` with injectable clock and TTL.
- **Dependencies:** T-1.
- **Acceptance:** First `begin` → `started`; after `complete`, `begin` →
  `replay` with stored result; in-flight key → `in_flight`; `fail` releases for
  retry; TTL expiry permits re-execution; keys are tenant-namespaced.
- **Traceability:** FR-6.1–6.6, C-10; arch §8.

## T-7 — RBAC adapter
- **Objective:** Swappable role checks with an any-of default.
- **Deliverables:** `src/rbac.ts` — `RbacAdapter`, `RbacRequest`, `defaultRbac`.
- **Dependencies:** T-1.
- **Acceptance:** Empty `requireRoles` → allow; any matching role → allow; no
  match → deny; custom adapter is honored.
- **Traceability:** FR-4.1/4.2; arch §2 step 3.

## T-8 — Approval adapter
- **Objective:** Approval seam delegating to the team's workflow.
- **Deliverables:** `src/approval.ts` — `ApprovalAdapter`, `ApprovalRequest`,
  `ApprovalDecision`, `ApprovalPolicy`, `autoApprove`.
- **Dependencies:** T-1.
- **Acceptance:** Boolean and function policies both evaluated; a triggered
  policy with no adapter → deny (fail-closed); decision data is returned.
- **Traceability:** FR-5.1/5.2/5.3; arch §2 step 5.

## T-9 — Toolkit & governance pipeline
- **Objective:** The composition root tying everything into the normative
  pipeline behind `defineGovernedTool`.
- **Deliverables:** `src/toolkit.ts` — `createGovernedToolkit(opts)` returning
  `{ defineGovernedTool }`; implements the exact order context → validate →
  RBAC → scope → approval → idempotency → execute → audit, with the
  decision/outcome matrix.
- **Dependencies:** T-2…T-8.
- **Acceptance:**
  - Cross-tenant/out-of-scope call → `ScopeViolationError`, audited `deny`.
  - Missing role → `AccessDeniedError`, audited `deny`.
  - Duplicate side-effect call → handler runs once, second returns replay,
    audited `replayed`.
  - Handler throw → audited `allow`/`error`, idempotency key released, error
    re-propagated.
  - Approval-required-without-adapter → deny.
  - Exactly one audit entry per call; redaction applied before write.
- **Traceability:** FR-1.1, FR-9.2/9.3; arch §2, §5.

## T-10 — Flue adapter
- **Objective:** Emit a Flue-compatible tool object.
- **Deliverables:** `src/flue.ts` — shaping to `{ name, description,
  parameters, execute(args, hostCtx) }`; forward `hostCtx` to the resolver.
- **Dependencies:** T-9; **A-1 confirmed** — `@flue/runtime` `defineTool({ name,
  description, parameters, execute })`, opaque Valibot/TypeBox `parameters`,
  `execute(args)` single pre-parsed arg, `FlueContext` in the `run` scope.
- **Acceptance:** Output drops into `init({ tools: [...] })`; host context
  reaches a custom resolver; core modules remain free of any Flue import.
- **Traceability:** FR-1.2/1.4, C-2/C-3; arch §9.

## T-11 — Public surface
- **Objective:** A clean, documented entry point.
- **Deliverables:** `src/index.ts` re-exporting the public API only.
- **Dependencies:** T-9, T-10.
- **Acceptance:** `import { createGovernedToolkit, ContextStore,
  HashChainAuditLog, ... } from "flue-guard"` resolves with types.
- **Traceability:** arch §3.

## T-12 — Support agent example
- **Objective:** Runnable proof of the hero guarantees, mirroring the README.
- **Deliverables:** `examples/support-agent.ts` — a `reset_password` tool gated
  by `authorize` (caller must control the account) and an `issue_refund` tool
  gated by `scope` + `approval` + `idempotency`; a mock `init()` standing in for
  Flue so it runs with zero deps; also shows the fail-closed definition guard.
- **Dependencies:** T-11.
- **Acceptance:** `npm run example` shows: ungated side-effect tool refused at
  definition, `authorize` block on another user's account, scope deny on another
  customer, single refund on a duplicate call, approval allow/deny, and
  `verifyChain` → valid.
- **Traceability:** FR-10.1; arch §1.

## T-13 — Test suite
- **Objective:** Verify every FR with automated tests.
- **Deliverables:** `test/*.test.ts` using `node:test`; unit tests per module
  (T-2…T-8) plus pipeline integration tests (T-9) and a tamper-detection test.
- **Dependencies:** T-9 (unit tests can start with their module).
- **Acceptance:** `npm test` green; tamper test fails the chain; idempotency,
  scope, RBAC, approval, redaction, and decision-matrix cases all covered.
- **Traceability:** All FRs; arch §11.

## T-14 — README & docs
- **Objective:** Ship the positioning and a 5-line quickstart.
- **Deliverables:** `README.md` with the one-liner, the Flue-vs-governance
  table, the architecture sentence, install/quickstart, the adapter list, and
  the "why not a managed control plane" wedge; link the four design docs.
- **Dependencies:** T-11, T-12.
- **Acceptance:** A reader can wrap a tool from the quickstart alone;
  positioning matches `BUSINESS_REQUIREMENTS.md`.
- **Traceability:** BR positioning; §4 of business reqs.

---

## Definition of done (v0.1)
1. T-0…T-14 complete; `npm run build`, `npm test`, `npm run example` all pass.
2. Zero runtime dependencies; MIT `LICENSE` present.
3. Cross-tenant action **blocked**, duplicate refund **replayed**, audit chain
   **verified** — demonstrated by the example and covered by tests.
4. Core modules contain no Flue import (C-3 verified by inspection/test).
5. Open assumption **A-1** (Flue tool API) — RESOLVED against `@flue/runtime`
   v1.0.0-beta.1; the adapter and docs reflect the real `defineTool`/`init`
   contract.
