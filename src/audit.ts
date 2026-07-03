/**
 * Tamper-evident, hash-chained audit log.
 *
 * Every governed tool call appends exactly one entry. Each entry stores the
 * SHA-256 hash of the previous entry, so the log forms a chain: altering or
 * removing any historical entry breaks every hash after it, which
 * {@link verifyChain} detects. The genesis entry chains from 64 zeros.
 *
 * Entries are serialized as canonical JSON (recursively key-sorted) so the
 * hash is stable regardless of property insertion order.
 */

import type { Decision, Outcome } from "./types.js";
import { GovernanceConfigError } from "./errors.js";

export const GENESIS_HASH = "0".repeat(64);

/** Cap recursion so a pathologically deep value can't overflow the stack. */
const MAX_DEPTH = 100;
const DEPTH_MARKER = "[Depth limit exceeded]";

/**
 * Assign a normalized key as an own data property. A plain `out["__proto__"] =`
 * would set the prototype (the key would vanish from the receipt and could
 * pollute), so define `__proto__` explicitly; other keys are plain assignments.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    out[key] = value;
  }
}

/** Reject an empty HMAC key (a common misconfiguration, e.g. an unset env var). */
function assertHmacKey(hmacKey?: string): void {
  if (hmacKey === "") {
    throw new GovernanceConfigError(
      "audit",
      "hmacKey must be a non-empty string. Set a real key, or omit it for " +
        "unkeyed SHA-256 — an empty key is almost always an unset env var.",
    );
  }
}

/** A single, immutable record of a governed tool call. */
export interface AuditEntry {
  seq: number;
  ts: string;
  prevHash: string;
  actorId: string;
  tenantId: string;
  tool: string;
  /** Present and `"primitive"` for broad, free-form-payload tools. */
  kind?: "primitive";
  decision: Decision;
  outcome: Outcome;
  requestedScopes: string[];
  requestId?: string;
  idempotencyKey?: string;
  /** Approver id, when the call passed through an approval adapter. */
  approver?: string;
  /** Redacted arguments. */
  args?: unknown;
  /** Redacted result, present on success/replay. */
  result?: unknown;
  /** Error code or message, present on denial/error. */
  error?: string;
  /** SHA-256 of all fields above (canonicalized), including `prevHash`. */
  hash: string;
}

/** The fields of an entry that are hashed (everything except `hash`). */
export type AuditEntryBody = Omit<AuditEntry, "hash">;

/**
 * Recursively sort object keys so serialization is deterministic, and make the
 * result total — the audit log must never throw on a value a tool happened to
 * return. `bigint` becomes its decimal string (JSON can't represent it),
 * functions/symbols are dropped (as `JSON.stringify` would), and circular
 * structures are cut with a `[Circular]` marker instead of overflowing.
 */
function canonicalize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  // Non-finite numbers aren't JSON-representable (JSON.stringify emits null);
  // normalize them now so the in-memory and persisted values match exactly.
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    if (depth >= MAX_DEPTH) return DEPTH_MARKER;
    seen.add(value);
    let out: unknown;
    if (Array.isArray(value)) {
      out = value.map((v) => canonicalize(v, seen, depth + 1));
    } else {
      const obj: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        setOwn(
          obj,
          key,
          canonicalize((value as Record<string, unknown>)[key], seen, depth + 1),
        );
      }
      out = obj;
    }
    seen.delete(value);
    return out;
  }
  return value;
}

/** Hex-encode an ArrayBuffer. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Compute the chain hash for an entry body, using Web Crypto (`crypto.subtle`)
 * so the exact same code runs on every Flue target — Node, Cloudflare Workers,
 * Deno, Bun, Lambda, edge. With `hmacKey` it is HMAC-SHA256 (which also defends
 * against a full-file rewrite, since the chain can't be forged without the
 * key); without one, plain SHA-256.
 */
export async function hashEntry(
  body: AuditEntryBody,
  hmacKey?: string,
): Promise<string> {
  assertHmacKey(hmacKey);
  return hashCanonical(canonicalize(body), hmacKey);
}

/**
 * Hash an already-canonicalized value. Used internally so the log can normalize
 * a body exactly once, then both hash and persist that same immutable value —
 * never reading a getter (or any mutable source) twice.
 */
async function hashCanonical(canonical: unknown, hmacKey?: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(canonical));
  const subtle = globalThis.crypto.subtle;
  if (hmacKey) {
    const key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(hmacKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return toHex(await subtle.sign("HMAC", key, data));
  }
  return toHex(await subtle.digest("SHA-256", data));
}

/** What a caller provides; the log fills in seq, prevHash, ts and hash. */
export type AuditInput = Omit<AuditEntryBody, "seq" | "prevHash" | "ts"> & {
  ts?: string;
};

/**
 * Seal an entry body into a full {@link AuditEntry}: normalize it exactly
 * once, hash that normalized value, and return them together. The returned
 * entry is JSON-safe (bigint/circular/deep values are already normalized) and
 * can never disagree with its own hash — a getter is read only once. This is
 * the building block for every {@link AuditLog} implementation, including
 * custom store-backed sinks: fill in `seq`/`prevHash`/`ts`, seal, persist.
 */
export async function sealEntry(
  body: AuditEntryBody,
  hmacKey?: string,
): Promise<AuditEntry> {
  assertHmacKey(hmacKey);
  const normalized = canonicalize(body) as AuditEntryBody;
  const hash = await hashCanonical(normalized, hmacKey);
  return { ...normalized, hash };
}

export interface AuditLog {
  /** Append an entry and return the fully-populated, hashed record. */
  append(input: AuditInput): Promise<AuditEntry>;
  /** All entries, in order. */
  entries(): Promise<AuditEntry[]>;
}

/**
 * Walk a chain and report the first inconsistency, if any. Pass the same
 * `hmacKey` the log was written with (if any) or verification will fail.
 */
export async function verifyChain(
  entries: AuditEntry[],
  hmacKey?: string,
): Promise<{ valid: boolean; brokenAt?: number; reason?: string }> {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.seq !== i) {
      return { valid: false, brokenAt: i, reason: `seq mismatch at index ${i}` };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: `prevHash mismatch at seq ${i}` };
    }
    const { hash, ...body } = entry;
    if ((await hashEntry(body, hmacKey)) !== hash) {
      return { valid: false, brokenAt: i, reason: `content hash mismatch at seq ${i}` };
    }
    prevHash = hash;
  }
  return { valid: true };
}

/**
 * Serialize async appends through a promise chain. `seq`/`prevHash` are read,
 * an `await` (hashing, file I/O) happens, then the entry is committed — so two
 * concurrent appends must not interleave or they would share a sequence and a
 * parent hash and break the chain. Each append waits for the previous to settle.
 */
export class AppendQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    // Keep the queue moving even if this task rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** In-memory audit log, useful for tests and ephemeral runs. */
export class InMemoryAuditLog implements AuditLog {
  private readonly log: AuditEntry[] = [];
  private readonly hmacKey?: string;
  private readonly queue = new AppendQueue();

  constructor(options: { hmacKey?: string } = {}) {
    assertHmacKey(options.hmacKey);
    this.hmacKey = options.hmacKey;
  }

  append(input: AuditInput): Promise<AuditEntry> {
    return this.queue.run(async () => {
      const prev = this.log[this.log.length - 1];
      const body: AuditEntryBody = {
        ...input,
        seq: this.log.length,
        prevHash: prev ? prev.hash : GENESIS_HASH,
        ts: input.ts ?? new Date().toISOString(),
      };
      const entry = await sealEntry(body, this.hmacKey);
      this.log.push(entry);
      return entry;
    });
  }

  async entries(): Promise<AuditEntry[]> {
    return [...this.log];
  }

  verify() {
    return verifyChain(this.log, this.hmacKey);
  }
}

/**
 * Append-only JSONL audit log backed by a file. Each line is one
 * {@link AuditEntry}. The previous hash is tracked in memory; the existing file
 * (if any) is read once, lazily, to seed the chain.
 *
 * `node:fs`/`node:path` are imported lazily (only when this class is actually
 * used) so that importing the package on a runtime without a filesystem
 * (Cloudflare Workers, edge) does not eagerly pull in Node built-ins. On such
 * runtimes use a custom {@link AuditLog} sink instead of a file path.
 *
 * **Single-writer.** `seq`/`prevHash` are cached in memory and appends are
 * serialized within this instance, so this sink is safe for one process holding
 * one instance. It does NOT coordinate across instances or processes: two
 * writers on the same file will assign duplicate sequence numbers and break the
 * chain. For multi-writer / multi-instance use a sink backed by a store with an
 * atomic append (a database, or the D1 reference adapter), not a shared file.
 */
export class HashChainAuditLog implements AuditLog {
  private readonly path: string;
  private readonly hmacKey?: string;
  private readonly queue = new AppendQueue();
  private seq = 0;
  private prevHash = GENESIS_HASH;
  private initialized = false;
  private fsMod?: typeof import("node:fs");
  private pathMod?: typeof import("node:path");

  constructor(options: { path: string; hmacKey?: string }) {
    assertHmacKey(options.hmacKey);
    this.path = options.path;
    this.hmacKey = options.hmacKey;
  }

  private async modules(): Promise<{
    fs: typeof import("node:fs");
    path: typeof import("node:path");
  }> {
    this.fsMod ??= await import("node:fs");
    this.pathMod ??= await import("node:path");
    return { fs: this.fsMod, path: this.pathMod };
  }

  private async ensureInit(): Promise<typeof import("node:fs")> {
    const { fs, path } = await this.modules();
    if (this.initialized) return fs;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const existing = this.readFile(fs);
    this.seq = existing.length;
    this.prevHash = existing.length
      ? existing[existing.length - 1]!.hash
      : GENESIS_HASH;
    this.initialized = true;
    return fs;
  }

  private readFile(fs: typeof import("node:fs")): AuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  append(input: AuditInput): Promise<AuditEntry> {
    return this.queue.run(async () => {
      const fs = await this.ensureInit();
      const body: AuditEntryBody = {
        ...input,
        seq: this.seq,
        prevHash: this.prevHash,
        ts: input.ts ?? new Date().toISOString(),
      };
      const entry = await sealEntry(body, this.hmacKey);
      fs.appendFileSync(this.path, JSON.stringify(entry) + "\n");
      this.seq += 1;
      this.prevHash = entry.hash;
      return entry;
    });
  }

  async entries(): Promise<AuditEntry[]> {
    const { fs } = await this.modules();
    return this.readFile(fs);
  }

  async verify() {
    return verifyChain(await this.entries(), this.hmacKey);
  }
}
