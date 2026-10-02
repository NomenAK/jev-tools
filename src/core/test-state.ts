import { STATE_MAX_CHARS } from "../constants.ts";
import type { State } from "../jev/types.ts";
import type { TestScenario } from "./test-discovery.ts";

export interface TestStateBatch {
  state: State;
  scenarios: readonly TestScenario[];
}
export interface PreparedTestStates {
  batches: readonly TestStateBatch[];
  unjudged: readonly { scenario: TestScenario; reason: string }[];
}

/** Partition complete bodies with a single setup mask and additive serialized sizes. */
export function prepareTestStates(
  state: State,
  scenarios: readonly TestScenario[],
  maxChars = STATE_MAX_CHARS,
): PreparedTestStates {
  if (JSON.stringify(state).length <= maxChars)
    return { batches: [{ state, scenarios }], unjudged: [] };
  const file = state.testFile;
  if (
    !file ||
    typeof file !== "object" ||
    Array.isArray(file) ||
    typeof file.text !== "string"
  )
    return {
      batches: [],
      unjudged: scenarios.map((scenario) => ({
        scenario,
        reason: "required test file absent from state",
      })),
    };
  const source = file.text.split("\n");
  const mask = new Int32Array(source.length + 1);
  for (const scenario of scenarios)
    if (scenario.range) {
      const start = Math.max(0, scenario.range.start - 1);
      const end = Math.min(source.length, scenario.range.end);
      mask[start] = (mask[start] ?? 0) + 1;
      mask[end] = (mask[end] ?? 0) - 1;
    }
  let active = 0;
  const setup = `${source
    .map((line, index) => {
      active += mask[index] ?? 0;
      return active ? "" : line;
    })
    .join("\n")}\n`;
  const base: State = { ...state, testFile: { ...file, text: setup } };
  const baseSize = JSON.stringify(base).length;
  const batches: TestStateBatch[] = [];
  const unjudged: { scenario: TestScenario; reason: string }[] = [];
  let group: TestScenario[] = [];
  let bodies: string[] = [];
  let size = baseSize;
  const flush = () => {
    if (group.length)
      batches.push({
        state: {
          ...base,
          testFile: { ...file, text: setup + bodies.join("\n") },
        },
        scenarios: group,
      });
    group = [];
    bodies = [];
    size = baseSize;
  };
  for (const scenario of scenarios) {
    if (!scenario.range) {
      unjudged.push({
        scenario,
        reason:
          "test body range unresolved; complete file exceeds state budget",
      });
      continue;
    }
    const body = source
      .slice(scenario.range.start - 1, scenario.range.end)
      .join("\n");
    const bodySize = JSON.stringify(body).length - 2;
    if (baseSize + bodySize > maxChars) {
      unjudged.push({
        scenario,
        reason: `complete test body and required evidence exceed state budget ${maxChars}`,
      });
      continue;
    }
    if (group.length && size + 2 + bodySize > maxChars) flush();
    size += bodySize + (group.length ? 2 : 0);
    group.push(scenario);
    bodies.push(body);
  }
  flush();
  return { batches, unjudged };
}
