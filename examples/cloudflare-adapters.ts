/**
 * Reference adapter for running flue-guard on Cloudflare Workers: a
 * KV-backed idempotency store.
 *
 * The production-grade Workers adapters ship in the package itself — import
 * `D1AuditLog` and `D1IdempotencyStore` from `flue-guard/d1` for a
 * multi-instance-safe audit chain and an atomic cross-instance idempotency
 * claim. This file remains as a copy-pasteable example of implementing the
 * `IdempotencyStore` seam against a different substrate (KV), with its
 * consistency trade-off called out below.
 */

import {
  type BeginResult,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "../src/idempotency.js";

// --- Minimal Cloudflare-shaped interface (so this file needs no CF types) ---

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// --- KV idempotency store ----------------------------------------------------

/**
 * Idempotency store backed by Cloudflare KV. Keys are namespaced by tenant.
 *
 * Production note: KV is eventually consistent and has no atomic
 * compare-and-set, so two truly simultaneous `begin()`s for the same key can
 * both win the race. For strict at-most-once under concurrency, use
 * `D1IdempotencyStore` from `flue-guard/d1` (atomic claim) or a Durable
 * Object (single-threaded per id). This adapter is correct for the common
 * case (retries/replays that are seconds apart) and for replay.
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
