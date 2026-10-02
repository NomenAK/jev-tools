import type { ImportSource } from "./imports.ts";
import type { Limitation } from "./output.ts";

export interface ProofDeclaration {
  path: string;
  name: string;
  text: string;
  before?: string | null;
  usedNames: readonly string[];
  fixture?: boolean;
  autouse?: boolean;
  deleted?: boolean;
}
export interface ProofBinding {
  path: string;
  local: string;
  imported: string;
  specifier: string;
  reexport: boolean;
  used?: boolean;
  typeOnly?: boolean;
  valueMembers?: readonly string[];
  data?: boolean;
}
export interface ProofSyntax {
  declarations: readonly ProofDeclaration[];
  bindings: readonly ProofBinding[];
  limits: readonly Limitation[];
  sources?: readonly ImportSource[];
  uses?: ReadonlyMap<string, readonly string[]>;
  before?: Readonly<Record<string, string | null>>;
}
