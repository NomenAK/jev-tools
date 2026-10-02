import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { Result } from "../result.ts";

/** Callers enforce byte budgets before decoding. BOM and legitimate controls are preserved. */
export function decodeUtf8(bytes: Uint8Array): Result<{ text: string }> {
  return isUtf8(bytes)
    ? {
        ok: true,
        text: Buffer.from(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).toString("utf8"),
      }
    : { ok: false, error: "not UTF-8 text" };
}

/** Keep incomplete code points between chunks, but reject them at EOF. */
export function createUtf8Decoder() {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return (bytes?: Uint8Array): Result<{ text: string }> => {
    try {
      return {
        ok: true,
        text: decoder.decode(bytes, { stream: bytes !== undefined }),
      };
    } catch {
      return { ok: false, error: "not UTF-8 text" };
    }
  };
}

/** Verify host-decoded text against the raw Git object; replacement cannot silently become evidence. */
export function verifyGitUtf8(
  text: string,
  id?: string,
  size?: number,
): Result<{ text: string }> {
  const bytes = Buffer.from(text, "utf8");
  if (size !== undefined && bytes.length !== size)
    return { ok: false, error: "not UTF-8 text" };
  if (id && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) {
    const actual = createHash(id.length === 64 ? "sha256" : "sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (actual !== id) return { ok: false, error: "not UTF-8 text" };
  } else if (text.includes("\uFFFD")) {
    return {
      ok: false,
      error:
        "not verifiable as UTF-8 text (contains U+FFFD after host decoding)",
    };
  }
  return decodeUtf8(bytes);
}
