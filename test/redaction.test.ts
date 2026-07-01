import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeRedactors,
  defaultRedactor,
  identityRedactor,
  redactFields,
  textRedactor,
} from "../src/redaction.js";

test("default redactor masks sensitive field names", () => {
  const out = defaultRedactor({ password: "hunter2", note: "ok" }) as Record<
    string,
    unknown
  >;
  assert.equal(out.password, "[redacted]");
  assert.equal(out.note, "ok");
});

test("default redactor masks emails and long digit runs in strings", () => {
  const out = defaultRedactor({
    msg: "reach me at jane@acme.io or 4111 1111 1111 1111",
  }) as { msg: string };
  assert.ok(out.msg.includes("[redacted-email]"));
  assert.ok(out.msg.includes("[redacted-number]"));
});

test("redaction recurses into nested objects and arrays", () => {
  const out = defaultRedactor({
    items: [{ token: "abc" }, { ok: 1 }],
  }) as { items: Array<Record<string, unknown>> };
  assert.equal(out.items[0]!.token, "[redacted]");
  assert.equal(out.items[1]!.ok, 1);
});

test("redaction does not mutate the input", () => {
  const input = { password: "x", nested: { ssn: "1" } };
  defaultRedactor(input);
  assert.equal(input.password, "x");
  assert.equal(input.nested.ssn, "1");
});

test("redactFields accepts custom field names", () => {
  const r = redactFields(["customField"], { maskStrings: false });
  const out = r({ customField: "secret", email: "a@b.com" }) as Record<
    string,
    unknown
  >;
  assert.equal(out.customField, "[redacted]");
  // maskStrings disabled -> email left intact
  assert.equal(out.email, "a@b.com");
});

test("identityRedactor returns value unchanged", () => {
  const v = { password: "x" };
  assert.equal(identityRedactor(v), v);
});

test("textRedactor plugs in an external string redactor and masks fields", () => {
  // Simulate an external lib (OpenRedaction / @redactpii/node) that redacts text.
  const external = (s: string) => s.replace(/secret/gi, "[PII]");
  const r = textRedactor(external);
  const out = r({ note: "top secret", token: "abc", n: 5 }) as {
    note: string;
    token: string;
    n: number;
  };
  assert.equal(out.note, "top [PII]");
  assert.equal(out.token, "[redacted]"); // sensitive field name still masked
  assert.equal(out.n, 5);
});

test("composeRedactors applies redactors left to right", () => {
  const r = composeRedactors(
    redactFields(["a"], { maskStrings: false }),
    redactFields(["b"], { maskStrings: false }),
  );
  const out = r({ a: "1", b: "2", c: "3" }) as Record<string, unknown>;
  assert.equal(out.a, "[redacted]");
  assert.equal(out.b, "[redacted]");
  assert.equal(out.c, "3");
});
