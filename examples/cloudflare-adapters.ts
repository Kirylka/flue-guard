/**
 * Reference adapters for running flue-guard on Cloudflare Workers (or
 * any edge runtime): a D1-backed audit log and a KV-backed idempotency store.
 * Hashing is Web Crypto (the only path), so they work where `node:crypto` and
 * the filesystem are unavailable.
 *
 * These are intentionally written against the *minimal* structural slices of
 * the Cloudflare APIs they use, so they're easy to read, copy, and test with a
 * fake. Production notes are called out inline.
 */

import {
  hashEntry,
  verifyChain,
  GENESIS_HASH,
  type AuditEntry,
  type AuditEntryBody,
  type AuditInput,
  type AuditLog,
} from "../src/audit.js";
import {
  type BeginResult,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "../src/idempotency.js";

// --- Minimal Cloudflare-shaped interfaces (so this file needs no CF types) ---

export interface D1Like {
  prepare(sql: string): D1StatementLike;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// --- D1 audit log ------------------------------------------------------------

/**
 * Append-only, hash-chained audit log backed by a Cloudflare D1 table:
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, hash TEXT, entry TEXT);
 * ```
 *
 * Production note: appends read the current head, then insert `seq` as the
 * primary key — concurrent writers race on the same `seq` and one insert fails,
 * which surfaces the conflict rather than silently forking the chain. For
 * strictly serialized appends, front this with a Durable Object.
 */
export class D1AuditLog implements AuditLog {
  constructor(
    private readonly db: D1Like,
    private readonly hmacKey?: string,
  ) {}

  async append(input: AuditInput): Promise<AuditEntry> {
    const head = await this.db
      .prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1")
      .first<{ seq: number; hash: string }>();

    const body: AuditEntryBody = {
      ...input,
      seq: head ? head.seq + 1 : 0,
      prevHash: head ? head.hash : GENESIS_HASH,
      ts: input.ts ?? new Date().toISOString(),
    };
    const entry: AuditEntry = { ...body, hash: await hashEntry(body, this.hmacKey) };

    await this.db
      .prepare("INSERT INTO audit (seq, hash, entry) VALUES (?, ?, ?)")
      .bind(entry.seq, entry.hash, JSON.stringify(entry))
      .run();
    return entry;
  }

  async entries(): Promise<AuditEntry[]> {
    const { results } = await this.db
      .prepare("SELECT entry FROM audit ORDER BY seq ASC")
      .all<{ entry: string }>();
    return results.map((r) => JSON.parse(r.entry) as AuditEntry);
  }

  async verify() {
    return verifyChain(await this.entries(), this.hmacKey);
  }
}

// --- KV idempotency store ----------------------------------------------------

/**
 * Idempotency store backed by Cloudflare KV. Keys are namespaced by tenant.
 *
 * Production note: KV is eventually consistent and has no atomic
 * compare-and-set, so two truly simultaneous `begin()`s for the same key can
 * both win the race. For strict at-most-once under concurrency, use a Durable
 * Object (single-threaded per id) instead. This adapter is correct for the
 * common case (retries/replays that are seconds apart) and for replay.
 */
export class KvIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly kv: KvLike,
    private readonly now: () => number = Date.now,
  ) {}

  private id(tenantId: string, key: string): string {
    return `idem:${tenantId}:${key}`;
  }

  private async read(id: string): Promise<IdempotencyRecord | undefined> {
    const raw = await this.kv.get(id);
    return raw ? (JSON.parse(raw) as IdempotencyRecord) : undefined;
  }

  private expired(record: IdempotencyRecord): boolean {
    if (record.ttlMs == null) return false;
    return this.now() - (record.completedAt ?? record.createdAt) > record.ttlMs;
  }

  async begin(tenantId: string, key: string, ttlMs?: number): Promise<BeginResult> {
    const id = this.id(tenantId, key);
    const existing = await this.read(id);
    if (existing) {
      // In-flight claims never expire by TTL (see InMemoryIdempotencyStore):
      // expiring one would let a slow operation run twice.
      if (existing.status === "in_flight") return { status: "in_flight", record: existing };
      if (!this.expired(existing) && existing.status === "completed") {
        return { status: "replay", record: existing };
      }
    }
    const record: IdempotencyRecord = {
      key,
      tenantId,
      status: "in_flight",
      createdAt: this.now(),
      ttlMs,
    };
    await this.kv.put(id, JSON.stringify(record));
    return { status: "started" };
  }

  async complete(tenantId: string, key: string, result: unknown): Promise<void> {
    const id = this.id(tenantId, key);
    const record = await this.read(id);
    if (!record) return;
    const updated: IdempotencyRecord = {
      ...record,
      status: "completed",
      result,
      completedAt: this.now(),
    };
    await this.kv.put(
      id,
      JSON.stringify(updated),
      record.ttlMs ? { expirationTtl: Math.ceil(record.ttlMs / 1000) } : undefined,
    );
  }

  async fail(tenantId: string, key: string): Promise<void> {
    const id = this.id(tenantId, key);
    const record = await this.read(id);
    if (record && record.status === "in_flight") {
      await this.kv.put(id, JSON.stringify({ ...record, status: "failed" }));
    }
  }

  async get(tenantId: string, key: string): Promise<IdempotencyRecord | undefined> {
    return this.read(this.id(tenantId, key));
  }
}
