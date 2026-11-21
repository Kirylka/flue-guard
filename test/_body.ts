import { zstdDecompressSync } from "node:zlib";

/**
 * Reads a JSON request body as the TypeSafe SDK sends it. SDK 0.7+ zstd-compresses
 * bodies of 1 KiB or more and marks them with `content-encoding: zstd`.
 */
export function jsonBody<T = Record<string, unknown>>(init: RequestInit | undefined): T {
  const body = init?.body;
  if (typeof body === "string") return JSON.parse(body) as T;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
  const encoding = new Headers(init?.headers).get("content-encoding");
  const raw = encoding === "zstd" ? zstdDecompressSync(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}
