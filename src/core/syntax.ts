import type { SgNode } from "@ast-grep/napi";
import type { Result } from "../result.ts";
import type { SyntaxParser } from "./units.ts";

export interface SyntaxRootParser extends SyntaxParser {
  parse(path: string, text: string): Result<{ root: SgNode }>;
  parseRaw(path: string, text: string): Result<{ root: SgNode }>;
}
