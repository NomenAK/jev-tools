import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { interpolate } from "./describe.ts";
import type { Host } from "./host.ts";
import { GUIDE_TEMPLATE } from "./texts/guide.ts";

const policy = readFileSync(
  new URL("../rules/jev-ask.md", import.meta.url),
  "utf8",
)
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
  .trim();

export interface GuideContext {
  addAdditionalContext?: (text: string) => void;
}
export class Guide {
  private delivered = false;
  private readonly host: Host;
  readonly text: string;
  constructor(host: Host) {
    this.host = host;
    this.text = interpolate(GUIDE_TEMPLATE, host.names);
  }
  attach(api: Pick<ExtensionAPI, "on">): void {
    api.on("before_agent_start", (event) => {
      if (!this.host.isOmp) {
        if (
          event.systemPromptOptions.selectedTools.some((name) =>
            name.startsWith("jev_"),
          )
        )
          event.systemPromptOptions.sections.jev_guide = this.text;
        else delete event.systemPromptOptions.sections.jev_guide;
        if (event.systemPromptOptions.selectedTools.includes("jev_ask"))
          event.systemPromptOptions.sections.jev_policy = policy;
        else delete event.systemPromptOptions.sections.jev_policy;
      }
    });
    api.on("session_compact", () => {
      this.reset();
    });
  }
  deliver(ctx: GuideContext): void {
    if (this.host.isOmp && !this.delivered && ctx.addAdditionalContext) {
      ctx.addAdditionalContext(this.text);
      this.delivered = true;
    }
  }
  reset(): void {
    this.delivered = false;
  }
}
