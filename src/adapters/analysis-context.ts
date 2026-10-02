import { createHash } from "node:crypto";
import type { SgNode } from "@ast-grep/napi";
import {
  type LexicalSource,
  type LexicalToken,
  tokenize,
} from "../core/lexical.ts";
import type { SyntaxRootParser } from "../core/syntax.ts";
import type { Result } from "../result.ts";
import { loadSyntaxRootParser } from "./syntax.ts";

export interface AnalysisCounter {
  parsed(path: string, fingerprint: string): void;
  tokenized(path: string, fingerprint: string): void;
  resolved(path: string, fingerprint: string): void;
}
export interface AnalysisContext extends LexicalSource {
  parser: SyntaxRootParser | undefined;
  fingerprint(text: string): string;
  counter: AnalysisCounter | undefined;
}

/** Owns one invocation's source versions; never retains repository data across calls. */
export async function createAnalysisContext(
  counter?: AnalysisCounter,
  sourceParser?: SyntaxRootParser,
): Promise<AnalysisContext> {
  const fingerprints = new Map<string, string>();
  const fingerprint = (text: string): string => {
    let value = fingerprints.get(text);
    if (value === undefined) {
      value = createHash("sha256").update(text).digest("hex");
      fingerprints.set(text, value);
    }
    return value;
  };
  const lexical = new Map<string, Map<string, LexicalToken[]>>();
  const tokenizeSource: LexicalSource["tokenize"] = (
    path,
    text,
    python = false,
  ) => {
    const version = fingerprint(text);
    let versions = lexical.get(path);
    if (!versions) {
      versions = new Map();
      lexical.set(path, versions);
    }
    const key = `${version}:${python}`;
    let tokens = versions.get(key);
    if (!tokens) {
      counter?.tokenized(path, version);
      tokens = tokenize(text, python);
      versions.set(key, tokens);
    }
    return tokens;
  };
  const source = sourceParser ?? (await loadSyntaxRootParser());
  if (!source)
    return {
      parser: undefined,
      fingerprint,
      counter,
      tokenize: tokenizeSource,
    };
  const roots = new Map<string, Map<string, Result<{ root: SgNode }>>>();
  const parser: SyntaxRootParser = {
    supports: source.supports,
    parseRaw(path, text) {
      const version = fingerprint(text);
      let versions = roots.get(path);
      if (!versions) {
        versions = new Map();
        roots.set(path, versions);
      }
      let parsed = versions.get(version);
      if (!parsed) {
        counter?.parsed(path, version);
        parsed = source.parseRaw(path, text);
        versions.set(version, parsed);
      }
      return parsed;
    },
    parse(path, text) {
      const parsed = this.parseRaw(path, text);
      if (!parsed.ok) return parsed;
      return parsed.root.find({ rule: { kind: "ERROR" } })
        ? { ok: false, error: "Source syntax incomplete" }
        : parsed;
    },
    declarations: source.declarations,
  };
  return {
    parser,
    fingerprint,
    counter,
    tokenize: tokenizeSource,
    resolved: (path, text) => counter?.resolved(path, fingerprint(text)),
  };
}
