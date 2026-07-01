# Architecture

← [Back to the README](../README.md)

## How it fits together

The pieces stack. Identity is established once, up top, by something that already
knows who the human is; it flows down into the trusted context, and every tool
call is decided against it.

```mermaid
flowchart TB
  idp["🔐 <b>Identity provider</b><br/>Okta · Entra · Anthropic Enterprise-Managed Auth<br/><i>verifies the human, brokers credentials</i>"]
  harness["🧩 <b>Your request · the Flue harness</b><br/>maps identity → TrustedContext, binds it for the turn<br/>gov.run(...) · gov.withContext(...)"]
  model(["🤖 Model"])
  gov["🛡️ <b>Governed tool — this library</b><br/>validate → RBAC → scope → authorize → approval → idempotency → execute"]
  audit["🧾 <b>Tamper-evident audit</b><br/>hash-chained JSONL · D1 · your own sink"]
  sub["☁️ <b>Substrate</b> — Cloudflare · Vercel · your cloud<br/><i>egress allowlists · credential brokering · sandbox isolation</i>"]

  idp -->|"verified identity + groups"| harness
  harness -->|"TrustedContext — the model can't read or set it"| gov
  model -->|"arguments (untrusted)"| gov
  gov -->|"every decision, hash-chained"| audit
  sub -.->|"contains primitive tools — attested here, enforced below"| gov

  classDef ours fill:#dcfce7,stroke:#16a34a,color:#052e16;
  classDef ext fill:#f1f5f9,stroke:#94a3b8,color:#0f172a;
  class gov,audit ours;
  class idp,harness,model,sub ext;
```

The two green boxes are what this library owns: the per-call decision and the
record of it. Everything around them — the identity above, the substrate
below — is the platform's job. Notably, the **substrate** is what actually
*contains* a "primitive" tool (egress allowlists, credential brokering,
isolation); this library attests to that containment and flags it (see
[scoped tools vs primitives](./guide.md#scoped-tools-vs-general-primitives)),
but doesn't enforce it.

## Identity comes from the harness, never the model

The top box is not part of this library, and that's the point. Whatever already
authenticates your users — Okta or Entra groups, or Anthropic's
Enterprise-Managed Auth provisioning the connection through your IdP — is the
source of truth for *who the caller is*. You map its verified claims into the
trusted context once, at the start of the turn, and the model never gets a say
in it:

```ts
// Map your IdP's verified claims into the trusted context. None of this
// comes from the conversation — the model can't read it and can't set it.
await gov.run(
  {
    actor: {
      id: session.user.sub,         // verified subject
      roles: session.user.groups,   // Okta / Entra groups → roles
    },
    tenantId: session.org.id,
    scopes: session.entitlements,    // coarse grants the IdP already knows
  },
  () => harness.prompt(userMessage),
);
```

An IdP gives you coarse identity: *this person is in the `account_admin` group*.
That maps straight onto RBAC — `requireRoles: ["account_admin"]` checks a group
before the tool runs. What an IdP group *can't* express is the per-call question
that bit Meta: "does this admin control *this specific account*?" That's the
authorization and the audit this library adds on top of the identity the harness
already established — the part the IdP can't see and the model shouldn't decide.

---

Next: [Guide](./guide.md) — `authorize` vs `scope`, scoped tools vs primitives,
binding context, and approval.
