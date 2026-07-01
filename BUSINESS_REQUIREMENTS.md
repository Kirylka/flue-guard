# flue-guard — Business Requirements

**Status:** Draft v0.1 (requirements only — no implementation)
**Last updated:** 2026-06-17
**Owner:** Kirylka

---

## 1. One-liner

> Open-source, in-process governance for Flue tools: tenant-scoped execution,
> idempotent external writes, and tamper-evident audit logs.

---

## 2. Product vision

[Flue](https://github.com/badlogic/flue) is a sandbox agent framework. It
already gives agents a real harness: tools, skills, sessions, sandboxing, MCP
runtime adapters, workflows, and observability adapters. It can constrain
*runtime* access and make tools callable only in specific harness states.

`flue-guard` is **not** a competing harness and **not** a fix for a
Flue deficiency. It is a small, Flue-native library that adds an
**application-level governance layer** around tools that cause real-world side
effects — refunds, appointments, account changes, ticket updates.

The split we are building to:

| Layer | Controls |
| --- | --- |
| **Flue** | *What* the agent can do in a harness / session / state |
| **flue-guard** | *Who* may do it, *for which tenant*, with *what side-effect guarantee* |

**Architecture sentence (use verbatim in pitches):**

> Flue can gate tools by harness state. `flue-guard` gates side effects
> by identity, tenant scope, idempotency policy, and audit guarantees.

---

## 3. Problem statement

Flue gives agents powerful tools and sandboxed execution. But when tools create
real-world side effects, teams still need guarantees that live in the
*application*, not the sandbox:

1. **No trusted identity at the tool boundary.** The model controls a tool's
   arguments. Nothing stops a confused or manipulated agent from acting on the
   wrong customer or the wrong tenant. Harness state alone does not encode
   *who* the run is for.
2. **No multi-tenant isolation guarantee.** A single deployment serving many
   tenants needs a hard guarantee that an agent acting for tenant A can never
   touch tenant B's resources, regardless of what the model decides.
3. **No idempotency for external writes.** Agents retry and re-plan. Without an
   idempotency contract, a single logical action (one refund) can fire multiple
   times.
4. **No tamper-evident record.** Regulated and high-trust workflows need an
   audit trail that can be shown to have not been altered after the fact.

These are application-level guarantees. They belong next to the tool, in the
team's own process — not bolted on by routing every tool call through an
external platform.

---

## 4. Positioning & competitive wedge

- **vs. Flue itself:** Complementary, not corrective. Flue owns the harness;
  this owns side-effect governance inside it.
- **vs. TrueFoundry (and similar managed control planes/gateways):**
  TrueFoundry is a managed control plane that routes tool execution and adds
  governance, approvals, and PII/PHI guardrails at the platform layer. Our
  wedge is the opposite shape: *a small OSS, Flue-native, in-process library for
  teams that want governance inside their own harness without routing tool
  execution through an external platform.*
- **vs. OpenAI Agents SDK approval/human-in-the-loop:** Approval gates are
  becoming a standard primitive (pause, interrupt, resume after approval). We
  therefore treat **approval as a supporting adapter, not the hero**. The hero
  is the combination of trusted tenant scope + idempotency + tamper-evident
  audit, which these SDKs do not provide as a packaged guarantee.

---

## 5. Target users

- **Primary:** Teams building production, customer-facing agents on Flue in
  **multi-tenant B2B SaaS** where tools take real actions (support, billing,
  scheduling, account management).
- **Secondary:** Solo developers and small teams who want sane side-effect
  defaults (idempotent writes, an audit trail) without adopting a platform.
- **Influencers:** Security / compliance reviewers who must sign off on what an
  agent is allowed to do and on the integrity of its audit record.

---

## 6. Goals and non-goals

### Goals
- Make it trivial to wrap a Flue tool so that every side-effectful call is
  bound to a **trusted, harness-injected context** the model cannot forge.
- Guarantee **tenant/scope isolation** at the tool boundary.
- Guarantee **at-most-once** external writes per logical operation.
- Produce a **tamper-evident** audit trail that can be independently verified.
- Stay **in-process, Flue-native, and small** — no external services required.
- Be **open source** under the most permissive practical license (**MIT**).

### Non-goals (v0.1)
- Not a managed control plane, gateway, or hosted service.
- Not a replacement for Flue's sandbox, sessions, or harness-state gating.
- Not a full IAM/policy engine — RBAC is a thin adapter, not a product.
- Not a human-approval workflow product — approval is an adapter seam.
- Not a distributed, multi-region idempotency/audit backend (pluggable later).

---

## 7. Business requirements

### Lead capabilities (the hero)

| ID | Requirement |
| --- | --- |
| **BR-1** | **Tenant-scope enforcement.** Every governed tool call is evaluated against a trusted context (actor, tenant, allowed resource scopes) that originates from the harness/host, never from model output. Calls targeting resources outside the actor's allowed scope are denied. |
| **BR-2** | **Idempotency for external writes.** A tool that causes an external side effect can declare an idempotency policy so the underlying action runs at most once per logical operation; subsequent calls replay the recorded result. |
| **BR-3** | **Tamper-evident audit trail.** Every governed call appends an immutable, chained record (decision + outcome) whose integrity can be independently verified, so undetected after-the-fact edits are not possible. |

### Supporting capabilities

| ID | Requirement |
| --- | --- |
| **BR-4** | **RBAC** — basic role checks on tools via a swappable adapter. |
| **BR-5** | **Approval adapters** — a tool can require approval, delegating the decision to the team's own workflow; fail-closed when unconfigured. |
| **BR-6** | **PII redaction hooks** — redact sensitive data before it reaches the audit trail, without altering execution. |
| **BR-7** | **Policy-provider integration** — adapters (RBAC/approval/redaction) are pluggable so teams can delegate to an external policy provider if they choose. |

---

## 8. MVP scope (v0.1)

**In scope:**
- `defineGovernedTool()` — wraps a tool with governance, emitting a
  Flue-compatible tool.
- Trusted context injection — a safe way to bind actor/tenant/scope to a run.
- Tenant/customer **scope enforcement** (BR-1).
- An **idempotency store** for external writes (BR-2).
- A **hash-chained JSONL audit log** (BR-3).
- A worked **example: support agent** demonstrating an `authorize` ownership
  block (the Meta HTS case), scope enforcement, an idempotent refund, and
  audit-chain verification.

RBAC (BR-4) and approvals (BR-5) ship as **basic adapters**, not headline
features.

**Out of scope for v0.1:** distributed stores, a hosted dashboard, non-JS
runtimes, a formal policy DSL.

---

## 9. Success criteria

- A Flue developer can wrap an existing tool and get BR-1/2/3 with only a few
  lines of configuration.
- The example demonstrably **blocks** an unauthorized account action and a
  cross-customer action, **replays** a duplicate refund instead of re-issuing it, and **verifies** its
  audit chain.
- Tampering with any historical audit entry is detectable.
- Positioning lands: readers understand this is in-process and Flue-native, not
  a platform — and why that is the wedge versus managed control planes.

---

## 10. Assumptions, dependencies, risks

- **Assumption (CONFIRMED):** Flue (`@flue/runtime` v1.0.0-beta.1) defines tools
  via `defineTool({ name, description, parameters, execute })` and accepts them
  in `init({ tools })`, so a wrapper integrates without forking Flue. Verified
  against the live API on 2026-06-17.
- **Dependency:** Node.js runtime primitives only for the MVP (no external
  services), to honor the "in-process" promise.
- **Risk — Flue adds native governance:** Keep the wedge narrow (side-effect
  guarantees + tamper-evidence) and stay complementary.
- **Risk — "why not TrueFoundry/OpenAI SDK?":** Answer is the in-process,
  no-external-routing posture; keep approvals as an adapter, not the pitch.
- **Risk — Flue API drift:** Isolate the Flue-specific adapter so core
  governance stays framework-agnostic.

---

## 11. Open questions

1. License — **decided: MIT** (most permissive, widely trusted).
2. Flue tool/`init` API shape — **resolved**: `@flue/runtime` `defineTool` +
   `init({ tools })`, Valibot/TypeBox `parameters`, `execute(args)`.
3. Naming: `flue-guard` (current pick) vs. `flue-tool-governance` /
   `flue-side-effect-guard` / `flue-enterprise-toolkit`.
4. Is the first published artifact the **library**, an **article** explaining
   the wedge, or both together?
