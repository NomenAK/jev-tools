import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigController } from "./configuration.ts";
import { Guide } from "./guide.ts";
import { detectHost } from "./host.ts";
import { RunEnd, type RunEndHost } from "./run-end.ts";
import { readSessionLimits, Session } from "./session.ts";
import { Setup } from "./setup.ts";
import { createAskTool } from "./tools/ask.ts";
import { createAskFilesTool } from "./tools/ask-files.ts";
import { createCheckDiffTool } from "./tools/check-diff.ts";
import { createFindFilesTool } from "./tools/find.ts";
import { createLocateTool } from "./tools/locate.ts";
import { createSelectTestsTool } from "./tools/select-tests.ts";
export default function extension(api: ExtensionAPI & { pi?: unknown }): void {
  const host = detectHost(api);
  const config = new ConfigController();
  const runtime = {
    session: new Session(readSessionLimits(process.env)),
    guide: new Guide(host),
  };
  runtime.guide.attach(api);
  api.on("session_start", async () => {
    runtime.session.reset();
    runtime.guide.reset();
    config.client?.clearCache();
    if (host.isOmp) {
      const active = api.getActiveTools();
      if (!active.includes("find"))
        await api.setActiveTools([...active, "jev_find_files"]);
    }
  });
  new Setup(config).attach(api);
  const dependencies = {
    get client() {
      return config.client;
    },
    host,
    runtime,
    exec: api.exec.bind(api),
  };
  new RunEnd(dependencies).attach(api as unknown as RunEndHost);
  api.registerTool(createAskTool(dependencies));
  api.registerTool(createSelectTestsTool(dependencies));
  api.registerTool(createCheckDiffTool(dependencies));
  api.registerTool(createFindFilesTool(dependencies));
  api.registerTool(createLocateTool(dependencies));
  api.registerTool(createAskFilesTool(dependencies));
}
