import { realpath } from "node:fs";
import { promisify } from "node:util";

const nativeRealpath = promisify(realpath.native);

/**
 * Canonical form of an existing path: resolves symlinks and, on Windows,
 * expands 8.3 short names (C:\Users\NAME~1) so the path relates correctly to
 * `git rev-parse --show-toplevel`, which always reports the long form. Falls
 * back to the input when the path cannot be resolved.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await nativeRealpath(path);
  } catch {
    return path;
  }
}
