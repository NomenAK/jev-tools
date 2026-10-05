import {
  AUTOMATIC_DOCS_POLICY,
  CHECK_DIFF_GUIDELINE,
  GUIDE_TEMPLATE as COMMON_GUIDE_TEMPLATE,
} from "./instructions.ts";

/** pi/OMP host delivery; MCP uses renderAgentInstructions with its own hook policy. */
export const GUIDE_TEMPLATE = `${COMMON_GUIDE_TEMPLATE}\n\n${CHECK_DIFF_GUIDELINE}\n\n${AUTOMATIC_DOCS_POLICY}`;
