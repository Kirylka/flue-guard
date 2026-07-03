/**
 * `flue-guard/d1` — store-backed adapters for Cloudflare D1 (or any
 * D1-shaped SQLite binding): a multi-instance-safe audit log and an
 * idempotency store with an atomic claim.
 *
 * These are the production counterparts of the single-process defaults:
 *
 *  - {@link HashChainAuditLog} (file) is single-writer; {@link D1AuditLog}
 *    is safe across instances — concurrent appends race on the `seq` primary
 *    key, the loser re-reads the head and retries, so the chain can bend but
 *    never fork.
 *  - {@link InMemoryIdempotencyStore} is process-local;
 *    {@link D1IdempotencyStore} claims a key with a single conditional
 *    `INSERT`, so two instances retrying the same operation cannot both win.
 *
 * The adapters are written against a minimal structural slice of the D1 API
 * ({@link D1Like}), so this module needs no Cloudflare types and any binding
 * with `prepare().bind().run()/first()/all()` semantics works — including a
 * test fake over plain SQLite. Hashing is Web Crypto, same as everywhere else
 * in the package, so it runs on Workers as-is.
 *
 * Schema: run {@link auditTableSql} / {@link idempotencyTableSql} in your D1
 * migrations, or call `ensureSchema()` on either adapter at startup.
 */

import {
  AppendQueue,
  GENESIS_HASH,
  sealEntry,
  verifyChain,
  type AuditEntry,
  type AuditEntryBody,
  type AuditInput,
  type AuditLog,
} from "./audit.js";
import type {
  BeginResult,
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "./idempotency.js";
import { GovernanceConfigError } from "./errors.js";

// --- The structural slice of D1 these adapters need -------------------------

/** A prepared statement: `bind` returns a bound copy, per the D1 contract. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

/** The slice of `D1Database` used here (satisfied by the real binding). */
export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;
}

/**
 * Table names are interpolated into SQL (placeholders can't name a table), so
 * they must be plain identifiers — reject anything else at construction.
 */
function assertTableName(scope: string, table: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new GovernanceConfigError(
      scope,
      `Table name "${table}" must be a plain SQL identifier ` +
        "([A-Za-z_][A-Za-z0-9_]*).",
    );
  }
}

/** A `UNIQUE`/`PRIMARY KEY` violation — the signal that a writer lost a race. */
function isConstraintViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique|primary key|constraint/i.test(message);
}

// --- Audit log ---------------------------------------------------------------

export const DEFAULT_AUDIT_TABLE = "flue_guard_audit";

/** DDL for the audit table. Run it in a migration, or via `ensureSchema()`. */
export function auditTableSql(table: string = DEFAULT_AUDIT_TABLE): string {
  assertTableName("audit", table);
  return (
    `CREATE TABLE IF NOT EXISTS ${table} (` +
    "seq INTEGER PRIMARY KEY, " +
    "hash TEXT NOT NULL, " +
    "entry TEXT NOT NULL)"
  );
}

export interface D1AuditLogOptions {
  db: D1Like;
  /** Table name (a plain identifier). Defaults to {@link DEFAULT_AUDIT_TABLE}. */
  table?: string;
  /** HMAC key for keyed hashing (defends against full-log rewrites). */
  hmacKey?: string;
  /**
   * How many times an append re-reads the head and retries after losing a
   * `seq` race to a concurrent writer. Each retry only recomputes one hash, so
   * this bounds pathological contention, not normal operation. Default 5.
   */
  maxAppendRetries?: number;
}

/**
 * Hash-chained audit log in a D1 table — one row per {@link AuditEntry},
 * chained by `prevHash` exactly like the file log, verified by the same
 * {@link verifyChain}.
 *
 * **Multi-instance safe.** Every append reads the current head (`seq`,
 * `hash`) and inserts `seq + 1`, which is the primary key. Two concurrent
 * writers therefore race on the same `seq`: D1 rejects the second insert with
 * a constraint violation, and that writer re-reads the new head and retries
 * with the correct parent hash. The chain can never fork or skip — the
 * database's own uniqueness guarantee is the serialization point. Appends
 * from the *same* instance are additionally serialized in-process so they
 * don't waste retries racing each other.
 */
export class D1AuditLog implements AuditLog {
  private readonly db: D1Like;
  private readonly table: string;
  private readonly hmacKey?: string;
  private readonly maxAppendRetries: number;
  private readonly queue = new AppendQueue();

  constructor(options: D1AuditLogOptions) {
    assertTableName("audit", options.table ?? DEFAULT_AUDIT_TABLE);
    if (options.hmacKey === "") {
      throw new GovernanceConfigError(
        "audit",
        "hmacKey must be a non-empty string. Set a real key, or omit it for " +
          "unkeyed SHA-256 — an empty key is almost always an unset env var.",
      );
    }
    this.db = options.db;
    this.table = options.table ?? DEFAULT_AUDIT_TABLE;
    this.hmacKey = options.hmacKey;
    this.maxAppendRetries = options.maxAppendRetries ?? 5;
  }

  /** Create the table if it doesn't exist (alternative to a migration). */
  async ensureSchema(): Promise<void> {
    await this.db.prepare(auditTableSql(this.table)).run();
  }

  append(input: AuditInput): Promise<AuditEntry> {
    return this.queue.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const head = await this.db
          .prepare(`SELECT seq, hash FROM ${this.table} ORDER BY seq DESC LIMIT 1`)
          .first<{ seq: number; hash: string }>();
        const body: AuditEntryBody = {
          ...input,
          seq: head ? head.seq + 1 : 0,
          prevHash: head ? head.hash : GENESIS_HASH,
          ts: input.ts ?? new Date().toISOString(),
        };
        const entry = await sealEntry(body, this.hmacKey);
        try {
          await this.db
            .prepare(
              `INSERT INTO ${this.table} (seq, hash, entry) VALUES (?, ?, ?)`,
            )
            .bind(entry.seq, entry.hash, JSON.stringify(entry))
            .run();
          return entry;
        } catch (err) {
          // Lost the seq race to another instance: re-read the head and chain
          // off the winner. Anything else (schema missing, D1 outage) is a
          // real failure — propagate it, the pipeline records/fails closed.
          if (!isConstraintViolation(err) || attempt >= this.maxAppendRetries) {
            throw err;
          }
        }
      }
    });
  }

  async entries(): Promise<AuditEntry[]> {
    const { results } = await this.db
      .prepare(`SELECT entry FROM ${this.table} ORDER BY seq ASC`)
      .all<{ entry: string }>();
    return results.map((r) => JSON.parse(r.entry) as AuditEntry);
  }

  /** Walk the chain with {@link verifyChain}. */
  async verify(): Promise<{ valid: boolean; brokenAt?: number; reason?: string }> {
    return verifyChain(await this.entries(), this.hmacKey);
  }
}

// --- Idempotency store --------------------------------------------------------

export const DEFAULT_IDEMPOTENCY_TABLE = "flue_guard_idempotency";

/** DDL for the idempotency table. Run in a migration, or via `ensureSchema()`. */
export function idempotencyTableSql(
  table: string = DEFAULT_IDEMPOTENCY_TABLE,
): string {
  assertTableName("idempotency", table);
  return (
    `CREATE TABLE IF NOT EXISTS ${table} (` +
    "tenant_id TEXT NOT NULL, " +
    "idem_key TEXT NOT NULL, " +
    "status TEXT NOT NULL, " +
    "result TEXT, " +
    "created_at INTEGER NOT NULL, " +
    "completed_at INTEGER, " +
    "ttl_ms INTEGER, " +
    "PRIMARY KEY (tenant_id, idem_key))"
  );
}

interface IdempotencyRow {
  tenant_id: string;
  idem_key: string;
  status: IdempotencyStatus;
  result: string | null;
  created_at: number;
  completed_at: number | null;
  ttl_ms: number | null;
}

export interface D1IdempotencyStoreOptions {
  db: D1Like;
  /** Table name (a plain identifier). Defaults to {@link DEFAULT_IDEMPOTENCY_TABLE}. */
  table?: string;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  clock?: () => number;
}

/**
 * Idempotency store in a D1 table, with the same semantics as
 * {@link InMemoryIdempotencyStore} but an **atomic cross-instance claim**:
 *
 *  - A fresh key is claimed with `INSERT … ON CONFLICT DO NOTHING`; exactly
 *    one concurrent caller sees `changes === 1` and executes. Everyone else
 *    reads the row they lost to.
 *  - An in-flight claim never expires by TTL — expiring it would let a slow
 *    operation run twice. It is released only by `complete()`/`fail()`.
 *  - A `failed` or TTL-expired `completed` record is retaken with a *guarded*
 *    `UPDATE` (`WHERE status = <what we read> AND created_at = <what we
 *    read>`), so two instances retrying the same failed key still elect a
 *    single winner.
 *
 * Results are persisted as JSON, which is already the contract for governed
 * tools under Flue (Flue rejects non-JSON-plain results), so `complete()`
 * throws on a non-serializable result and the pipeline records the gap and
 * refuses the retry — a conflict, never a duplicate.
 */
export class D1IdempotencyStore implements IdempotencyStore {
  private readonly db: D1Like;
  private readonly table: string;
  private readonly now: () => number;

  constructor(options: D1IdempotencyStoreOptions) {
    assertTableName("idempotency", options.table ?? DEFAULT_IDEMPOTENCY_TABLE);
    this.db = options.db;
    this.table = options.table ?? DEFAULT_IDEMPOTENCY_TABLE;
    this.now = options.clock ?? Date.now;
  }

  /** Create the table if it doesn't exist (alternative to a migration). */
  async ensureSchema(): Promise<void> {
    await this.db.prepare(idempotencyTableSql(this.table)).run();
  }

  private toRecord(row: IdempotencyRow): IdempotencyRecord {
    return {
      key: row.idem_key,
      tenantId: row.tenant_id,
      status: row.status,
      result: row.result == null ? undefined : (JSON.parse(row.result) as unknown),
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      ttlMs: row.ttl_ms ?? undefined,
    };
  }

  private read(tenantId: string, key: string): Promise<IdempotencyRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM ${this.table} WHERE tenant_id = ? AND idem_key = ?`,
      )
      .bind(tenantId, key)
      .first<IdempotencyRow>();
  }

  private isExpired(record: IdempotencyRecord, now: number): boolean {
    if (record.ttlMs == null) return false;
    return now - (record.completedAt ?? record.createdAt) > record.ttlMs;
  }

  async begin(
    tenantId: string,
    key: string,
    ttlMs?: number,
  ): Promise<BeginResult> {
    // Bounded retry: each iteration either claims atomically or observes the
    // state a concurrent winner left behind. Three rounds of losing every
    // race is already pathological; refusing (a conflict) is the fail-safe
    // exit, never a duplicate execution.
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.now();
      const claimed = await this.db
        .prepare(
          `INSERT INTO ${this.table} ` +
            "(tenant_id, idem_key, status, created_at, ttl_ms) " +
            "VALUES (?, ?, 'in_flight', ?, ?) " +
            "ON CONFLICT (tenant_id, idem_key) DO NOTHING",
        )
        .bind(tenantId, key, now, ttlMs ?? null)
        .run();
      if ((claimed.meta?.changes ?? 0) === 1) return { status: "started" };

      const row = await this.read(tenantId, key);
      if (!row) continue; // deleted between claim and read — re-claim
      const record = this.toRecord(row);

      if (record.status === "in_flight") {
        return { status: "in_flight", record };
      }
      if (record.status === "completed" && !this.isExpired(record, now)) {
        return { status: "replay", record };
      }

      // failed, or completed-but-expired: retake, guarded on exactly the row
      // we read so concurrent retakers elect a single winner.
      const retaken = await this.db
        .prepare(
          `UPDATE ${this.table} SET status = 'in_flight', created_at = ?, ` +
            "completed_at = NULL, result = NULL, ttl_ms = ? " +
            "WHERE tenant_id = ? AND idem_key = ? AND status = ? AND created_at = ?",
        )
        .bind(now, ttlMs ?? null, tenantId, key, row.status, row.created_at)
        .run();
      if ((retaken.meta?.changes ?? 0) === 1) return { status: "started" };
      // Lost the retake — loop to observe the winner's state.
    }

    const finalRow = await this.read(tenantId, key);
    return {
      status: "in_flight",
      record: finalRow
        ? this.toRecord(finalRow)
        : { key, tenantId, status: "in_flight", createdAt: this.now(), ttlMs },
    };
  }

  async complete(tenantId: string, key: string, result: unknown): Promise<void> {
    const serialized = JSON.stringify(result);
    await this.db
      .prepare(
        `UPDATE ${this.table} SET status = 'completed', result = ?, ` +
          "completed_at = ? WHERE tenant_id = ? AND idem_key = ? " +
          "AND status = 'in_flight'",
      )
      .bind(serialized ?? null, this.now(), tenantId, key)
      .run();
  }

  async fail(tenantId: string, key: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE ${this.table} SET status = 'failed' ` +
          "WHERE tenant_id = ? AND idem_key = ? AND status = 'in_flight'",
      )
      .bind(tenantId, key)
      .run();
  }

  async get(
    tenantId: string,
    key: string,
  ): Promise<IdempotencyRecord | undefined> {
    const row = await this.read(tenantId, key);
    return row ? this.toRecord(row) : undefined;
  }
}
