import * as constants from "./constants.ts";
import type { Names } from "./host.ts";
import { ASK_DESCRIPTION } from "./texts/ask.ts";
export function interpolate(template: string, names: Names): string {
  const values: Record<string, unknown> = {
    ...constants,
    BAND_BOOL_GRAY_A: constants.BAND_BOOL_GRAY_A.toFixed(2),
    BAND_BOOL_YES_MIN: constants.BAND_BOOL_YES_MIN.toFixed(2),
    BAND_CHOICE_VERDICT_MIN: constants.BAND_CHOICE_VERDICT_MIN.toFixed(2),
    ...Object.fromEntries(
      Object.entries(names).map(([key, value]) => [`names.${key}`, value]),
    ),
  };
  const rendered = template.replace(/{{([^}]+)}}/g, (_match, key: string) => {
    const value = values[key];
    if (typeof value !== "string" && typeof value !== "number")
      throw new Error(`Unknown description interpolation: ${key}`);
    return String(value);
  });
  if (rendered.includes("{{"))
    throw new Error("Unresolved description interpolation.");
  return rendered;
}
export function describeAsk(names: Names): string {
  return interpolate(ASK_DESCRIPTION, names);
}
