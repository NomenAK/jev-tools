import {
  OUTPUT_BUDGET_SLACK_CHARS,
  OUTPUT_CHUNK_CHARS,
  OUTPUT_FIND_MAX_CALLS,
  OUTPUT_MIN_BUDGET_CHARS,
  STATE_MAX_CHARS,
} from "../constants.ts";
import type { State } from "../jev/types.ts";
import {
  type OutputChunk,
  outputChunks,
  selectOutput,
} from "./command-output.ts";

// Sizing figures the budgeting decisions rest on. The text fields are the
// captured streams; only these four are read, so callers pass them
// explicitly while the full output object stays in the orchestration layer.
export interface SizedOutput {
  stdout: string;
  stderr: string;
  compressedChars: number;
  originalBytes: number;
}

// True when the state plus the full output no longer fits the state budget
// and the passage-finding path must run.
export function needsPassageFinding(
  state: State,
  output: { stdout: string; stderr: string },
): boolean {
  return JSON.stringify({ ...state, output }).length > STATE_MAX_CHARS;
}

export interface PassagePlan {
  stdoutChunks: OutputChunk[];
  stderrChunks: OutputChunk[];
}

// Split both streams into find-sized chunks, or refuse when passage finding
// itself would exceed its call budget.
export function planPassageFinding(
  output: SizedOutput,
): { ok: true; plan: PassagePlan } | { ok: false; error: string } {
  const stdoutChunks = outputChunks(output.stdout);
  const stderrChunks = outputChunks(output.stderr);
  if (
    output.compressedChars > OUTPUT_CHUNK_CHARS * OUTPUT_FIND_MAX_CALLS ||
    stdoutChunks.length + stderrChunks.length > OUTPUT_FIND_MAX_CALLS
  )
    return {
      ok: false,
      error: `output requires more than ${OUTPUT_FIND_MAX_CALLS} find calls: ${output.originalBytes} bytes before, ${output.compressedChars} chars after compression; narrow command (remove verbosity or filter)`,
    };
  return { ok: true, plan: { stdoutChunks, stderrChunks } };
}

export interface FittedOutput {
  stdout: string;
  stderr: string;
  omittedFailing: boolean;
  selectedPassages: boolean;
}

// Split the remaining budget across streams (stderr keeps its text when it
// fits in half, otherwise each stream is passage-selected) and report whether
// a failing-scoring chunk did not survive selection.
export function fitOutputToBudget(
  state: State,
  output: { stdout: string; stderr: string },
  plan: PassagePlan,
  scores: readonly number[],
): { ok: true; fitted: FittedOutput } | { ok: false; error: string } {
  const emptySize = JSON.stringify({
    ...state,
    output: { ...output, stdout: "", stderr: "", truncated: true },
  }).length;
  const budget = STATE_MAX_CHARS - emptySize - OUTPUT_BUDGET_SLACK_CHARS;
  if (budget < OUTPUT_MIN_BUDGET_CHARS)
    return {
      ok: false,
      error: "No space for command output; reduce paths or state.",
    };
  const stderrSize = JSON.stringify(output.stderr).length;
  const stdoutSize = JSON.stringify(output.stdout).length;
  const textLength = output.stdout.length + output.stderr.length;
  const stdoutBudget = !output.stderr
    ? budget
    : stderrSize < budget / 2
      ? budget - stderrSize
      : stdoutSize < budget / 2
        ? stdoutSize
        : Math.floor((budget * output.stdout.length) / Math.max(1, textLength));
  const stdout = output.stdout
    ? selectOutput(
        output.stdout,
        plan.stdoutChunks,
        scores.slice(0, plan.stdoutChunks.length),
        stdoutBudget,
      )
    : "";
  const stderr = output.stderr
    ? selectOutput(
        output.stderr,
        plan.stderrChunks,
        scores.slice(plan.stdoutChunks.length),
        budget - stdoutBudget,
      )
    : "";
  const chunks = [...plan.stdoutChunks, ...plan.stderrChunks];
  const omittedFailing = chunks.some(
    (chunk, index) =>
      (scores[index] ?? 0) >= 0.5 &&
      !(index < plan.stdoutChunks.length ? stdout : stderr).includes(
        chunk.text,
      ),
  );
  return {
    ok: true,
    fitted: {
      stdout,
      stderr,
      omittedFailing,
      selectedPassages: stdout.length + stderr.length < textLength,
    },
  };
}
