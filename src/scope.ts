/**
 * Scope matching for tenant / resource isolation.
 *
 * A governed tool declares the scope(s) a given call will touch (derived from
 * its arguments and the trusted context). Those requested scopes are then
 * checked against the scopes the actor is actually allowed to touch. This is
 * the mechanism that stops an agent acting for tenant A from issuing a refund
 * against tenant B's customer, even if the model is convinced it should.
 *
 * Patterns support a single wildcard character `*`, which matches any run of
 * characters (including `:` and `/`). So `customer:*` matches `customer:c-1`,
 * and a bare `*` grants everything.
 */

/** Compile an allow-pattern into a matcher (literal except for `*`). */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** Does any `allowed` pattern match the concrete `requested` scope? */
export function scopeAllowed(requested: string, allowed: string[]): boolean {
  return allowed.some((pattern) =>
    pattern === requested ? true : patternToRegExp(pattern).test(requested),
  );
}

/** Normalize a scope declaration into a string array. */
export function normalizeScopes(
  scopes: string | string[] | undefined | null,
): string[] {
  if (scopes == null) return [];
  return Array.isArray(scopes) ? scopes : [scopes];
}

/**
 * Returns the subset of `requested` scopes that are NOT covered by `allowed`.
 * An empty array means the call is fully within scope.
 */
export function deniedScopes(requested: string[], allowed: string[]): string[] {
  return requested.filter((scope) => !scopeAllowed(scope, allowed));
}
