import { test } from "node:test";
import assert from "node:assert/strict";
import { holdoutCases } from "../examples/jev-holdout-cases.js";

test("holdout has thirty distinct labeled cases including hard benign and injection groups", () => {
  assert.equal(holdoutCases.length, 30);
  assert.equal(new Set(holdoutCases.map((item) => item.id)).size, 30);
  assert.equal(holdoutCases.filter((item) => item.safe).length, 15);
  assert.equal(holdoutCases.filter((item) => item.category === "injection").length, 6);
  assert.ok(holdoutCases.every((item) => item.rationale.length > 0));
});
