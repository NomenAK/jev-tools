import type { GitExec } from "./core/git.ts";
import type { Guide } from "./guide.ts";
import type { Host } from "./host.ts";
import type { JevClient } from "./jev/types.ts";
import type { Session } from "./session.ts";

export interface ToolRuntime {
  session: Session;
  guide: Guide;
}
export interface ToolDependencies {
  client: JevClient | undefined;
  host: Host;
  runtime: ToolRuntime;
  exec: GitExec;
  evidenceOrigin?: "host" | "server";
  /**
   * Configured Jev API key (environment or saved configuration), redacted
   * from command output before it can reach a state.
   */
  apiKey?: string | undefined;
}
