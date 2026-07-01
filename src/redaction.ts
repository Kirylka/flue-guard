/**
 * PII redaction hooks for the audit trail.
 *
 * Redaction is applied only to what gets *written to the audit log* — never to
 * the arguments the real handler executes with. The default redactor masks a
 * few common PII shapes (emails, long digit runs that look like card/account
 * numbers) and a configurable set of sensitive field names.
 *
 * Redaction is intentionally a pluggable seam. For deeper coverage, plug in a
 * dedicated string-based PII library via {@link textRedactor} — e.g.
 * OpenRedaction or @redactpii/node — without adding a hard dependency here.
 */

/** Transforms a value before it is recorded in the audit log. */
export type Redactor = (value: unknown) => unknown;

const SENSITIVE_FIELDS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "ssn",
  "cardnumber",
  "card_number",
  "cvv",
  "pin",
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGITS_RE = /\b\d[\d -]{10,}\d\b/g;

function maskString(value: string): string {
  return value
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(LONG_DIGITS_RE, "[redacted-number]");
}

/**
 * Build a structural redactor: mask the given field names (case-insensitive)
 * and apply `transformString` to every string value, recursing into objects
 * and arrays. The input is never mutated.
 */
/** Cap recursion so a pathologically deep value can't overflow the stack. */
const MAX_DEPTH = 100;

function makeWalker(
  blocked: Set<string>,
  transformString: (s: string) => string,
): Redactor {
  // Track the objects on the current path so a circular structure becomes a
  // `[Circular]` marker instead of recursing until the stack overflows; cap
  // depth for the same reason.
  const walk = (value: unknown, seen: WeakSet<object>, depth: number): unknown => {
    if (typeof value === "string") return transformString(value);
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      if (depth >= MAX_DEPTH) return "[Depth limit exceeded]";
      seen.add(value);
      let out: unknown;
      if (Array.isArray(value)) {
        out = value.map((v) => walk(v, seen, depth + 1));
      } else {
        const obj: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          const next = blocked.has(key.toLowerCase())
            ? "[redacted]"
            : walk(val, seen, depth + 1);
          // `obj["__proto__"] = …` would set the prototype, not an own key, so
          // the field would vanish from the receipt (and could pollute). Define
          // it as a plain own data property instead.
          if (key === "__proto__") {
            Object.defineProperty(obj, key, {
              value: next,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          } else {
            obj[key] = next;
          }
        }
        out = obj;
      }
      seen.delete(value);
      return out;
    }
    return value;
  };
  return (value) => walk(value, new WeakSet(), 0);
}

function fieldSet(fields: Iterable<string>): Set<string> {
  return new Set([...fields].map((f) => f.toLowerCase()));
}

/**
 * Build a redactor that masks the given field names (case-insensitive) and,
 * by default, also masks emails and long digit sequences inside strings.
 */
export function redactFields(
  fields: Iterable<string> = SENSITIVE_FIELDS,
  options: { maskStrings?: boolean } = {},
): Redactor {
  const maskStrings = options.maskStrings ?? true;
  return makeWalker(fieldSet(fields), maskStrings ? maskString : (s) => s);
}

/**
 * Adapt an external, string-based PII redactor (e.g. OpenRedaction or
 * @redactpii/node) into a {@link Redactor} that walks objects/arrays and also
 * masks sensitive field names. Lets you use a richer redaction engine without
 * this package taking a dependency on it.
 *
 * ```ts
 * import { redactString } from "@redactpii/node";
 * const redaction = textRedactor((s) => redactString(s));
 * ```
 */
export function textRedactor(
  transform: (text: string) => string,
  options: { fields?: Iterable<string> } = {},
): Redactor {
  return makeWalker(fieldSet(options.fields ?? SENSITIVE_FIELDS), transform);
}

/** Compose redactors so they run left to right. */
export function composeRedactors(...redactors: Redactor[]): Redactor {
  return (value) => redactors.reduce((acc, r) => r(acc), value);
}

/** The default redactor: masks common sensitive field names and PII strings. */
export const defaultRedactor: Redactor = redactFields();

/** A redactor that changes nothing. */
export const identityRedactor: Redactor = (value) => value;
