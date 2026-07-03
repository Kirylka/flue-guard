/**
 * `flue-guard/d1` — the store-backed adapters, exercised against a real SQL
 * engine: a minimal D1-shaped binding over `node:sqlite`, so `ON CONFLICT`,
 * primary-key violations, and `changes` counts behave exactly as they do on
 * Cloudflare D1 (both are SQLite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  D1AuditLog,
  D1IdempotencyStore,
  auditTableSql,
  idempotencyTableSql,
  createGovernedToolkit,
  verifyChain,
  GovernanceConfigError,
  IdempotencyConflictError,
  type D1Like,
  type D1PreparedStatementLike,
  type AuditInput,
} from "./_all.js";

/** A D1-shaped binding over node:sqlite. */
function fakeD1(db: DatabaseSync): D1Like {
  const statement = (
    sql: string,
    params: unknown[],
  ): D1PreparedStatementLike => ({
    bind: (...values: unknown[]) => statement(sql, values),
    run: async () => {
      const info = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(info.changes) } };
    },
    first: async <T>() =>
      ((db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null),
    all: async <T>() => ({
      results: db.prepare(sql).all(...(params as never[])) as T[],
    }),
  });
  return { prepare: (sql) => statement(sql, []) };
}

function auditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    actorId: "a1",
    tenantId: "acme",
    tool: "issue_refund",
    decision: "allow",
    outcome: "success",
    requestedScopes: ["customer:c-1"],
    ...overrides,
  };
}

// --- D1AuditLog ---------------------------------------------------------------

test("D1AuditLog: appends chain from genesis and verify() passes", async () => {
  const db = fakeD1(new DatabaseSync(":memory:"));
  const log = new D1AuditLog({ db });
  await log.ensureSchema();

  const first = await log.append(auditInput());
  const second = await log.append(auditInput({ outcome: "error", error: "boom" }));

  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.equal(second.prevHash, first.hash);
  assert.deepEqual(await log.verify(), { valid: true });
});

test("D1AuditLog: two instances on one database interleave without forking the chain", async () => {
  // Two adapter instances (≈ two Workers isolates) sharing one database, each
  // unaware of the other's in-memory head — every cross-instance append loses
  // the seq race once and must recover by re-reading.
  const sqlite = new DatabaseSync(":memory:");
  const a = new D1AuditLog({ db: fakeD1(sqlite) });
  const b = new D1AuditLog({ db: fakeD1(sqlite) });
  await a.ensureSchema();

  for (let i = 0; i < 4; i++) {
    await a.append(auditInput({ requestId: `a-${i}` }));
    await b.append(auditInput({ requestId: `b-${i}` }));
  }

  const entries = await a.entries();
  assert.equal(entries.length, 8);
  assert.deepEqual(await verifyChain(entries), { valid: true });
});

test("D1AuditLog: concurrent same-instance appends serialize; hmac + tamper detection work", async () => {
  const db = fakeD1(new DatabaseSync(":memory:"));
  const log = new D1AuditLog({ db, hmacKey: "k1" });
  await log.ensureSchema();

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      log.append(auditInput({ requestId: `r-${i}` })),
    ),
  );
  assert.deepEqual(await log.verify(), { valid: true });

  // Verifying with the wrong key fails — the chain is keyed.
  const wrongKey = new D1AuditLog({ db, hmacKey: "other" });
  assert.equal((await wrongKey.verify()).valid, false);
});

test("D1AuditLog: tampering with a stored row breaks verification at that seq", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const log = new D1AuditLog({ db: fakeD1(sqlite) });
  await log.ensureSchema();
  await log.append(auditInput());
  await log.append(auditInput());
  await log.append(auditInput());

  // Rewrite entry #1 in place, directly in the table.
  const row = sqlite
    .prepare("SELECT entry FROM flue_guard_audit WHERE seq = 1")
    .get() as { entry: string };
  const tampered = JSON.parse(row.entry) as { actorId: string };
  tampered.actorId = "intruder";
  sqlite
    .prepare("UPDATE flue_guard_audit SET entry = ? WHERE seq = 1")
    .run(JSON.stringify(tampered));

  const result = await log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
});

test("D1AuditLog: rejects an empty hmacKey and a non-identifier table name", () => {
  const db = fakeD1(new DatabaseSync(":memory:"));
  assert.throws(() => new D1AuditLog({ db, hmacKey: "" }), GovernanceConfigError);
  assert.throws(
    () => new D1AuditLog({ db, table: "audit; DROP TABLE users" }),
    GovernanceConfigError,
  );
  assert.throws(() => auditTableSql("bad-name"), GovernanceConfigError);
  assert.throws(() => idempotencyTableSql("1bad"), GovernanceConfigError);
});

// --- D1IdempotencyStore --------------------------------------------------------

function makeStore(clock?: () => number) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(idempotencyTableSql());
  return {
    sqlite,
    store: new D1IdempotencyStore({ db: fakeD1(sqlite), clock }),
  };
}

test("D1IdempotencyStore: started → complete → replay with the stored result", async () => {
  const { store } = makeStore();

  assert.deepEqual(await store.begin("acme", "refund:r-1"), { status: "started" });
  await store.complete("acme", "refund:r-1", { refunded: 40 });

  const again = await store.begin("acme", "refund:r-1");
  assert.equal(again.status, "replay");
  assert.deepEqual(
    (again as { record: { result: unknown } }).record.result,
    { refunded: 40 },
  );
});

test("D1IdempotencyStore: an in-flight key refuses a second begin; fail() releases it", async () => {
  const { store } = makeStore();

  await store.begin("acme", "k");
  assert.equal((await store.begin("acme", "k")).status, "in_flight");

  await store.fail("acme", "k");
  assert.deepEqual(await store.begin("acme", "k"), { status: "started" });
});

test("D1IdempotencyStore: keys are tenant-namespaced", async () => {
  const { store } = makeStore();
  await store.begin("acme", "k");
  assert.deepEqual(await store.begin("globex", "k"), { status: "started" });
});

test("D1IdempotencyStore: a completed record expires by TTL and is retaken; in-flight never expires", async () => {
  let now = 1_000;
  const { store } = makeStore(() => now);

  await store.begin("acme", "k", 500);
  await store.complete("acme", "k", "v1");

  now = 1_400; // within TTL → replay
  assert.equal((await store.begin("acme", "k", 500)).status, "replay");

  now = 2_000; // past TTL → retaken
  assert.deepEqual(await store.begin("acme", "k", 500), { status: "started" });

  now = 999_999; // an in-flight claim NEVER expires by TTL
  assert.equal((await store.begin("acme", "k", 500)).status, "in_flight");
});

test("D1IdempotencyStore: concurrent begins elect exactly one winner", async () => {
  const { store } = makeStore();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.begin("acme", "race")),
  );
  assert.equal(results.filter((r) => r.status === "started").length, 1);
  assert.equal(results.filter((r) => r.status === "in_flight").length, 7);
});

// --- End to end through the governance pipeline --------------------------------

test("a governed tool runs end-to-end on D1 audit + idempotency", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = fakeD1(sqlite);
  const audit = new D1AuditLog({ db });
  const idempotencyStore = new D1IdempotencyStore({ db });
  await audit.ensureSchema();
  await idempotencyStore.ensureSchema();

  const toolkit = createGovernedToolkit({ audit, idempotencyStore });
  let executions = 0;
  const refund = toolkit.defineGovernedTool<{ customerId: string; refundId: string }>({
    name: "issue_refund",
    description: "refund a customer",
    sideEffect: true,
    scope: (a) => `customer:${a.customerId}`,
    idempotency: { key: (a) => `refund:${a.refundId}` },
    execute: (a) => {
      executions += 1;
      return { refunded: a.refundId };
    },
  });

  const ctx = {
    actor: { id: "u-1", roles: [] },
    tenantId: "acme",
    scopes: ["customer:*"],
  };
  const first = await toolkit.run(ctx, () =>
    refund.execute({ customerId: "c-1", refundId: "r-1" }),
  );
  const replayed = await toolkit.run(ctx, () =>
    refund.execute({ customerId: "c-1", refundId: "r-1" }),
  );

  assert.deepEqual(first, { refunded: "r-1" });
  assert.deepEqual(replayed, { refunded: "r-1" });
  assert.equal(executions, 1); // the duplicate replayed, it did not re-run

  // intent + success + replayed, all on a valid chain.
  const outcomes = (await audit.entries()).map((e) => e.outcome);
  assert.deepEqual(outcomes, ["executing", "success", "replayed"]);
  assert.deepEqual(await audit.verify(), { valid: true });

  // A second toolkit instance sharing the same D1 database refuses to re-run
  // an in-flight key from elsewhere (cross-instance at-most-once).
  await idempotencyStore.begin("acme", JSON.stringify(["issue_refund", "refund:r-9"]));
  await assert.rejects(
    () =>
      toolkit.run(ctx, () =>
        refund.execute({ customerId: "c-1", refundId: "r-9" }),
      ),
    IdempotencyConflictError,
  );
});
