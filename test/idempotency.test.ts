import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryIdempotencyStore } from "../src/idempotency.js";

test("first begin starts; completed key replays the stored result", async () => {
  const store = new InMemoryIdempotencyStore();
  const first = await store.begin("acme", "k1");
  assert.equal(first.status, "started");

  await store.complete("acme", "k1", { refundId: "r-1" });

  const second = await store.begin("acme", "k1");
  assert.equal(second.status, "replay");
  if (second.status === "replay") {
    assert.deepEqual(second.record.result, { refundId: "r-1" });
  }
});

test("an in-flight key reports in_flight to a concurrent caller", async () => {
  const store = new InMemoryIdempotencyStore();
  await store.begin("acme", "k1");
  const concurrent = await store.begin("acme", "k1");
  assert.equal(concurrent.status, "in_flight");
});

test("fail() releases the key for retry", async () => {
  const store = new InMemoryIdempotencyStore();
  await store.begin("acme", "k1");
  await store.fail("acme", "k1");
  const retry = await store.begin("acme", "k1");
  assert.equal(retry.status, "started");
});

test("keys are namespaced by tenant", async () => {
  const store = new InMemoryIdempotencyStore();
  await store.begin("acme", "k1");
  await store.complete("acme", "k1", { v: 1 });
  // Same key under a different tenant must be independent.
  const other = await store.begin("globex", "k1");
  assert.equal(other.status, "started");
});

test("TTL expiry permits re-execution", async () => {
  let now = 1_000;
  const store = new InMemoryIdempotencyStore({ clock: () => now });
  await store.begin("acme", "k1", 100);
  await store.complete("acme", "k1", { v: 1 });

  now = 1_050; // within TTL
  assert.equal((await store.begin("acme", "k1", 100)).status, "replay");

  now = 1_200; // past TTL
  assert.equal((await store.begin("acme", "k1", 100)).status, "started");
});

test("get() inspects the current record", async () => {
  const store = new InMemoryIdempotencyStore();
  assert.equal(await store.get("acme", "k1"), undefined);
  await store.begin("acme", "k1");
  assert.equal((await store.get("acme", "k1"))?.status, "in_flight");
});
