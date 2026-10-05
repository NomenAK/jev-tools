import { validateResultReport } from "./core/result-report.ts";
import type { McpStructuredResultV1, ResultReportV1 } from "./result-types.ts";

/** Self-contained public JSON Schema; semantic ID/count checks live in result-report. */
const definitions = {
  KnowledgeString: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            type: "string",
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeNumber: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            type: "integer",
            minimum: 0,
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeBoolean: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            type: "boolean",
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeNullableNumber: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            type: ["number", "null"],
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeAuthority: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            $ref: "#/$defs/Authority",
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeEffectiveRoot: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            $ref: "#/$defs/EffectiveRoot",
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeProbability: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  KnowledgeCost: {
    oneOf: [
      {
        type: "object",
        properties: {
          status: {
            const: "known",
          },
          value: {
            type: "number",
            minimum: 0,
          },
        },
        required: ["status", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["unknown", "not_applicable", "not_collected"],
          },
          reason: {
            type: "string",
          },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
    ],
  },
  Authority: {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
      origin: {
        type: "string",
        enum: ["host", "server"],
      },
    },
    required: ["path", "origin"],
    additionalProperties: false,
  },
  EffectiveRoot: {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
      origin: {
        type: "string",
        enum: ["host", "server", "override"],
      },
      commonDir: {
        $ref: "#/$defs/KnowledgeString",
      },
    },
    required: ["path", "origin", "commonDir"],
    additionalProperties: false,
  },
  Scope: {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: {
            const: "call",
          },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            const: "group",
          },
          groupIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: ["kind", "groupIds"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            const: "item",
          },
          itemIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: ["kind", "itemIds"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            const: "inventory",
          },
          inventoryIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: ["kind", "inventoryIds"],
        additionalProperties: false,
      },
    ],
  },
  Criterion: {
    type: "object",
    properties: {
      criterion: {
        type: "string",
      },
      matches: {
        $ref: "#/$defs/KnowledgeNumber",
      },
      outcome: {
        type: "string",
        enum: ["matched", "no_match", "outside_inventory", "not_evaluated"],
      },
      diagnosticIds: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    required: ["criterion", "matches", "outcome", "diagnosticIds"],
    additionalProperties: false,
  },
  Inventory: {
    type: "object",
    properties: {
      id: {
        type: "string",
      },
      kind: {
        type: "string",
        enum: ["repository", "tests", "sections", "units"],
      },
      rules: {
        type: "array",
        items: {
          type: "string",
        },
      },
      restrictions: {
        type: "array",
        items: {
          type: "string",
        },
      },
      discovered: {
        $ref: "#/$defs/KnowledgeNumber",
      },
      considered: {
        $ref: "#/$defs/KnowledgeNumber",
      },
      scopeRestricted: {
        type: "boolean",
      },
      criteria: {
        type: "array",
        items: {
          $ref: "#/$defs/Criterion",
        },
      },
    },
    required: [
      "id",
      "kind",
      "rules",
      "restrictions",
      "discovered",
      "considered",
      "scopeRestricted",
      "criteria",
    ],
    additionalProperties: false,
  },
  Command: {
    type: "object",
    properties: {
      execution: {
        type: "string",
        enum: [
          "not_requested",
          "unknown",
          "not_started",
          "started",
          "finished",
        ],
      },
      cwd: {
        $ref: "#/$defs/KnowledgeString",
      },
      exitCode: {
        $ref: "#/$defs/KnowledgeNullableNumber",
      },
      timedOut: {
        $ref: "#/$defs/KnowledgeBoolean",
      },
    },
    required: ["execution", "cwd", "exitCode", "timedOut"],
    additionalProperties: false,
  },
  Context: {
    type: "object",
    properties: {
      authority: {
        $ref: "#/$defs/KnowledgeAuthority",
      },
      requestedRoot: {
        $ref: "#/$defs/KnowledgeString",
      },
      effectiveRoot: {
        $ref: "#/$defs/KnowledgeEffectiveRoot",
      },
      requestedBase: {
        $ref: "#/$defs/KnowledgeString",
      },
      resolvedBase: {
        $ref: "#/$defs/KnowledgeString",
      },
      inventories: {
        type: "array",
        items: {
          $ref: "#/$defs/Inventory",
        },
      },
      command: {
        $ref: "#/$defs/Command",
      },
    },
    required: [
      "authority",
      "requestedRoot",
      "effectiveRoot",
      "requestedBase",
      "resolvedBase",
      "inventories",
      "command",
    ],
    additionalProperties: false,
  },
  Cause: {
    type: "string",
    enum: [
      "invalid_arguments",
      "internal_error",
      "file_unavailable",
      "git_failure",
      "evidence_limit",
      "invalid_root",
      "invalid_base",
      "forbidden_path",
      "ignored_path",
      "secret_pattern",
      "symlink",
      "binary_or_non_utf8",
      "missing_required",
      "empty_required",
      "ambiguous_reference",
      "reserved_key",
      "evidence_too_large",
      "group_too_large",
      "call_budget",
      "session_budget",
      "provider_context_refusal",
      "not_configured",
      "service_unavailable",
      "transport_failure",
      "invalid_response",
      "cancelled",
      "collection_empty",
      "no_changed_units",
      "criteria_no_match",
      "outside_inventory",
      "collection_omitted",
      "unsupported_syntax",
      "unresolved_runner",
      "dynamic_dependency",
      "conservative_widening",
      "control_failure",
      "evidence_disagreement",
    ],
  },
  Diagnostic: {
    type: "object",
    properties: {
      id: {
        type: "string",
      },
      cause: {
        $ref: "#/$defs/Cause",
      },
      fact: {
        type: "string",
      },
      target: {
        $ref: "#/$defs/KnowledgeString",
      },
      origin: {
        type: "string",
        enum: [
          "input",
          "note",
          "ask",
          "control",
          "collection",
          "closure",
          "runner",
          "provider",
          "budget",
        ],
      },
      scope: {
        $ref: "#/$defs/Scope",
      },
      effect: {
        type: "string",
        enum: ["blocking", "reservation"],
      },
      material: {
        type: "boolean",
      },
      omittedMembers: {
        type: "array",
        items: {
          type: "string",
        },
      },
      memberCount: {
        $ref: "#/$defs/KnowledgeNumber",
      },
      actionIds: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    required: [
      "id",
      "cause",
      "fact",
      "target",
      "origin",
      "scope",
      "effect",
      "material",
      "omittedMembers",
      "memberCount",
      "actionIds",
    ],
    additionalProperties: false,
  },
  Action: {
    type: "object",
    properties: {
      id: {
        type: "string",
      },
      code: {
        type: "string",
        enum: [
          "correct_context",
          "correct_reference",
          "provide_evidence",
          "narrow_evidence",
          "inspect_native",
          "execute_plan",
          "configure_client",
          "recover_service",
          "continue_without_judgment",
          "none",
        ],
      },
      target: {
        $ref: "#/$defs/KnowledgeString",
      },
      scope: {
        $ref: "#/$defs/Scope",
      },
      condition: {
        type: "string",
      },
      instruction: {
        type: "string",
      },
      repeatUnchanged: {
        const: false,
      },
    },
    required: [
      "id",
      "code",
      "target",
      "scope",
      "condition",
      "instruction",
      "repeatUnchanged",
    ],
    additionalProperties: false,
  },
  RawValue: {
    type: "object",
    properties: {
      label: {
        type: "string",
      },
      value: {
        type: ["string", "number", "boolean"],
      },
      probability: {
        $ref: "#/$defs/KnowledgeProbability",
      },
    },
    required: ["label", "value", "probability"],
    additionalProperties: false,
  },
  Control: {
    type: "object",
    properties: {
      id: {
        type: "string",
      },
      kind: {
        type: "string",
        enum: ["cross_check", "order", "witness", "attribution", "integrity"],
      },
      source: {
        type: "string",
        enum: ["fresh", "cache", "static"],
      },
      outcome: {
        type: "string",
      },
      rawValues: {
        type: "array",
        items: {
          $ref: "#/$defs/RawValue",
        },
      },
    },
    required: ["id", "kind", "source", "outcome", "rawValues"],
    additionalProperties: false,
  },
  Judgment: {
    type: "object",
    properties: {
      band: {
        type: "string",
        enum: ["verdict", "unsure", "abstain"],
      },
      result: {
        type: ["string", "number", "boolean"],
      },
      measure: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["probability", "confidence"],
          },
          value: {
            $ref: "#/$defs/KnowledgeProbability",
          },
        },
        required: ["kind", "value"],
        additionalProperties: false,
      },
      reason: {
        type: "string",
      },
      uncalibrated: {
        type: "boolean",
      },
      rawValues: {
        type: "array",
        items: {
          $ref: "#/$defs/RawValue",
        },
      },
      controls: {
        type: "array",
        items: {
          $ref: "#/$defs/Control",
        },
      },
    },
    required: [
      "band",
      "result",
      "measure",
      "reason",
      "uncalibrated",
      "rawValues",
      "controls",
    ],
    additionalProperties: false,
  },
  Evidence: {
    type: "object",
    properties: {
      target: {
        type: "string",
      },
      canonicalPath: {
        $ref: "#/$defs/KnowledgeString",
      },
      aliases: {
        type: "array",
        items: {
          type: "string",
        },
      },
      side: {
        type: "string",
        enum: ["current", "before", "output", "state"],
      },
      revision: {
        $ref: "#/$defs/KnowledgeString",
      },
    },
    required: ["target", "canonicalPath", "aliases", "side", "revision"],
    additionalProperties: false,
  },
  ItemCommon: {
    type: "object",
    properties: {
      id: {
        type: "string",
      },
      kind: {
        type: "string",
        enum: [
          "claim",
          "question",
          "file_question",
          "unit",
          "section",
          "requirement",
          "scenario",
          "entry",
          "pointer",
        ],
      },
      label: {
        type: "string",
      },
      groupId: {
        type: "string",
      },
      evidence: {
        type: "array",
        items: {
          $ref: "#/$defs/Evidence",
        },
      },
      diagnosticIds: {
        type: "array",
        items: {
          type: "string",
        },
      },
      actionIds: {
        type: "array",
        items: {
          type: "string",
        },
      },
      selection: {
        type: "object",
        properties: {
          selected: {
            type: "boolean",
          },
          reason: {
            type: "string",
          },
        },
        required: ["selected", "reason"],
        additionalProperties: false,
      },
    },
    required: [
      "id",
      "kind",
      "label",
      "groupId",
      "evidence",
      "diagnosticIds",
      "actionIds",
    ],
    additionalProperties: false,
  },
  Item: {
    oneOf: [
      {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
          kind: {
            type: "string",
            enum: [
              "claim",
              "question",
              "file_question",
              "unit",
              "section",
              "requirement",
              "scenario",
              "entry",
              "pointer",
            ],
          },
          label: {
            type: "string",
          },
          groupId: {
            type: "string",
          },
          evidence: {
            type: "array",
            items: {
              $ref: "#/$defs/Evidence",
            },
          },
          diagnosticIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          actionIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          selection: {
            type: "object",
            properties: {
              selected: {
                type: "boolean",
              },
              reason: {
                type: "string",
              },
            },
            required: ["selected", "reason"],
            additionalProperties: false,
          },
          treatment: {
            const: "judged",
          },
          source: {
            type: "string",
            enum: ["fresh", "cache"],
          },
          judgment: {
            $ref: "#/$defs/Judgment",
          },
        },
        required: [
          "id",
          "kind",
          "label",
          "groupId",
          "evidence",
          "diagnosticIds",
          "actionIds",
          "treatment",
          "source",
          "judgment",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
          kind: {
            type: "string",
            enum: [
              "claim",
              "question",
              "file_question",
              "unit",
              "section",
              "requirement",
              "scenario",
              "entry",
              "pointer",
            ],
          },
          label: {
            type: "string",
          },
          groupId: {
            type: "string",
          },
          evidence: {
            type: "array",
            items: {
              $ref: "#/$defs/Evidence",
            },
          },
          diagnosticIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          actionIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          selection: {
            type: "object",
            properties: {
              selected: {
                type: "boolean",
              },
              reason: {
                type: "string",
              },
            },
            required: ["selected", "reason"],
            additionalProperties: false,
          },
          treatment: {
            const: "not_judged",
          },
          source: {
            const: "none",
          },
        },
        required: [
          "id",
          "kind",
          "label",
          "groupId",
          "evidence",
          "diagnosticIds",
          "actionIds",
          "treatment",
          "source",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
          kind: {
            type: "string",
            enum: [
              "claim",
              "question",
              "file_question",
              "unit",
              "section",
              "requirement",
              "scenario",
              "entry",
              "pointer",
            ],
          },
          label: {
            type: "string",
          },
          groupId: {
            type: "string",
          },
          evidence: {
            type: "array",
            items: {
              $ref: "#/$defs/Evidence",
            },
          },
          diagnosticIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          actionIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          selection: {
            type: "object",
            properties: {
              selected: {
                type: "boolean",
              },
              reason: {
                type: "string",
              },
            },
            required: ["selected", "reason"],
            additionalProperties: false,
          },
          treatment: {
            const: "static",
          },
          source: {
            const: "none",
          },
          staticReason: {
            type: "string",
          },
        },
        required: [
          "id",
          "kind",
          "label",
          "groupId",
          "evidence",
          "diagnosticIds",
          "actionIds",
          "treatment",
          "source",
          "staticReason",
        ],
        additionalProperties: false,
      },
    ],
  },
  Accounting: {
    type: "object",
    properties: {
      toolInvocations: {
        const: 1,
      },
      httpAttempts: {
        type: "integer",
        minimum: 0,
      },
      questionsSent: {
        type: "integer",
        minimum: 0,
      },
      cacheHits: {
        type: "integer",
        minimum: 0,
      },
      cacheRequests: {
        type: "integer",
        minimum: 0,
      },
      requestedResults: {
        type: "object",
        properties: {
          total: {
            $ref: "#/$defs/KnowledgeNumber",
          },
          fresh: {
            type: "integer",
            minimum: 0,
          },
          cache: {
            type: "integer",
            minimum: 0,
          },
          notJudged: {
            type: "integer",
            minimum: 0,
          },
          static: {
            type: "integer",
            minimum: 0,
          },
        },
        required: ["total", "fresh", "cache", "notJudged", "static"],
        additionalProperties: false,
      },
      auxiliary: {
        type: "object",
        properties: {
          controls: {
            type: "object",
            properties: {
              fresh: {
                type: "integer",
                minimum: 0,
              },
              cache: {
                type: "integer",
                minimum: 0,
              },
              notJudged: {
                type: "integer",
                minimum: 0,
              },
              static: {
                type: "integer",
                minimum: 0,
              },
            },
            required: ["fresh", "cache", "notJudged", "static"],
            additionalProperties: false,
          },
          passages: {
            type: "object",
            properties: {
              fresh: {
                type: "integer",
                minimum: 0,
              },
              cache: {
                type: "integer",
                minimum: 0,
              },
              notJudged: {
                type: "integer",
                minimum: 0,
              },
            },
            required: ["fresh", "cache", "notJudged"],
            additionalProperties: false,
          },
        },
        required: ["controls", "passages"],
        additionalProperties: false,
      },
      costUsd: {
        $ref: "#/$defs/KnowledgeCost",
      },
      elapsedMs: {
        type: "number",
        minimum: 0,
      },
    },
    required: [
      "toolInvocations",
      "httpAttempts",
      "questionsSent",
      "cacheHits",
      "cacheRequests",
      "requestedResults",
      "auxiliary",
      "costUsd",
      "elapsedMs",
    ],
    additionalProperties: false,
  },
  Tool: {
    type: "string",
    enum: [
      "jev_ask",
      "jev_ask_files",
      "jev_check_diff",
      "jev_select_tests",
      "jev_find_files",
      "jev_locate_in_file",
    ],
  },
  Execution: {
    type: "string",
    enum: ["complete", "partial", "not_judged", "refused"],
  },
  ResultReportV1: {
    type: "object",
    properties: {
      schemaVersion: {
        const: 1,
      },
      tool: {
        $ref: "#/$defs/Tool",
      },
      execution: {
        $ref: "#/$defs/Execution",
      },
      context: {
        $ref: "#/$defs/Context",
      },
      items: {
        type: "array",
        items: {
          $ref: "#/$defs/Item",
        },
      },
      diagnostics: {
        type: "array",
        items: {
          $ref: "#/$defs/Diagnostic",
        },
      },
      actions: {
        type: "array",
        items: {
          $ref: "#/$defs/Action",
        },
      },
      accounting: {
        $ref: "#/$defs/Accounting",
      },
    },
    required: [
      "schemaVersion",
      "tool",
      "execution",
      "context",
      "items",
      "diagnostics",
      "actions",
      "accounting",
    ],
    additionalProperties: false,
  },
  McpStructuredResultV1: {
    type: "object",
    properties: {
      result: {
        $ref: "#/$defs/ResultReportV1",
      },
    },
    required: ["result"],
    additionalProperties: false,
  },
} as const;

export const resultReportSchema = {
  ...definitions.ResultReportV1,
  $defs: definitions,
} as const;
export const mcpStructuredResultSchema = {
  ...definitions.McpStructuredResultV1,
  $defs: definitions,
} as const;

type Schema = { readonly [key: string]: unknown };
/** Validator for the closed, local-reference JSON Schema vocabulary emitted above. */
function conforms(schema: Schema, value: unknown, root: Schema): boolean {
  if (typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#/$defs/")) return false;
    const definitions = root.$defs as Record<string, Schema>;
    const name = schema.$ref.slice("#/$defs/".length);
    const definition = Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    return definition !== undefined && conforms(definition, value, root);
  }
  if (schema.oneOf)
    return (
      (schema.oneOf as readonly Schema[]).filter((branch) =>
        conforms(branch, value, root),
      ).length === 1
    );
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !(schema.enum as readonly unknown[]).includes(value))
    return false;
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (
    types.length &&
    !types.some((type) =>
      type === "null"
        ? value === null
        : type === "array"
          ? Array.isArray(value)
          : type === "object"
            ? value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            : type === "integer"
              ? typeof value === "number" && Number.isInteger(value)
              : typeof value === type,
    )
  )
    return false;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    return false;
  if (Array.isArray(value) && schema.items)
    return value.every((v) => conforms(schema.items as Schema, v, root));
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    schema.properties
  ) {
    const properties = schema.properties as Record<string, Schema>;
    const record = value as Record<string, unknown>;
    if (
      (schema.required as readonly string[]).some(
        (key) => !Object.hasOwn(record, key),
      )
    )
      return false;
    return Object.entries(record).every(([key, v]) => {
      const property = Object.hasOwn(properties, key)
        ? properties[key]
        : undefined;
      return property !== undefined
        ? conforms(property, v, root)
        : schema.additionalProperties !== false;
    });
  }
  return true;
}

export function isResultReport(value: unknown): value is ResultReportV1 {
  return (
    conforms(resultReportSchema, value, resultReportSchema) &&
    validateResultReport(value as ResultReportV1).length === 0
  );
}
export function isMcpStructuredResult(
  value: unknown,
): value is McpStructuredResultV1 {
  if (!conforms(mcpStructuredResultSchema, value, mcpStructuredResultSchema))
    return false;
  // The schema above established the complete closed wrapper before this cast.
  const structured = value as McpStructuredResultV1;
  return validateResultReport(structured.result).length === 0;
}
