/** Base-name globs of likely secret files, matched case-insensitively. */
export const SECRET_NAME_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "id_rsa*",
  "*.p12",
  "credentials*",
  "secrets*",
] as const;
/** Value-free templates that stay admitted despite the `.env.*` rule. */
const templates = [".env.example", ".env.sample", ".env.template"];

/**
 * True when a path's base name matches SECRET_NAME_GLOBS (any depth,
 * case-insensitive) and is not a value-free `.env` template. Such files are
 * refused before their content is read, on every evidence admission path;
 * there is no per-call override.
 */
export function isSecretPath(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (templates.includes(name)) return false;
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.startsWith("id_rsa") ||
    name.endsWith(".p12") ||
    name.startsWith("credentials") ||
    name.startsWith("secrets")
  );
}

/** Refusal text for a secret-named path: names the path, never its content. */
export function secretRefusal(path: string): string {
  return `${path}: secret file name (secret_pattern): content not read, not sent to Jev`;
}
