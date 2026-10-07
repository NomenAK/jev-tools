import { tokenize } from "../lexical.ts";
import {
  type Literal,
  literal,
  matches,
  shellWords,
  strings,
} from "./shared.ts";
import type { TestScenario } from "./types.ts";

export function pythonScenarios(
  text: string,
  config: { [key: string]: Literal },
): { scenarios: TestScenario[]; countKnown: boolean } {
  const result: TestScenario[] = [];
  const classes: { name: string; indent: number }[] = [];
  let decorators: string[] = [];
  let decoratorStart: number | undefined;
  let countKnown = true;
  const functionPatterns = strings(config.python_functions).flatMap(shellWords);
  const classPatterns = strings(config.python_classes).flatMap(shellWords);
  const source = text.split("\n");
  for (let i = 0; i < source.length; i++) {
    const line = source[i] ?? "";
    const tokens = tokenize(line, true);
    if (!tokens.length) continue;
    const indent = line.length - line.trimStart().length;
    while (
      classes.length &&
      indent <= (classes[classes.length - 1]?.indent ?? -1)
    )
      classes.pop();
    if (tokens[0]?.value === "@") {
      decoratorStart ??= i + 1;
      let decoration = line.trim();
      let balance =
        tokens.filter((t) => !t.string && ["(", "[", "{"].includes(t.value))
          .length -
        tokens.filter((t) => !t.string && [")", "]", "}"].includes(t.value))
          .length;
      while (balance > 0 && i + 1 < source.length) {
        const next = source[++i] ?? "";
        decoration += `\n${next}`;
        const nextTokens = tokenize(next, true);
        balance +=
          nextTokens.filter(
            (t) => !t.string && ["(", "[", "{"].includes(t.value),
          ).length -
          nextTokens.filter(
            (t) => !t.string && [")", "]", "}"].includes(t.value),
          ).length;
      }
      decorators.push(decoration);
      continue;
    }
    if (tokens[0]?.value === "class") {
      const name = tokens[1]?.value ?? "";
      if (
        (classPatterns.length ? classPatterns : ["Test*"]).some((p) =>
          matches(name, p),
        ) ||
        tokens.some((t) => t.value === "TestCase")
      )
        classes.push({ name, indent });
    }
    const def = tokens[0]?.value === "async" ? 1 : 0;
    if (tokens[def]?.value === "def") {
      const name = tokens[def + 1]?.value ?? "";
      const inClass = indent > 0;
      if (
        (!inClass || classes.length) &&
        (functionPatterns.length ? functionPatterns : ["test_*"]).some((p) =>
          matches(name, p),
        )
      ) {
        const qualified = [...classes.map((c) => c.name), name].join("::");
        const parameterDecorators = decorators
          .map((text) => tokenize(text, true))
          .filter((d) => d.some((t) => t.value === "parametrize"));
        let parameterIds: string[] | undefined;
        if (parameterDecorators.length === 1) {
          const decoration = parameterDecorators[0] ?? [];
          const idsIndex = decoration.findIndex(
            (t, index) =>
              t.value === "ids" && decoration[index + 1]?.value === "=",
          );
          const ids = literal(decoration, idsIndex + 2);
          const call =
            decoration.findIndex((t) => t.value === "parametrize") + 1;
          const argument = literal(decoration, call + 1);
          const values = literal(decoration, argument.end + 1);
          if (
            idsIndex >= 0 &&
            ids.complete &&
            values.complete &&
            Array.isArray(ids.value) &&
            Array.isArray(values.value) &&
            ids.value.length === values.value.length &&
            ids.value.length > 0 &&
            ids.value.every(
              (id) =>
                typeof id === "string" &&
                /^[\x20-\x7e]+$/.test(id) &&
                !id.includes("[") &&
                !id.includes("]") &&
                !id.includes("\\"),
            ) &&
            new Set(ids.value).size === ids.value.length
          )
            parameterIds = ids.value as string[];
        }
        // Generated IDs, stacked decorators and collection hooks stay conservative.
        const reliable = !parameterDecorators.length || !!parameterIds;
        if (!reliable) countKnown = false;
        let endLine = i + 1;
        for (let bodyLine = i + 1; bodyLine < source.length; bodyLine++) {
          const body = source[bodyLine] ?? "";
          if (!body.trim() || body.trimStart().startsWith("#")) continue;
          if (body.length - body.trimStart().length <= indent) break;
          endLine = bodyLine + 1;
        }
        for (const nodeName of parameterIds
          ? parameterIds.map((id) => `${qualified}[${id}]`)
          : [qualified]) {
          result.push({
            id: nodeName,
            name: nodeName,
            line: i + 1,
            reliable,
            range: { start: decoratorStart ?? i + 1, end: endLine },
            ...(classes.length
              ? { ancestors: classes.map((c) => c.name) }
              : {}),
          });
        }
      }
    }
    decorators = [];
    decoratorStart = undefined;
  }
  return { scenarios: result, countKnown };
}
