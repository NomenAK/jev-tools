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

export interface CommandOutput {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  compressed: boolean;
  truncated: boolean;
}
export async function captureCommand(
  exec: GitExec,
  cwd: string,
  command: string,
  timeoutS = ASK_TIMEOUT_S,
  signal?: AbortSignal,
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
  }>
> {
  const directory = await mkdtemp(join(tmpdir(), "jev-output-"));
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
      executed = await exec(
        "env",
        [
          "CI=1",
          "bash",
          "-c",
          `exec >"$1" 2>"$2"; set --; (\n${command}\n)\nexit $?`,
          "jev",
          stdoutPath,
          stderrPath,
        ],
        { cwd, timeout: timeoutS * 1000, signal },
      );
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ok: true,
        output: {
          command,
          exit_code: null,
          timed_out: false,
          stdout: "",
          stderr: `Command executable unavailable: ${String(error)}`,
          compressed: true,
          truncated: false,
        },
        originalBytes: 0,
        compressedChars: 0,
        lineOmittedChars: 0,
        shapeLimitExceeded: false,
        selectedPassages: false,
        assertion: false,
        targets: [],
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
        error: `output exceeded ${OUTPUT_FILE_MAX_BYTES} bytes per stream; narrow command`,
      };
    const targets: FailureTarget[] = [];
    let signature: "assertion" | "environment" | undefined;
    let compressedChars = 0;
    let linesTruncated = false;
    let lineOmittedChars = 0;
    let shapeLimitExceeded = false;
    const texts: string[] = [];
    for (const [index, path] of [stdoutPath, stderrPath].entries()) {
      if (!sizes[index]) {
        texts.push(index === 0 ? executed.stdout : executed.stderr);
        continue;
      }
      const frequencies = new Map<string, number>();
      let shapeLimit = false;
      for await (const raw of outputLines(path, signal)) {
        signal?.throwIfAborted();
        const line = cleanOutput(raw);
        linesTruncated ||= raw.endsWith(
          `…[line truncated at ${OUTPUT_LINE_MAX_CHARS} chars]`,
        );
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
        linesTruncated ||= raw.endsWith(
          `…[line truncated at ${OUTPUT_LINE_MAX_CHARS} chars]`,
        );
        compressor.line(cleanOutput(raw));
        if (!failureSeen) {
          failureWindow.push(cleanOutput(raw));
          if (failureWindow.length > OUTPUT_FAILURE_WINDOW_LINES + 1)
            failureWindow.shift();
          if (isAnchor(raw)) failureSeen = true;
        } else if (afterFailure++ < OUTPUT_FAILURE_WINDOW_LINES) {
          failureWindow.push(cleanOutput(raw));
          if (!secondSeen && afterFailure > 1 && isFailingTestsHeader(raw)) {
            secondSeen = true;
            afterSecond = 0;
          }
        } else if (!secondSeen) {
          if (isFailingTestsHeader(raw)) {
            secondSeen = true;
            afterSecond = 0;
            failureWindow.push(cleanOutput(raw));
          }
        } else if (afterSecond++ < OUTPUT_FAILURE_WINDOW_LINES) {
          failureWindow.push(cleanOutput(raw));
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
      output: {
        command,
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
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
