import { IMPORT_LAYERS } from "../constants.ts";

export interface ArchitectureImport {
  file: string;
  line: number;
  specifier: string;
  target?: string;
  typeOnly: boolean;
}
export interface ImportViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/** All local edges participate in cycles, including erased type dependencies. */
export function checkImportBoundaries(
  imports: readonly ArchitectureImport[],
): ImportViolation[] {
  const violations: ImportViolation[] = [];
  const graph = new Map<string, ArchitectureImport[]>();
  for (const edge of imports) {
    const layer = edge.file.split("/")[0] ?? "";
    const allowed = IMPORT_LAYERS[layer as keyof typeof IMPORT_LAYERS];
    if (edge.target) {
      const destination = edge.target.split("/")[0] ?? "";
      if (
        allowed &&
        !allowed.some((item: string) =>
          item.includes("/") ? item === edge.target : item === destination,
        )
      ) {
        violations.push({
          ...edge,
          rule: "layer-dependency",
          detail: `${layer} cannot import ${edge.target}`,
        });
      } else if (
        allowed &&
        edge.target === "jev/types.ts" &&
        layer !== "jev" &&
        !edge.typeOnly
      ) {
        violations.push({
          ...edge,
          rule: "type-contract-only",
          detail: "jev/types.ts must be imported as types",
        });
      }
      const edges = graph.get(edge.file) ?? [];
      edges.push(edge);
      graph.set(edge.file, edges);
    } else if (edge.specifier.startsWith(".")) {
      violations.push({
        ...edge,
        rule: "local-resolution",
        detail: `cannot resolve ${edge.specifier} inside src/`,
      });
    } else if (
      [
        "core",
        "presets",
        "texts",
        "constants.ts",
        "result.ts",
        "result-types.ts",
      ].includes(layer) &&
      !(layer === "core" && ["node:path", "path"].includes(edge.specifier)) &&
      !(
        layer === "core" &&
        edge.specifier === "@ast-grep/napi" &&
        edge.typeOnly
      )
    ) {
      violations.push({
        ...edge,
        rule: "pure-dependency",
        detail: `${layer} cannot import external module ${edge.specifier}`,
      });
    }
  }
  const done = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  function visit(file: string): void {
    if (done.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const edge of graph.get(file) ?? []) {
      const target = edge.target;
      if (!target) continue;
      if (active.has(target)) {
        violations.push({
          ...edge,
          rule: "import-cycle",
          detail: [...stack.slice(stack.indexOf(target)), target].join(" -> "),
        });
      } else visit(target);
    }
    stack.pop();
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return violations;
}
