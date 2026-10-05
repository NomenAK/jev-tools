import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { mcpHost } from "../src/host.ts";
import {
  renderMcpProjectBlock,
  renderOmpRule,
} from "../src/texts/instructions.ts";

const START = "<!-- BEGIN GENERATED JEV INSTRUCTIONS -->";
const END = "<!-- END GENERATED JEV INSTRUCTIONS -->";

export function replaceInstructionBlock(
  document: string,
  block: string,
): string {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (
    start < 0 ||
    end < start ||
    document.indexOf(START, start + START.length) >= 0 ||
    document.indexOf(END, end + END.length) >= 0
  )
    throw new Error("Expected exactly one generated instruction block.");
  return `${document.slice(0, start)}${START}\n\n\`\`\`markdown\n${block}\`\`\`\n\n${document.slice(end)}`;
}

export async function generateInstructions(check = false): Promise<void> {
  const docs = new URL("../docs/agent-instructions.md", import.meta.url);
  const currentDocs = await readFile(docs, "utf8");
  const outputs = [
    {
      path: new URL("../rules/jev-ask.md", import.meta.url),
      text: renderOmpRule(),
    },
    {
      path: docs,
      text: replaceInstructionBlock(
        currentDocs,
        renderMcpProjectBlock(mcpHost().names),
      ),
    },
  ];
  for (const { path, text } of outputs) {
    if (check) {
      if ((await readFile(path, "utf8")) !== text)
        throw new Error(`Stale generated instructions: ${path.pathname}`);
    } else await writeFile(path, text);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Usage: node scripts/generate-instructions.ts [--check]");
  await generateInstructions(args.includes("--check"));
}
