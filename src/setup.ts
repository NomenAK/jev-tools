import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ConfigController, ConfigurationValues } from "./configuration.ts";
import { readSecret } from "./secret-input.ts";

type SetupContext = Pick<ExtensionContext, "ui" | "hasUI"> & {
  mode?: string;
  agent?: { kind: string };
};
type SetupAPI = Pick<
  ExtensionAPI,
  "on" | "registerFlag" | "getFlag" | "registerCommand"
>;

/** Setup never sends credentials to the conversation or starts a model turn. */
export class Setup {
  private offered = false;
  private busy = false;
  private readonly config: ConfigController;
  private readonly promptSecret: typeof readSecret;
  constructor(
    config: ConfigController,
    promptSecret: typeof readSecret = readSecret,
  ) {
    this.config = config;
    this.promptSecret = promptSecret;
  }

  attach(api: SetupAPI): void {
    api.registerFlag("jev-skip-setup", {
      type: "boolean",
      default: false,
      description: "Skip the interactive Jev configuration offer",
    });
    api.registerFlag("jev-url", {
      type: "string",
      description:
        "Jev endpoint URL for this run (environment takes precedence)",
    });
    api.registerFlag("jev-model", {
      type: "string",
      description: "Jev model for this run, not the conversation model",
    });
    const initialize = async () => {
      const url = api.getFlag("jev-url");
      const model = api.getFlag("jev-model");
      await this.config.initialize({
        ...(typeof url === "string" ? { url } : {}),
        ...(typeof model === "string" ? { model } : {}),
      });
    };
    api.on("session_start", async (_event, ctx) => {
      try {
        await initialize();
        if (
          !this.interactive(ctx) ||
          this.offered ||
          this.config.client ||
          api.getFlag("jev-skip-setup")
        )
          return;
        this.offered = true;
        // Host event deadlines bound work, not the time needed to find credentials.
        // Return before waiting for input so omp clears the handler's UI abort timer.
        void this.offer(ctx).catch((error: unknown) => {
          ctx.ui.notify(this.message(error), "error");
        });
      } catch (error) {
        if (this.interactive(ctx)) ctx.ui.notify(this.message(error), "error");
      }
    });
    api.registerCommand("jev-setup", {
      description: "Configure the Jev endpoint, model and API key",
      handler: async (_args, ctx) => {
        if (!this.interactive(ctx)) {
          ctx.ui.notify(
            "Jev setup requires the main interactive terminal. Use JEV_TOOLS_URL, JEV_TOOLS_MODEL and JEV_TOOLS_API_KEY for headless runs.",
            "warning",
          );
          return;
        }
        try {
          await initialize();
          await this.configure(ctx);
        } catch (error) {
          ctx.ui.notify(this.message(error), "error");
        }
      },
    });
  }

  private interactive(ctx: SetupContext): boolean {
    return ctx.mode === "tui" && ctx.hasUI && ctx.agent?.kind !== "sub";
  }

  private message(error: unknown): string {
    // Configuration errors are deliberately credential-free.
    return error instanceof Error
      ? error.message
      : "Jev configuration failed; the previous configuration was kept.";
  }

  private async offer(ctx: SetupContext): Promise<void> {
    const choice = await ctx.ui.select(
      "Jev Tools needs an endpoint and API key",
      ["Configure now", "Later"],
    );
    if (choice === "Configure now") await this.configure(ctx);
  }

  private async configure(ctx: SetupContext): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const values: ConfigurationValues = this.config.values();
      for (const field of ["url", "model"] as const) {
        if (this.config.locked(field)) {
          ctx.ui.notify(
            `Jev ${field} is controlled by the environment or a launch flag; change it before restarting.`,
            "info",
          );
          continue;
        }
        const label =
          field === "url"
            ? "Complete Jev endpoint URL"
            : "Jev model (not the conversation model)";
        const answer = await ctx.ui.input(
          label,
          values[field] ||
            (field === "model"
              ? "openjev"
              : "https://your-service.example/v1/systemone"),
        );
        if (answer === undefined) return;
        values[field] = answer.trim() || values[field];
      }
      if (this.config.locked("apiKey")) {
        ctx.ui.notify(
          "The Jev API key is supplied by the environment and will not be saved.",
          "info",
        );
      } else {
        const key = await this.promptSecret(
          ctx,
          "Jev API key",
          Boolean(values.apiKey),
        );
        if (key === undefined) return;
        values.apiKey = key || values.apiKey;
      }
      const storage = await ctx.ui.select("Apply Jev configuration", [
        "This session only",
        "Save for future sessions (editable values and plaintext key in a private global file)",
      ]);
      if (storage === undefined) return;
      await this.config.apply(values, storage !== "This session only");
      ctx.ui.notify(
        storage === "This session only"
          ? "Jev configuration applied for this session; no file was written."
          : "Jev configuration applied and saved outside the repository. The stored key is plaintext, not encrypted.",
        "info",
      );
    } finally {
      this.busy = false;
    }
  }
}
