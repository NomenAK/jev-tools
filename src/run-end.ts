import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import {
  FLAG_MIN,
  HOOK_BUDGET_MS,
  RUN_END_DOCS_MAX_CALLS,
} from "./constants.ts";
import type { ToolDependencies } from "./runtime.ts";
import { runEndMessage } from "./texts/run-end.ts";
import { runDocsCheck } from "./tools/docs-check.ts";

interface RunEndContext {
  cwd: string;
  agent?: { kind: string };
}
interface RunEndEvent {
  stop_hook_active?: boolean;
  outcome?: string;
  entries?: SessionBoundaryDraft[];
}
export interface RunEndHost {
  on(
    name: "before_agent_start" | "session_stop" | "agent_before_settle",
    handler: (event: RunEndEvent, ctx: RunEndContext) => unknown,
  ): unknown;
}
interface RunEndOptions {
  check?: typeof runDocsCheck;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}
/** One automatic documentation check per user prompt, shared by both hosts. */
export class RunEnd {
  private triggered = false;
  private checking = false;
  private generation = 0;
  private readonly deps: ToolDependencies;
  private readonly check: typeof runDocsCheck;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  constructor(deps: ToolDependencies, options: RunEndOptions = {}) {
    this.deps = deps;
    this.check = options.check ?? runDocsCheck;
    this.now = options.now ?? (() => performance.now());
    this.env = options.env ?? process.env;
  }
  attach(api: RunEndHost): void {
    api.on("before_agent_start", () => {
      this.triggered = false;
      this.generation++;
    });
    api.on("session_stop", async (event, ctx) => {
      if (
        !this.deps.host.isOmp ||
        event.stop_hook_active ||
        ctx.agent?.kind === "sub"
      )
        return;
      const message = await this.onRunEnd(ctx);
      if (message) return { continue: true, additionalContext: message };
    });
    api.on("agent_before_settle", async (event, ctx) => {
      if (this.deps.host.isOmp || event.outcome !== "completed") return;
      const message = await this.onRunEnd(ctx);
      if (message)
        return {
          continue: true,
          entries: [
            ...(event.entries ?? []),
            {
              type: "custom_message",
              customType: "jev-check-diff",
              content: message,
              display: false,
            },
          ],
        };
    });
  }
  async onRunEnd(ctx: RunEndContext): Promise<string | undefined> {
    if (
      !this.deps.client ||
      this.env.JEV_TOOLS_AUTO_DOCS === "0" ||
      this.deps.runtime.session.refusal() !== undefined ||
      this.triggered ||
      this.checking
    )
      return;
    this.checking = true;
    const generation = this.generation;
    const started = this.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, HOOK_BUDGET_MS);
    });
    const work = async (): Promise<string | undefined> => {
      const status = await this.deps.exec(
        "git",
        [
          "--no-optional-locks",
          "status",
          "--porcelain",
          "--untracked-files=normal",
        ],
        {
          cwd: ctx.cwd,
          signal: controller.signal,
          timeout: HOOK_BUDGET_MS,
        },
      );
      const remaining = HOOK_BUDGET_MS - (this.now() - started);
      if (
        status.code ||
        status.killed ||
        !status.stdout.trim() ||
        remaining <= 0 ||
        controller.signal.aborted
      )
        return;
      if (generation !== this.generation) return;
      this.triggered = true;
      const result = await this.check(this.deps, {
        cwd: ctx.cwd,
        signal: controller.signal,
        budgetMs: remaining,
        maxCalls: RUN_END_DOCS_MAX_CALLS,
      });
      if (
        !result.ok ||
        result.status === "budget_exceeded" ||
        result.status === "refused" ||
        controller.signal.aborted ||
        this.now() - started >= HOOK_BUDGET_MS ||
        result.envelope.lines.some((line) => line.type === "refusal")
      )
        return;
      const flagged = result.findings.filter(
        (finding) =>
          finding.band === "verdict" &&
          finding.probability >= FLAG_MIN &&
          finding.sentence,
      );
      if (!flagged.length) return;
      return runEndMessage(flagged);
    };
    try {
      const message = await Promise.race([work(), expired]);
      if (message && generation === this.generation) {
        return message;
      }
    } catch {
      // An automatic check must not interrupt settlement on git/Jev failure.
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.checking = false;
    }
  }
}
