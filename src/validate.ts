/**
 * Turns the accepted `parameters` forms into one validation function.
 */

import type { ArgValidator, ParseValidator, StandardSchemaV1 } from "./types.js";

export function makeValidator<T>(v?: ArgValidator<T>): (input: unknown) => T | Promise<T> {
  if (!v) return (input) => input as T;
  // A Standard Schema (https://standardschema.dev). Valibot is the one vendor
  // NOT validated here: asFlueInput forwards genuine Valibot schemas to Flue as
  // the tool's `input`, so arguments arrive already parsed and re-validating
  // would double-apply transforms. Every other vendor gets Flue's passthrough
  // `input`, so the raw model arguments MUST be validated internally. This
  // branch must run before the function check: some libraries' schemas (e.g.
  // ArkType) are callable, and *calling* one returns its errors instead of
  // throwing — which would silently hand the errors object to the handler.
  const std = (v as { "~standard"?: StandardSchemaV1<T>["~standard"] })[
    "~standard"
  ];
  if (std && typeof std.validate === "function" && std.vendor !== "valibot") {
    return async (input) => {
      const result = (await std.validate(input)) as
        | { value: T; issues?: undefined }
        | { issues: ReadonlyArray<{ message: string }> };
      if (result.issues) {
        throw new Error(result.issues.map((i) => i.message).join("; "));
      }
      return result.value;
    };
  }
  if (typeof v === "function") return v as (input: unknown) => T;
  const maybeParse = (v as { parse?: unknown }).parse;
  if (typeof maybeParse === "function") {
    return (input) => (v as ParseValidator<T>).parse(input);
  }
  // Genuine Valibot: Flue validates it (see above). Any other opaque schema
  // object is passed through unchanged — nobody validates it, so prefer a
  // function, `{ parse }`, or Standard Schema form for internal validation.
  return (input) => input as T;
}
