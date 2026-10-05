import type { Cause } from "./result-types.ts";
export type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; cause?: Cause };
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
