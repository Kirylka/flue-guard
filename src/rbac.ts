/**
 * Role-based access control adapter (a supporting feature, not the hero).
 *
 * The default adapter checks a tool's `requireRoles` against the roles on the
 * trusted context, with any-of semantics. Swap in a custom adapter to delegate
 * to an external policy provider (e.g. OPA, a permissions service).
 */

import type { TrustedContext } from "./types.js";

export interface RbacRequest {
  tool: string;
  /** Roles the tool declared as required (any-of). Empty means unrestricted. */
  requiredRoles: string[];
  ctx: TrustedContext;
}

export interface RbacAdapter {
  can(request: RbacRequest): boolean | Promise<boolean>;
}

/** Any-of check against `ctx.actor.roles`. */
export const defaultRbac: RbacAdapter = {
  can({ requiredRoles, ctx }) {
    if (requiredRoles.length === 0) return true;
    return requiredRoles.some((role) => ctx.actor.roles.includes(role));
  },
};
