export type VersionedRunner = "vitest" | "jest" | "mocha";

export function runnerVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
    ? value
    : undefined;
}

/** Parse only resolved lock versions, never dependency ranges or executable configuration. */
export function lockedRunnerVersion(
  runner: VersionedRunner,
  path: string,
  text: string,
): string | undefined {
  if (path.endsWith("package-lock.json")) {
    try {
      const lock = JSON.parse(text) as {
        packages?: Record<string, { version?: unknown }>;
        dependencies?: Record<string, { version?: unknown }>;
      };
      return runnerVersion(
        lock.packages?.[`node_modules/${runner}`]?.version ??
          lock.dependencies?.[runner]?.version,
      );
    } catch {
      return undefined;
    }
  }
  if (path.endsWith("bun.lock")) {
    const match = new RegExp(
      `"${runner}"\\s*:\\s*\\[\\s*"${runner}@(\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?)"`,
    ).exec(text);
    return runnerVersion(match?.[1]);
  }
  if (path.endsWith("pnpm-lock.yaml")) {
    const rootImporter =
      /(?:^|\n) {2}\.:\s*\n([\s\S]*?)(?=\n {2}[^ ]|\n[^ ]|$)/.exec(text)?.[1] ??
      "";
    const block = new RegExp(
      `(?:^|\\n)\\s{4,}${runner}:\\s*\\n\\s+specifier:[^\\n]*\\n\\s+version:\\s*['"]?([^\\s'"(]+)`,
    ).exec(rootImporter);
    return runnerVersion(block?.[1]);
  }
  if (path.endsWith("yarn.lock")) {
    const expression = new RegExp(
      `(?:^|\\n)["']?${runner}@[^\\n]*:\\s*\\n(?:[^\\n]*\\n)*?\\s+version[ :]+["']?([^\\s"']+)`,
      "g",
    );
    const versions = new Set(
      [...text.matchAll(expression)].map((match) => runnerVersion(match[1])),
    );
    return versions.size === 1 ? [...versions][0] : undefined;
  }
  return undefined;
}
// Only identity-smoked release lines can receive native name filters.
export const VERIFIED_NAME_FILTERS = {
  vitest: [
    { version: /^3\.2\.\d+$/, separator: " " },
    { version: /^4\.1\.\d+$/, separator: " " },
    { version: /^5\.0\.\d+$/, separator: " > " },
  ],
  jest: [{ version: /^30\.\d+\.\d+$/, separator: " " }],
  mocha: [{ version: /^11\.8\.0$/, separator: " " }],
} as const;
