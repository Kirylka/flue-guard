# Flue 1.0 readiness plan

**Status: maintainer playbook, not a site page.**

The peer range is deliberately `@flue/runtime >=1.0.0-beta.9 <1.0.0`: we only
admit versions the suite has actually run against, and 1.0.0 hasn't shipped.
That means the day Flue goes stable, every `npm install flue-guard` alongside
`@flue/runtime@1.0.0` starts failing peer resolution until we release. This
document is the plan for making that release a same-day, low-drama event.

## Why this is a small surface

Flue-coupled code is confined by design:

| Where | What it knows about Flue |
| --- | --- |
| `src/flue.ts` | The whole tool contract: `ToolDefinition` shape (`input`/`output`/`run`), the `run({ input, signal })` context, Valibot-only `input` schemas, JSON-plain results |
| `src/govern.ts` | One import: `defineTool` (injected into the runtime-agnostic core) |
| `test/flue-integration.test.ts`, `test/flue.test.ts` | Contract tests against the real runtime |
| `scripts/live-faux-spike.mjs` | A real dispatched agent turn, in-process, no network — exercises `@flue/runtime/internal` wiring and the dispatched-context path |

Everything else (`toolkit`, `audit`, `idempotency`, adapters) is
Flue-agnostic. If 1.0 changes the contract, the fix lands in `flue.ts` and
possibly the spike; the governance core should not move.

## Early warning (already automated)

`.github/workflows/flue-canary.yml` runs weekly and on demand: it installs
`@flue/runtime@latest` (and `@next`, allowed to fail — the tag may not
exist), **ignoring the peer pin**, then runs the full test suite and the
spike. A red `latest` leg means either 1.0 shipped or the beta line moved
under us — apply the checklist below before users hit it.

Watch specifically for these known-risk areas (they broke during the betas):

- `ToolDefinition` field changes (beta.3 replaced `parameters`/`execute` with
  `input`/`run`; `ToolLegacyDefinitionError` guards the old shape).
- The `input`-schema contract: today a tool without `input` gets **no model
  arguments at all**, which is why `toFlueTool` always emits one. If 1.0
  changes this, revisit `asFlueInput` and the passthrough schema.
- Valibot-only `input`: if 1.0 accepts Standard Schema broadly, the
  non-Valibot degradation documented in "Sharp edges" can likely be removed —
  a DX win worth a minor release of its own.
- The dispatched/addressable path: `run` still receiving no host context is
  what makes `ContextStore`/`withContext` the binding mechanism. If 1.0 adds
  a host context to `run`, consider a first-class resolver for it.

## Day-0 checklist (when 1.0.0 ships)

1. **Pin and run.** `npm install --no-save @flue/runtime@1.0.0`, then
   `npm test`, `npm run spike`, `npm run docs:check-samples`. Read the Flue
   changelog for anything touching tools, dispatch, or serialization.
2. **If green** (contract unchanged):
   - Widen the peer range to `">=1.0.0-beta.9 <2"` in `package.json`
     (keeps the tested beta line valid for existing users, admits 1.x).
   - Bump `devDependencies["@flue/runtime"]` to `^1.0.0` so CI tests stable.
   - Update the version line in `README.md` ("peer `@flue/runtime` …") and
     `docs/reference/entry-points.md`.
   - Release `0.2.0` (minor: the dependency contract changed), tag, let the
     release workflow publish. Announce in the release notes that flue-guard
     is 1.0-ready.
3. **If red** (contract moved):
   - Fix inside `src/flue.ts` (and the spike) only; add a contract test
     pinning the new behavior, as `test/flue-integration.test.ts` does for
     beta.3+.
   - If the new contract is incompatible with the betas, drop the beta range
     instead of straddling: peer `"^1.0.0"`, release `0.2.0`, note the
     breaking peer change prominently. Do not try to support both shapes in
     one adapter unless the difference is trivially detectable at runtime.
4. **Either way:** run the canary manually (`workflow_dispatch`) after
   releasing, so the next scheduled run starts from green.

## Standing rules

- The peer range only ever admits versions the suite has run against. Never
  widen it speculatively.
- Contract knowledge stays in `src/flue.ts`. If a fix wants to touch
  `toolkit.ts`, the abstraction is leaking — stop and rethink.
- Every contract change gets a dated note in the `src/flue.ts` header (it
  already carries the beta.3 and beta.9 history), so the adapter file remains
  the single narrative of "what Flue changed and how we absorbed it".
