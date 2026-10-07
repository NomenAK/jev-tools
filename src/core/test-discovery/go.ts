import type { LexicalToken as Token } from "../lexical.ts";
import { closing } from "./shared.ts";
import type { TestScenario } from "./types.ts";

export function goScenarios(
  tokens: readonly Token[],
  text: string,
): { scenarios: TestScenario[]; countKnown: boolean } {
  const scenarios: TestScenario[] = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    const name = tokens[i + 1]?.value ?? "";
    if (
      tokens[i]?.value === "func" &&
      tokens[i + 2]?.value === "(" &&
      /^(?:Test[^a-z]|Example(?:[^a-z]|$))/.test(name)
    ) {
      // Go examples are runnable only with an Output/Unordered output directive.
      const end = closing(tokens, i + 2);
      const bodyStart = tokens.findIndex((t, j) => j > end && t.value === "{");
      const bodyEnd = bodyStart < 0 ? bodyStart : closing(tokens, bodyStart);
      const body =
        bodyStart < 0
          ? ""
          : text.slice(
              tokens[bodyStart]?.offset ?? 0,
              tokens[bodyEnd]?.offset ?? text.length,
            );
      if (
        name.startsWith("Example") &&
        !/\/\/\s*(?:Unordered output|Output):/i.test(body)
      )
        continue;
      const line = tokens[i]?.line ?? 1;
      scenarios.push({
        id: name,
        name,
        line,
        reliable: true,
        ...(tokens[bodyEnd]
          ? { range: { start: line, end: tokens[bodyEnd]?.line ?? line } }
          : {}),
      });
    }
  }
  return { scenarios, countKnown: true };
}
