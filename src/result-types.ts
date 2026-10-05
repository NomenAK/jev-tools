/** JSON public contract. No runtime or adapter dependencies. */
export type Knowledge<T> =
  | { status: "known"; value: T }
  | { status: "unknown" | "not_applicable" | "not_collected"; reason: string };
export type Tool =
  | "jev_ask"
  | "jev_ask_files"
  | "jev_check_diff"
  | "jev_select_tests"
  | "jev_find_files"
  | "jev_locate_in_file";
export type Execution = "complete" | "partial" | "not_judged" | "refused";
export type Scope =
  | { kind: "call" }
  | { kind: "group"; groupIds: string[] }
  | { kind: "item"; itemIds: string[] }
  | { kind: "inventory"; inventoryIds: string[] };
export interface Inventory {
  id: string;
  kind: "repository" | "tests" | "sections" | "units";
  rules: string[];
  restrictions: string[];
  discovered: Knowledge<number>;
  considered: Knowledge<number>;
  scopeRestricted: boolean;
  criteria: {
    criterion: string;
    matches: Knowledge<number>;
    outcome: "matched" | "no_match" | "outside_inventory" | "not_evaluated";
    diagnosticIds: string[];
  }[];
}
export interface Context {
  authority: Knowledge<{ path: string; origin: "host" | "server" }>;
  requestedRoot: Knowledge<string>;
  effectiveRoot: Knowledge<{
    path: string;
    origin: "host" | "server" | "override";
    commonDir: Knowledge<string>;
  }>;
  requestedBase: Knowledge<string>;
  resolvedBase: Knowledge<string>;
  inventories: Inventory[];
  command: {
    execution:
      | "not_requested"
      | "not_started"
      | "started"
      | "finished"
      | "unknown";
    cwd: Knowledge<string>;
    exitCode: Knowledge<number | null>;
    timedOut: Knowledge<boolean>;
  };
}
export type Cause =
  | "invalid_arguments"
  | "internal_error"
  | "file_unavailable"
  | "git_failure"
  | "evidence_limit"
  | "invalid_root"
  | "invalid_base"
  | "forbidden_path"
  | "ignored_path"
  | "secret_pattern"
  | "symlink"
  | "binary_or_non_utf8"
  | "missing_required"
  | "empty_required"
  | "ambiguous_reference"
  | "reserved_key"
  | "evidence_too_large"
  | "group_too_large"
  | "call_budget"
  | "session_budget"
  | "provider_context_refusal"
  | "not_configured"
  | "service_unavailable"
  | "transport_failure"
  | "invalid_response"
  | "cancelled"
  | "collection_empty"
  | "no_changed_units"
  | "criteria_no_match"
  | "outside_inventory"
  | "collection_omitted"
  | "unsupported_syntax"
  | "unresolved_runner"
  | "dynamic_dependency"
  | "conservative_widening"
  | "control_failure"
  | "evidence_disagreement";
export interface Diagnostic {
  id: string;
  cause: Cause;
  fact: string;
  target: Knowledge<string>;
  origin:
    | "input"
    | "note"
    | "ask"
    | "control"
    | "collection"
    | "closure"
    | "runner"
    | "provider"
    | "budget";
  scope: Scope;
  effect: "blocking" | "reservation";
  material: boolean;
  omittedMembers: string[];
  memberCount: Knowledge<number>;
  actionIds: string[];
}
export interface Action {
  id: string;
  code:
    | "correct_context"
    | "correct_reference"
    | "provide_evidence"
    | "narrow_evidence"
    | "inspect_native"
    | "execute_plan"
    | "configure_client"
    | "recover_service"
    | "continue_without_judgment"
    | "none";
  target: Knowledge<string>;
  scope: Scope;
  condition: string;
  instruction: string;
  repeatUnchanged: false;
}
export interface RawValue {
  label: string;
  value: string | number | boolean;
  probability: Knowledge<number>;
}
export interface ItemCommon {
  id: string;
  kind:
    | "claim"
    | "question"
    | "file_question"
    | "unit"
    | "section"
    | "requirement"
    | "scenario"
    | "entry"
    | "pointer";
  label: string;
  groupId: string;
  evidence: {
    target: string;
    canonicalPath: Knowledge<string>;
    aliases: string[];
    side: "current" | "before" | "output" | "state";
    revision: Knowledge<string>;
  }[];
  diagnosticIds: string[];
  actionIds: string[];
  selection?: { selected: boolean; reason: string };
}
export type Item = ItemCommon &
  (
    | {
        treatment: "judged";
        source: "fresh" | "cache";
        judgment: {
          band: "verdict" | "unsure" | "abstain";
          result: string | number | boolean;
          measure: {
            kind: "probability" | "confidence";
            value: Knowledge<number>;
          };
          reason: string;
          uncalibrated: boolean;
          rawValues: RawValue[];
          controls: {
            id: string;
            kind:
              | "cross_check"
              | "order"
              | "witness"
              | "attribution"
              | "integrity";
            source: "fresh" | "cache" | "static";
            outcome: string;
            rawValues: RawValue[];
          }[];
        };
      }
    | { treatment: "not_judged"; source: "none" }
    | { treatment: "static"; source: "none"; staticReason: string }
  );
export interface Accounting {
  toolInvocations: 1;
  httpAttempts: number;
  questionsSent: number;
  cacheHits: number;
  cacheRequests: number;
  requestedResults: {
    total: Knowledge<number>;
    fresh: number;
    cache: number;
    notJudged: number;
    static: number;
  };
  auxiliary: {
    controls: {
      fresh: number;
      cache: number;
      notJudged: number;
      static: number;
    };
    passages: { fresh: number; cache: number; notJudged: number };
  };
  costUsd: Knowledge<number>;
  elapsedMs: number;
}
export interface ResultReportV1 {
  schemaVersion: 1;
  tool: Tool;
  execution: Execution;
  context: Context;
  items: Item[];
  diagnostics: Diagnostic[];
  actions: Action[];
  accounting: Accounting;
}
export interface McpStructuredResultV1 {
  result: ResultReportV1;
}
