import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_TIMEOUT_S,
  OUTPUT_CHUNK_CHARS,
  OUTPUT_FAILURE_WINDOW_LINES,
  OUTPUT_FILE_MAX_BYTES,
  OUTPUT_FIND_MAX_CALLS,
  OUTPUT_LINE_MAX_CHARS,
  OUTPUT_REPEAT_MIN,
  OUTPUT_SHAPE_MAX_COUNT,
} from "../constants.ts";
import {
  cleanOutput,
  createRarityCompressor,
  type FailureTarget,
  failureTargets,
  lineShape,
} from "../core/command-output.ts";
import type { GitExec } from "../core/git.ts";
import type { Result } from "../result.ts";
import { outputLines } from "./output-lines.ts";
import { resolveShell } from "./shell.ts";

export interface CommandOutput {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  compressed: boolean;
  truncated: boolean;
}
const TRUNCATION_MARK = `…[line truncated at ${OUTPUT_LINE_MAX_CHARS} chars]`;
/** Shortest key prefix worth redacting when a line cut leaves only its start. */
const SECRET_PREFIX_MIN = 4;
/**
 * Replace every occurrence of `secret` in `text`, counting replacements. A
 * line cut at OUTPUT_LINE_MAX_CHARS can end inside the key; that trailing key
 * prefix is redacted too.
 */
export function redactSecret(
  text: string,
  secret: string | undefined,
): { text: string; count: number } {
  if (!secret) return { text, count: 0 };
  const parts = text.split(secret);
  let result = parts.join("[redacted]");
  let count = parts.length - 1;
  if (result.endsWith(TRUNCATION_MARK)) {
    const kept = result.slice(0, -TRUNCATION_MARK.length);
    const min = Math.min(SECRET_PREFIX_MIN, secret.length);
    for (
      let length = Math.min(secret.length - 1, kept.length);
      length >= min;
      length--
    ) {
      if (kept.endsWith(secret.slice(0, length))) {
        result = `${kept.slice(0, -length)}[redacted]${TRUNCATION_MARK}`;
        count++;
        break;
      }
    }
  }
  return { text: result, count };
}
export async function captureCommand(
  exec: GitExec,
  cwd: string,
  command: string,
  timeoutS = ASK_TIMEOUT_S,
  signal?: AbortSignal,
  /** Configured Jev API key, replaced in the captured command and output. */
  secret?: string,
): Promise<
  Result<{
    output: CommandOutput;
    originalBytes: number;
    compressedChars: number;
    lineOmittedChars: number;
    shapeLimitExceeded: boolean;
    selectedPassages: boolean;
    assertion: boolean;
    targets: FailureTarget[];
    /** Occurrences of `secret` replaced with `[redacted]`. */
    redactions: number;
  }> & {
    commandExecution: "not_started" | "unknown" | "finished";
    commandExitCode?: number | null;
    commandTimedOut?: boolean;
  }
> {
  const directory = await mkdtemp(join(tmpdir(), "jev-output-"));
  let commandExecution: "not_started" | "unknown" | "finished" = "not_started";
  let completion:
    | { commandExitCode: number | null; commandTimedOut: boolean }
    | undefined;
  try {
    await chmod(directory, 0o700);
    const stdoutPath = join(directory, "stdout");
    const stderrPath = join(directory, "stderr");
    signal?.throwIfAborted();
    let executed: {
      stdout: string;
      stderr: string;
      code: number;
      killed: boolean;
    };
    try {
      const shell = resolveShell();
      // Fail closed: never spawn a bare name that PATH could resolve to WSL.
      if (!shell.ok)
        return {
          ok: false,
          cause: "file_unavailable",
          commandExecution: "not_started",
          error: shell.error,
        };
      commandExecution = "unknown";
      executed = await exec(
        shell.executable,
        [
          ...shell.prefix,
          "-c",
          `${shell.scriptPrefix}exec >"$1" 2>"$2"; set --; (\n${command}\n)\nexit $?`,
          "jev",
          stdoutPath,
          stderrPath,
        ],
        { cwd, timeout: timeoutS * 1000, signal },
      );
      commandExecution = "finished";
      completion = {
        commandExitCode: executed.killed ? null : executed.code,
        commandTimedOut: executed.killed,
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ok: false,
        cause: "file_unavailable",
        commandExecution,
        error: `Command executable unavailable: ${String(error)}`,
      };
    }
    signal?.throwIfAborted();
    const sizes = await Promise.all(
      [stdoutPath, stderrPath].map(async (path) => {
        try {
          return (await stat(path)).size;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return 0;
          throw error;
        }
      }),
    );
    if (sizes.some((size) => size > OUTPUT_FILE_MAX_BYTES))
      return {
        ok: false,
        cause: "evidence_too_large",
        commandExecution: "finished",
        ...completion,
        error: `output exceeded ${OUTPUT_FILE_MAX_BYTES} bytes per stream; narrow command`,
      };
    const targets: FailureTarget[] = [];
    let signature: "assertion" | "environment" | undefined;
    let compressedChars = 0;
    let linesTruncated = false;
    let lineOmittedChars = 0;
    let shapeLimitExceeded = false;
    const texts: string[] = [];
    let redactions = 0;
    const redacted = (text: string): string => {
      const result = redactSecret(text, secret);
      redactions += result.count;
      return result.text;
    };
    for (const [index, path] of [stdoutPath, stderrPath].entries()) {
      if (!sizes[index]) {
        texts.push(redacted(index === 0 ? executed.stdout : executed.stderr));
        continue;
      }
      const frequencies = new Map<string, number>();
      let shapeLimit = false;
      for await (const raw of outputLines(path, signal)) {
        signal?.throwIfAborted();
        const line = redactSecret(cleanOutput(raw), secret).text;
        linesTruncated ||= raw.endsWith(TRUNCATION_MARK);
        const shape = lineShape(line);
        if (
          !frequencies.has(shape) &&
          frequencies.size >= OUTPUT_SHAPE_MAX_COUNT
        ) {
          shapeLimit = true;
          shapeLimitExceeded = true;
          frequencies.clear();
          break;
        }
        frequencies.set(
          shape,
          Math.min(OUTPUT_REPEAT_MIN, (frequencies.get(shape) ?? 0) + 1),
        );
      }
      let text = "";
      const compressor = createRarityCompressor(frequencies, (line) => {
        compressedChars += line.length + 1;
        const remaining =
          OUTPUT_CHUNK_CHARS * OUTPUT_FIND_MAX_CALLS + 1 - text.length;
        if (remaining > 0) text += `${line}\n`.slice(0, remaining);
      });
      const failureWindow: string[] = [];
      let failureSeen = false;
      let afterFailure = 0;
      // node:test prints its failing-test block ("✖ failing tests:" then
      // "test at <file>:<line>:<col>") after one summary line per test, so
      // the block can sit more than one window past the first anchor. Once
      // the first window closes, keep scanning for that header and collect
      // the next window after it. At most two windows (2 * (WINDOW + 1)
      // lines) are ever buffered per stream.
      let secondSeen = false;
      let afterSecond = 0;
      const isAnchor = (line: string): boolean =>
        failureTargets(line).signature !== undefined ||
        /^\s*(?:✖|ERROR |FAIL |test at )/.test(line);
      const isFailingTestsHeader = (line: string): boolean =>
        /^\s*(?:✖\s+)?failing tests:?\s*$/.test(line);
      if (shapeLimit)
        compressor.line(
          `…[shape limit exceeded at ${OUTPUT_SHAPE_MAX_COUNT}; rarity grouping disabled]`,
        );
      for await (const raw of outputLines(path, signal, (chars) => {
        lineOmittedChars += chars;
      })) {
        signal?.throwIfAborted();
        linesTruncated ||= raw.endsWith(TRUNCATION_MARK);
        // Redact before compression, failure windows and state assembly.
        const line = redacted(cleanOutput(raw));
        compressor.line(line);
        if (!failureSeen) {
          failureWindow.push(line);
          if (failureWindow.length > OUTPUT_FAILURE_WINDOW_LINES + 1)
            failureWindow.shift();
          if (isAnchor(raw)) failureSeen = true;
        } else if (afterFailure++ < OUTPUT_FAILURE_WINDOW_LINES) {
          failureWindow.push(line);
          if (!secondSeen && afterFailure > 1 && isFailingTestsHeader(raw)) {
            secondSeen = true;
            afterSecond = 0;
          }
        } else if (!secondSeen) {
          if (isFailingTestsHeader(raw)) {
            secondSeen = true;
            afterSecond = 0;
            failureWindow.push(line);
          }
        } else if (afterSecond++ < OUTPUT_FAILURE_WINDOW_LINES) {
          failureWindow.push(line);
        }
      }
      compressor.finish();
      const failure = failureTargets(failureWindow.join("\n"));
      signature ??= failure.signature;
      targets.push(...failure.targets.slice(0, 20 - targets.length));
      texts.push(text);
    }
    return {
      ok: true,
      commandExecution: "finished",
      ...completion,
      output: {
        command: redacted(command),
        exit_code: executed.killed ? null : executed.code,
        timed_out: executed.killed,
        stdout: texts[0] ?? "",
        stderr: texts[1] ?? "",
        compressed: true,
        truncated: linesTruncated,
      },
      originalBytes: sizes.reduce((sum, size) => sum + size, 0),
      compressedChars,
      lineOmittedChars,
      shapeLimitExceeded,
      selectedPassages: false,
      assertion: signature === "assertion",
      targets,
      redactions,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ok: false,
      cause: "file_unavailable",
      commandExecution,
      ...completion,
      error: `Command capture unavailable: ${String(error)}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
