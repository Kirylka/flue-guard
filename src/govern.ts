/**
 * The golden-path factory.
 *
 * `govern(...)` is `createGovernedToolkit(...)` with Flue's `defineTool` wired
 * in for you, so `gov.tool(...)` returns a ready-to-use Flue tool with nothing
 * to inject:
 *
 * ```ts
 * import { govern, caller } from "flue-guard";
 *
 * const gov = govern({ audit: "audit.jsonl" });
 * const reset = gov.tool({ ... authorize: caller(...) ... });
 * ```
 *
 * This is the one place the package imports `@flue/runtime` (a peer
 * dependency). If you need a Flue-free / runtime-agnostic core — e.g. to inject
 * a different `defineTool`, or to build tools in a non-Flue host — use
 * {@link createGovernedToolkit} directly and pass `defineTool` yourself.
 */

import { defineTool } from "@flue/runtime";
import {
  createGovernedToolkit,
  type FlueDefineTool,
  type GovernedToolkit,
  type GovernedToolkitOptions,
} from "./toolkit.js";

/** {@link GovernedToolkitOptions} without `defineTool` — `govern` supplies it. */
export type GovernOptions = Omit<GovernedToolkitOptions, "defineTool">;

/**
 * Create a governed toolkit with Flue's `defineTool` already wired in. See
 * {@link createGovernedToolkit} for the full option set (everything except
 * `defineTool`, which this provides).
 */
export function govern(options: GovernOptions): GovernedToolkit {
  // Flue's generic `defineTool` is structurally compatible with the injected
  // `FlueDefineTool` seam (proven by the live spike); the cast just bridges the
  // generic signature to the non-generic injection point.
  return createGovernedToolkit({
    ...options,
    defineTool: defineTool as unknown as FlueDefineTool,
  });
}
