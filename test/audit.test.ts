import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryAuditLog,
  HashChainAuditLog,
  verifyChain,
  hashEntry,
  GENESIS_HASH,
  type AuditEntry,
  type AuditInput,
} from "../src/audit.js";

function sample(tool: string): AuditInput {
  return {
    actorId: "a1",
    tenantId: "acme",
    tool,
    decision: "allow",
    outcome: "success",
    requestedScopes: ["customer:c-1"],
    args: { customerId: "c-1" },
  };
}

test("appends form a valid chain from genesis", async () => {
  const log = new InMemoryAuditLog();
  const e0 = await log.append(sample("lookup"));
  const e1 = await log.append(sample("refund"));
  assert.equal(e0.seq, 0);
  assert.equal(e0.prevHash, GENESIS_HASH);
  assert.equal(e1.prevHash, e0.hash);
  assert.deepEqual(await verifyChain(await log.entries()), { valid: true });
});

test("mutating a historical entry breaks verification at that seq", async () => {
  const log = new InMemoryAuditLog();
  await log.append(sample("lookup"));
  await log.append(sample("refund"));
  await log.append(sample("close"));
  const entries = await log.entries();

  // Tamper with the middle record's content.
  (entries[1] as AuditEntry).args = { customerId: "c-999" };

  const result = await verifyChain(entries);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
});

test("hashing is independent of object key order (canonical)", async () => {
  const a = await hashEntry({
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    prevHash: GENESIS_HASH,
    actorId: "a1",
    tenantId: "acme",
    tool: "refund",
    decision: "allow",
    outcome: "success",
    requestedScopes: ["customer:c-1"],
    args: { a: 1, b: 2 },
  });
  const b = await hashEntry({
    args: { b: 2, a: 1 },
    requestedScopes: ["customer:c-1"],
    outcome: "success",
    decision: "allow",
    tool: "refund",
    tenantId: "acme",
    actorId: "a1",
    prevHash: GENESIS_HASH,
    ts: "2026-01-01T00:00:00.000Z",
    seq: 0,
  });
  assert.equal(a, b);
});

test("file-backed log persists and reseeds the chain on reopen", async () => {
  const path = join(tmpdir(), `audit-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const log1 = new HashChainAuditLog({ path });
    await log1.append(sample("lookup"));
    const last = await log1.append(sample("refund"));

    // Reopen: new instance must continue the chain, not restart it.
    const log2 = new HashChainAuditLog({ path });
    const next = await log2.append(sample("close"));
    assert.equal(next.seq, 2);
    assert.equal(next.prevHash, last.hash);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(await verifyChain(await log2.entries()), { valid: true });
  } finally {
    rmSync(path, { force: true });
  }
});

test("hmac-keyed chain verifies only with the correct key", async () => {
  const log = new InMemoryAuditLog({ hmacKey: "k-secret" });
  await log.append(sample("lookup"));
  await log.append(sample("refund"));
  const entries = await log.entries();

  assert.deepEqual(await verifyChain(entries, "k-secret"), { valid: true });
  // Without the key, or with the wrong key, verification fails at the start.
  assert.equal((await verifyChain(entries, "wrong-key")).valid, false);
  assert.equal((await verifyChain(entries)).valid, false);
  // The log's own verify() uses its configured key.
  assert.deepEqual(await log.verify(), { valid: true });
});

test("hmac-keyed file log reseeds and stays verifiable across reopen", async () => {
  const path = join(tmpdir(), `audit-hmac-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const log1 = new HashChainAuditLog({ path, hmacKey: "k1" });
    await log1.append(sample("lookup"));
    const last = await log1.append(sample("refund"));

    const log2 = new HashChainAuditLog({ path, hmacKey: "k1" });
    const next = await log2.append(sample("close"));
    assert.equal(next.prevHash, last.hash);
    assert.deepEqual(await log2.verify(), { valid: true });
  } finally {
    rmSync(path, { force: true });
  }
});

test("records carry replay and error outcomes", async () => {
  const log = new InMemoryAuditLog();
  const replayed = await log.append({
    ...sample("refund"),
    outcome: "replayed",
    result: { ok: true },
  });
  const denied = await log.append({
    ...sample("refund"),
    decision: "deny",
    outcome: "denied",
    error: "scope_violation",
  });
  assert.equal(replayed.outcome, "replayed");
  assert.equal(denied.decision, "deny");
  assert.equal(denied.error, "scope_violation");
});
