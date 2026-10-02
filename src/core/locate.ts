import {
  CHOICE_MAX_OPTIONS,
  LOCATE_VERDICT_MIN,
  STATE_MAX_CHARS,
} from "../constants.ts";
import type { State } from "../jev/types.ts";
import type { Candidate } from "./output.ts";
import type { Section } from "./sections.ts";
import { truncate } from "./truncate.ts";

export function sectionState(
  path: string,
  goal: string,
  sections: readonly Section[],
  outline = false,
): State {
  return {
    path,
    goal,
    sections: sections.map((section) => ({
      id: section.id,
      lines: `${section.start}-${section.end}`,
      text: outline ? section.label : section.text,
    })),
  };
}
export function sectionStateFits(
  path: string,
  goal: string,
  sections: readonly Section[],
  outline = false,
): boolean {
  return (
    sections.length < CHOICE_MAX_OPTIONS &&
    JSON.stringify(sectionState(path, goal, sections, outline)).length <=
      STATE_MAX_CHARS
  );
}
/** Every planned block has at least two sections and fits its full-text refinement budget. */
export function sectionOutline(
  path: string,
  goal: string,
  sections: readonly Section[],
): Section[] {
  const base = JSON.stringify(sectionState(path, goal, [])).length;
  const costs = new Map(
    sections.map((section) => [
      section,
      JSON.stringify({
        id: section.id,
        lines: `${section.start}-${section.end}`,
        text: "",
      }).length +
        (section.serializedTextChars ?? JSON.stringify(section.text).length) -
        2,
    ]),
  );
  const fits = (items: readonly Section[]) =>
    items.length < CHOICE_MAX_OPTIONS &&
    base + items.reduce((sum, item) => sum + (costs.get(item) ?? 0) + 1, 0) <=
      STATE_MAX_CHARS;
  const groups: Section[][] = [];
  let current: Section[] = [],
    currentSize = base;
  for (const section of sections) {
    const length = (costs.get(section) ?? 0) + 1;
    if (base + length > STATE_MAX_CHARS) return [];
    const owner = section.label.split(".")[0],
      previousOwner = current.at(-1)?.label.split(".")[0];
    if (
      current.length &&
      (currentSize + length > STATE_MAX_CHARS ||
        current.length + 1 >= CHOICE_MAX_OPTIONS ||
        (current.length >= 2 &&
          section.label.includes(".") &&
          owner !== previousOwner))
    ) {
      groups.push(current);
      current = [];
      currentSize = base;
    }
    current.push(section);
    currentSize += length;
  }
  if (current.length) groups.push(current);
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (!group || group.length >= 2) continue;
    const previous = groups[index - 1],
      next = groups[index + 1];
    if (previous && fits([...previous, ...group])) {
      previous.push(...group);
      groups.splice(index, 1);
      index--;
      continue;
    }
    if (next && fits([...group, ...next])) {
      next.unshift(...group);
      groups.splice(index, 1);
      index--;
      continue;
    }
    if (previous && previous.length > 2) {
      const moved = previous.at(-1);
      if (moved && fits([moved, ...group])) {
        previous.pop();
        group.unshift(moved);
        continue;
      }
    }
    if (next && next.length > 2) {
      const moved = next[0];
      if (moved && fits([...group, moved])) {
        next.shift();
        group.push(moved);
        continue;
      }
    }
    return [];
  }
  return groups.map((group, index) => ({
    id: `B${index + 1}`,
    start: group[0]?.start ?? 0,
    end: group.at(-1)?.end ?? 0,
    label: group.map((s) => s.label).join(" / "),
    text: group.map((s) => s.text).join("\n"),
  }));
}
/** JSON-escaped budget, allocated equally then redistributed to larger blocks. */
export function outlineEvidence(
  path: string,
  goal: string,
  blocks: readonly Section[],
): Section[] {
  const overhead = JSON.stringify(
    sectionState(
      path,
      goal,
      blocks.map((block) => ({ ...block, text: "" })),
    ),
  ).length;
  let remaining = Math.max(0, STATE_MAX_CHARS - overhead);
  const allocations = blocks.map(() => 0);
  let active = blocks.map((_, index) => index);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    const next: number[] = [];
    for (const index of active) {
      const block = blocks[index];
      if (!block) continue;
      const need =
        JSON.stringify(block.text).length - 2 - (allocations[index] ?? 0);
      const granted = Math.min(need, share, remaining);
      allocations[index] = (allocations[index] ?? 0) + granted;
      remaining -= granted;
      if (need > granted) next.push(index);
    }
    active = next;
  }
  return blocks.map((block, index) => {
    const budget = allocations[index] ?? 0;
    if (JSON.stringify(block.text).length - 2 <= budget) return { ...block };
    const excerpt = (chars: number) => {
      const part = Math.floor(chars / 3);
      const slice = (start: number) => {
        if (start > 0 && /[\uDC00-\uDFFF]/.test(block.text[start] ?? ""))
          start++;
        return truncate(block.text.slice(start), part);
      };
      return `${slice(0)}\n…\n${slice(Math.max(0, Math.floor(block.text.length / 2) - Math.floor(part / 2)))}\n…\n${slice(Math.max(0, block.text.length - part))}`;
    };
    let low = 0,
      high = Math.min(block.text.length, budget),
      text = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2),
        candidate = excerpt(middle);
      if (JSON.stringify(candidate).length - 2 <= budget) {
        text = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    return { ...block, text };
  });
}
export function locateDisplay(
  path: string,
  sections: readonly Section[],
  ranked: readonly { id: string; p: number }[],
  forceUnsure: boolean,
) {
  const head = ranked[0];
  if (!head) return undefined;
  const display = (id: string, p: number): Candidate => {
    const section = sections.find((s) => s.id === id);
    return {
      label: section ? `${path}:${section.start}-${section.end}` : "none",
      value: { head: section?.label ?? "no section fits", p },
    };
  };
  const band =
    forceUnsure || head.p < LOCATE_VERDICT_MIN
      ? ("unsure" as const)
      : ("verdict" as const);
  return {
    primary: display(head.id, head.p),
    band,
    candidates:
      band === "unsure"
        ? ranked.slice(1, 2).map((s) => display(s.id, s.p))
        : undefined,
  };
}
