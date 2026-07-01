# Governance Manifest — Spec

**Status:** Design (not yet implemented). Depends on the declarative-anchor
change (§3) and the idempotency-guarantee self-report (§5).
**Slots beside:** `TECH_ARCHITECTURE.md`, `TASK_SPECS.md`.

---

## 1. What it is, and its honest ceiling

A `governance.manifest.json` is the **static, externally auditable** form of the
guarantee that today only fires at runtime (`GovernanceConfigError`). It lets an
auditor read **one JSON file + one green CI run** for an exact deployed commit,
instead of reading source or trusting "our runtime throws."

It **proves structural posture**: every side-effecting tool carries a
trusted-keyed gate of a declared kind, an idempotency guarantee, an egress
acknowledgement, and a stable parameter surface.

It **does not prove semantics**: it cannot know that `emailOnFile()` reads the
right column or that a `caller` anchor checks the right actor. Same boundary the
README already draws. The compliance framing must say *"the control exists and
is of shape X,"* never *"the control is correct."*

## 2. Why registry-driven, not a Vite hook

`flue build` is a Vite build graph, but `flue.config.ts` only exposes runtime
target / root / output — **no confirmed public Vite `plugins` passthrough**. So
emission is **not** hung on a `closeBundle` hook that may not exist. Instead each
`toolkit.tool(spec)` records a static descriptor in a module-level registry the
library owns; CI imports the agent modules and serializes it. (If Flue later
confirms a plugin passthrough, the same registry can be wrapped in a plugin for
nicer ergonomics — no schema change.)

## 3. The declarative anchor (prerequisite)

The manifest's `gate.authorize` is only trustworthy if the anchor is **declared,
not inferred from the closure.** This replaces the current arity guard and is the
strong form of the Tier-1 trusted-anchor fix.

```ts
// caller-keyed (authenticated actor)
authorize: { anchor: "caller", check: (a, ctx) => owns(ctx.actor.id, a.accountId) }

// record-keyed (anonymous recovery — keyed to a declared trusted source)
authorize: { anchor: { trustedSource: "accountEmail" },
             check: (a, src) => a.resetEmail === src }
```

Definition-time rule (honest and trivial): a **side-effecting `scoped` tool must
declare a non-arg anchor (`caller` or `trustedSource`) or a `scope`, else it does
not define.** There is no `"arg-only"` anchor — it can't be expressed, so the
manifest's `gate.authorize` is never `"arg-only"`. (Type-level branding to make
even `check` impossible to write arg-only is the Tier-3 upgrade; out of scope
here.)

## 4. Emission

```ts
// ci/emit-manifest.ts
import "../agents/support.ts";                 // importing registers each tool's descriptor
import { writeManifest } from "flue-guard/manifest";
await writeManifest("governance.manifest.json");
```

**Registration timing.** Descriptors are registered at **spec declaration**, and
none of the descriptor fields depend on bound runtime context. Two supported
shapes:

- **Module-scope tools** (recommended): `const t = toolkit.tool(spec)` at module
  top level registers on import. Works directly.
- **Dispatched pattern** (`bound.tool(spec)` inside `createAgent((ctx) => …)`):
  the tool is defined per-invocation, so it would not register on import alone.
  Declare the descriptor at module scope with `toolkit.declare(spec)` (registers
  the static descriptor without binding context); `withContext(…).tool(spec)`
  reuses it, deduped by `name` + `paramsDigest`. Mismatched duplicates (same
  name, different surface) are an emission error.

Run `emit-manifest` right after `flue build` in CI and commit the result.

## 5. Schema

```ts
type GovernanceManifest = {
  manifestVersion: 1;
  generatedAt: string;                 // not part of integrity
  toolkitVersion: string;
  flueRuntimeVersion: string | null;   // best-effort from @flue/runtime package.json
  target: "node" | "cloudflare" | null;
  tools: ToolDescriptor[];             // sorted by name
  integrity: string;                   // sha256 over canonicalized `tools` only
};

type ToolDescriptor = {
  name: string;
  kind: "scoped" | "primitive";
  sideEffect: boolean;
  egressControlled: boolean;           // attestation (see README); recorded, not verified
  gate: {
    scope: boolean;
    authorize: "caller" | "trustedSource" | "none";  // never "arg-only" — can't define
  };
  idempotency: { declared: boolean; guarantee: "none" | "at-most-once" | "exactly-once" };
  approval: boolean;
  redactedAudit: boolean;
  paramsDigest: string;                // detects tool-surface drift across builds
};
```

**`idempotency.guarantee`** is **self-reported by the configured store**, not
asserted by the manifest: the in-memory default reports `"at-most-once"`; a
Durable Object / Postgres atomic-claim store reports `"exactly-once"`; no store
on a tool that declares idempotency is an emission error. (`"exactly-once"`
becomes real only when the Tier-1 idempotency backends land.)

## 6. Canonicalization & integrity (pinned)

- **Canonical JSON** = recursive key-sort, arrays in order, `undefined` dropped
  — the same canonicalizer the audit chain uses.
- **`paramsDigest`** = `sha256(canonicalJSON(jsonSchema(parameters)))`, where
  `jsonSchema` is the JSON Schema Flue derives from the tool's `parameters`
  (Standard Schema → JSON Schema). This makes the digest stable across schema-
  library internals and detects added/removed/retyped fields.
- **`integrity`** = `sha256(canonicalJSON(tools))` with `tools` sorted by `name`.
  It deliberately excludes `generatedAt` and version fields so re-emission of the
  same toolset is byte-stable.

## 7. The single CI assertion

```bash
npx governed-tools assert governance.manifest.json [--policy policy.json]
```

Exits nonzero with the offending tool + reason. Three checks:

```ts
export function assertManifest(
  m: GovernanceManifest,
  committed?: GovernanceManifest,   // the manifest checked into the repo
  policy?: GovernancePolicy,
) {
  // 1. integrity — the file wasn't hand-edited
  if (recomputeIntegrity(m.tools) !== m.integrity) fail("integrity", "manifest tampered");

  // 2. invariant — every dangerous tool is actually governed
  for (const t of m.tools) {
    if (!t.sideEffect) continue;
    if (t.kind === "scoped" && t.gate.authorize === "none" && !t.gate.scope)
      fail(t.name, "side-effecting scoped tool has no trusted-keyed gate");
    if (t.kind === "primitive" && !t.egressControlled)
      fail(t.name, "side-effecting primitive not egress-controlled");
    if (t.idempotency.declared && t.idempotency.guarantee === "none")
      fail(t.name, "idempotency declared but no store backs it");
  }

  // 3. drift — committed manifest matches a fresh re-emit
  if (committed && committed.integrity !== m.integrity)
    fail("drift", "committed manifest is stale — re-emit and commit");

  // 4. optional policy overlay (§8)
  if (policy) assertPolicy(m, policy);
}
```

**Check 3 is what makes it a gate, not a snapshot.** CI re-emits and diffs
against the committed manifest; a tool added without re-running fails the build.
Without it, a stale manifest passes forever and the whole thing is theater.

## 8. Policy overlay (the compliance tie-in)

The PCI/PSD2/HIPAA story is a small declarative file layered on check 2 — the
passing CI log on the release commit *is* the evidence artifact for the control,
not a paragraph in a policy doc.

```json
{
  "policyVersion": 1,
  "rules": [
    {
      "id": "payments-approved-and-exactly-once",
      "match": { "namePattern": "refund|payout|transfer", "sideEffect": true },
      "require": { "approval": true, "idempotency.guarantee": "exactly-once" }
    },
    {
      "id": "all-side-effects-trusted-keyed",
      "match": { "sideEffect": true, "kind": "scoped" },
      "require": { "gate.authorize": ["caller", "trustedSource"] }
    },
    {
      "id": "sensitive-tools-redacted",
      "match": { "namePattern": "patient|ssn|card" },
      "require": { "redactedAudit": true }
    }
  ]
}
```

- `match`: any of `namePattern` (regex over `name`), `kind`, `sideEffect`.
- `require`: a map of descriptor paths to a required value or an allowed-set
  (array). Dotted paths address nested fields (`idempotency.guarantee`,
  `gate.authorize`). Every matched tool must satisfy every `require`, or the
  rule fails with `(rule.id, tool.name, path, expected, actual)`.

## 9. Non-goals

- Proving predicate correctness (semantics) — see §1.
- Enforcing egress/containment — that's the substrate's; `egressControlled` is a
  recorded attestation.
- Replacing the runtime `GovernanceConfigError` — the manifest is its static,
  auditable twin; both stay.

## 10. Build order

1. **Declarative anchor** (§3) — Tier-1 correctness *and* manifest prerequisite.
2. **Store guarantee self-report** (§5) — small `IdempotencyStore` field.
3. **Registry + `writeManifest` + `assert` CLI + policy overlay** (this doc).
