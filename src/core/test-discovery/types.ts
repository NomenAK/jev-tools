export type Framework =
  | "vitest"
  | "jest"
  | "node"
  | "bun"
  | "playwright"
  | "go"
  | "pytest"
  | "ava"
  | "mocha"
  | "deno"
  | "unknown";
export interface TestScenario {
  id: string;
  name: string;
  line: number;
  reliable: boolean;
  nameParts?: readonly string[];
  ancestors?: readonly string[];
  range?: { start: number; end: number };
}
export interface TestEntry {
  path: string;
  framework: Framework;
  runnerVersion?: string;
  cwd: string;
  config?: string;
  project?: string;
  options: readonly string[];
  commandRefusal?: string;
  nameFilterBlocked?: boolean;
  nameFilterReason?: string;
  invocation?: {
    executable: string;
    args: readonly string[];
    kind: "runner" | "typecheck";
  };
  scenarios: readonly TestScenario[];
  countKnown: boolean;
  kind: "runtime" | "types";
  provenance: string;
}
export interface Discovery {
  entries: readonly TestEntry[];
  evidence: readonly string[];
  limits: readonly {
    path: string;
    kind:
      | "incomplete"
      | "unsupported"
      | "unknown"
      | "types"
      | "local_runner_unproven"
      | "interactive_script_skipped";
    framework?: Framework;
  }[];
}
