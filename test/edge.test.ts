/**
 * Edge-runtime support: Web Crypto hashing (for Cloudflare Workers etc. where
 * node:crypto / the filesystem aren't available) and the reference D1 / KV
 * adapters. Web Crypto is available in Node, so these run in the normal suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryAuditLog,
  hashEntry,
  verifyChain,
  GENESIS_HASH,
  type AuditEntry,
  type AuditEntryBody,
} from "./_all.js";
import {
  D1AuditLog,
  KvIdempotencyStore,
  type D1Like,
  type D1StatementLike,
  type KvLike,
} from "../examples/cloudflare-adapters.js";

const body = (seq: number, prevHash: string): AuditEntryBody => ({
  seq,
  ts: "2026-06-17T00:00:00.000Z",
  prevHash,
  actorId: "a1",
  tenantId: "acme",
  tool: "reset_password",
  decision: "allow",
  outcome: "success",
  requestedScopes: ["account:a1"],
});

test("Web Crypto hashing is deterministic; HMAC diverges by key", async () => {
  const b = body(0, GENESIS_HASH);
  // SHA-256 hex is 64 chars and stable across calls.
  const h = await hashEntry(b);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await hashEntry(b), h);
  // Keyed (HMAC) differs from unkeyed, and different keys diverge.
  assert.notEqual(await hashEntry(b, "secret-key"), h);
  assert.notEqual(await hashEntry(b, "k1"), await hashEntry(b, "k2"));
});

test("verifyChain validates a chain and detects tampering", async () => {
  const log = new InMemoryAuditLog();
  await log.append(body(0, GENESIS_HASH));
  await log.append(body(1, GENESIS_HASH));
  await log.append(body(2, GENESIS_HASH));
  const entries = await log.entries();
  assert.deepEqual(await verifyChain(entries), { valid: true });

  (entries[1] as AuditEntry).actorId = "intruder";
  const result = await verifyChain(entries);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
});

// --- a tiny in-memory fake D1 ------------------------------------------------

function fakeD1(): D1Like & { rows: Array<{ seq: number; hash: string; entry: string }> } {
  const rows: Array<{ seq: number; hash: string; entry: string }> = [];
  const stmt = (sql: string, binds: unknown[] = []): D1StatementLike => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    run: async () => {
      if (sql.startsWith("INSERT")) {
        const [seq, hash, entry] = binds as [number, string, string];
        rows.push({ seq, hash, entry });
      }
      return {};
    },
    all: async <T>() => ({
      results: [...rows].sort((a, b) => a.seq - b.seq).map((r) => ({ entry: r.entry })) as T[],
    }),
    first: async <T>() => {
      if (rows.length === 0) return null;
      const head = [...rows].sort((a, b) => b.seq - a.seq)[0]!;
      return { seq: head.seq, hash: head.hash } as T;
    },
  });
  return { prepare: (sql: string) => stmt(sql), rows };
}

test("D1AuditLog builds a verifiable hash chain and catches tampering", async () => {
  const db = fakeD1();
  const log = new D1AuditLog(db, "edge-key");
  await log.append(body(0, GENESIS_HASH));
  await log.append(body(0, GENESIS_HASH));
  await log.append(body(0, GENESIS_HASH));

  const entries = await log.entries();
  assert.deepEqual(
    entries.map((e) => e.seq),
    [0, 1, 2],
  );
  assert.deepEqual(await log.verify(), { valid: true });

  // Tamper with a stored row -> verification fails (and needs the right key).
  const victim = db.rows.find((r) => r.seq === 1)!;
  const parsed = JSON.parse(victim.entry) as AuditEntry;
  parsed.actorId = "intruder";
  victim.entry = JSON.stringify(parsed);

  const result = await log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
});

// --- a tiny in-memory fake KV ------------------------------------------------

function fakeKv(): KvLike {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  };
}

test("KvIdempotencyStore: start, replay, in-flight, fail, tenant isolation", async () => {
  const now = 1000;
  const store = new KvIdempotencyStore(fakeKv(), () => now);

  assert.equal((await store.begin("acme", "k1")).status, "started");
  // Concurrent begin sees in-flight.
  assert.equal((await store.begin("acme", "k1")).status, "in_flight");

  await store.complete("acme", "k1", { ok: true });
  const replay = await store.begin("acme", "k1");
  assert.equal(replay.status, "replay");
  if (replay.status === "replay") assert.deepEqual(replay.record.result, { ok: true });

  // Same key under a different tenant is independent.
  assert.equal((await store.begin("globex", "k1")).status, "started");
});

test("KvIdempotencyStore: fail releases the key, TTL expiry re-opens it", async () => {
  let now = 0;
  const store = new KvIdempotencyStore(fakeKv(), () => now);

  await store.begin("acme", "kf");
  await store.fail("acme", "kf");
  assert.equal((await store.begin("acme", "kf")).status, "started");

  await store.complete("acme", "kf", 1);
  await store.begin("acme", "kt", 100);
  await store.complete("acme", "kt", 1);
  now = 50;
  assert.equal((await store.begin("acme", "kt", 100)).status, "replay");
  now = 200; // past TTL
  assert.equal((await store.begin("acme", "kt", 100)).status, "started");
});
