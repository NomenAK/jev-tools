import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkRegistryEntry,
  registryProblems,
  verifyArtifactTarball,
} from "../scripts/check-mcp-registry.ts";

interface TestNamedArgument {
  type: string;
  name: string;
  description: string;
  format: string;
  isRequired: boolean;
}

interface TestEnvironmentVariable {
  name: string;
  description: string;
  isRequired: boolean;
  isSecret?: boolean;
}

interface TestPackage {
  registryType: string;
  registryBaseUrl: string;
  identifier: string;
  version: string;
  runtimeHint: string;
  transport: { type: string; [key: string]: unknown };
  packageArguments: TestNamedArgument[];
  environmentVariables: TestEnvironmentVariable[];
}

interface TestDefinition {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  repository: { url: string; source: string };
  websiteUrl: string;
  packages: TestPackage[];
}

const baseDefinition: TestDefinition = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.NomenAK/jev-agent-tools",
  title: "Jev agent tools",
  description: "Evidence-oriented code questions.",
  version: "0.1.4",
  repository: {
    url: "https://github.com/NomenAK/jev-tools",
    source: "github",
  },
  websiteUrl: "https://github.com/NomenAK/jev-tools/blob/main/docs/mcp.md",
  packages: [
    {
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: "jev-agent-tools",
      version: "0.1.4",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      packageArguments: [
        {
          type: "named",
          name: "--root",
          description: "Repository directory.",
          format: "filepath",
          isRequired: false,
        },
      ],
      environmentVariables: [
        {
          name: "JEV_TOOLS_URL",
          description: "Endpoint URL.",
          isRequired: true,
        },
        {
          name: "JEV_TOOLS_API_KEY",
          description: "Bearer credential.",
          isRequired: true,
          isSecret: true,
        },
      ],
    },
  ],
};

function shuffledDefinition(): unknown {
  return {
    version: baseDefinition.version,
    description: baseDefinition.description,
    $schema: baseDefinition.$schema,
    packages: [
      {
        transport: { type: "stdio" },
        version: "0.1.4",
        identifier: "jev-agent-tools",
        registryBaseUrl: "https://registry.npmjs.org",
        registryType: "npm",
        runtimeHint: "npx",
        environmentVariables: [
          {
            description: "Endpoint URL.",
            isRequired: true,
            name: "JEV_TOOLS_URL",
          },
          {
            isSecret: true,
            isRequired: true,
            description: "Bearer credential.",
            name: "JEV_TOOLS_API_KEY",
          },
        ],
        packageArguments: [
          {
            isRequired: false,
            format: "filepath",
            description: "Repository directory.",
            name: "--root",
            type: "named",
          },
        ],
      },
    ],
    websiteUrl: baseDefinition.websiteUrl,
    title: baseDefinition.title,
    name: baseDefinition.name,
    repository: {
      source: "github",
      url: "https://github.com/NomenAK/jev-tools",
    },
  };
}

async function startRegistry(
  t: test.TestContext,
  handler: (
    url: string | undefined,
    respond: (status: number, body: string) => void,
  ) => void,
): Promise<string> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      handler(request.url, (status, payload) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(payload);
      });
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("registry definitions with different object key order are equal", () => {
  assert.deepEqual(registryProblems(baseDefinition, shuffledDefinition()), []);
  assert.deepEqual(registryProblems(shuffledDefinition(), baseDefinition), []);
});

test("functional differences in version, transport, args, env and array order are reported", () => {
  const versionBump = structuredClone(baseDefinition);
  versionBump.version = "0.1.5";
  assert.ok(registryProblems(baseDefinition, versionBump).length > 0);

  const transportChange = structuredClone(baseDefinition);
  const transportPackage = transportChange.packages[0];
  assert.ok(transportPackage);
  transportPackage.transport = { type: "stdio", extra: true };
  assert.ok(registryProblems(baseDefinition, transportChange).length > 0);

  const argChange = structuredClone(baseDefinition);
  const argPackage = argChange.packages[0];
  assert.ok(argPackage);
  const namedArg = argPackage.packageArguments[0];
  assert.ok(namedArg);
  namedArg.name = "--workdir";
  assert.ok(registryProblems(baseDefinition, argChange).length > 0);

  const envChange = structuredClone(baseDefinition);
  const envPackage = envChange.packages[0];
  assert.ok(envPackage);
  const envVar = envPackage.environmentVariables[0];
  assert.ok(envVar);
  envVar.isRequired = false;
  assert.ok(registryProblems(baseDefinition, envChange).length > 0);

  const reorderedEnv = structuredClone(baseDefinition);
  const reorderedPackage = reorderedEnv.packages[0];
  assert.ok(reorderedPackage);
  reorderedPackage.environmentVariables = [
    ...reorderedPackage.environmentVariables,
  ].reverse();
  assert.ok(registryProblems(baseDefinition, reorderedEnv).length > 0);

  const identifierChange = structuredClone(baseDefinition);
  const identifierPackage = identifierChange.packages[0];
  assert.ok(identifierPackage);
  identifierPackage.identifier = "other-package";
  const joined = registryProblems(baseDefinition, identifierChange).join("\n");
  assert.match(joined, /identifier/);
});

test("200 with the same definition means the entry exists, ignoring registry metadata", async (t) => {
  const registry = await startRegistry(t, (_url, respond) => {
    respond(
      200,
      JSON.stringify({
        server: baseDefinition,
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            publishedAt: "2024-01-15T10:30:00Z",
            updatedAt: "2024-01-15T11:00:00Z",
            isLatest: true,
          },
        },
      }),
    );
  });
  const result = await checkRegistryEntry(registry, baseDefinition);
  assert.deepEqual(result, { exists: true });
});

test("200 with shuffled keys still skips", async (t) => {
  const registry = await startRegistry(t, (_url, respond) => {
    respond(
      200,
      JSON.stringify({
        _meta: {
          "io.modelcontextprotocol.registry/official": { status: "active" },
        },
        server: shuffledDefinition(),
      }),
    );
  });
  const result = await checkRegistryEntry(registry, baseDefinition);
  assert.deepEqual(result, { exists: true });
});

test("registry lookup uses the versioned server URL", async (t) => {
  const seen: (string | undefined)[] = [];
  const registry = await startRegistry(t, (url, respond) => {
    seen.push(url);
    respond(200, JSON.stringify({ server: baseDefinition, _meta: {} }));
  });
  await checkRegistryEntry(registry, baseDefinition);
  assert.deepEqual(seen, [
    `/v0.1/servers/${encodeURIComponent(baseDefinition.name)}/versions/${encodeURIComponent(baseDefinition.version)}`,
  ]);
});

test("200 with a different definition fails instead of skipping", async (t) => {
  const changed = structuredClone(baseDefinition);
  changed.version = "9.9.9";
  const registry = await startRegistry(t, (_url, respond) => {
    respond(200, JSON.stringify({ server: changed, _meta: {} }));
  });
  await assert.rejects(checkRegistryEntry(registry, baseDefinition), /differs/);
});

test("200 with invalid JSON fails", async (t) => {
  const registry = await startRegistry(t, (_url, respond) => {
    respond(200, "this is not json{{{");
  });
  await assert.rejects(
    checkRegistryEntry(registry, baseDefinition),
    /invalid JSON/,
  );
});

test("200 without a server envelope or name and version fails", async (t) => {
  const missingServer = await startRegistry(t, (_url, respond) => {
    respond(200, JSON.stringify({ _meta: {} }));
  });
  await assert.rejects(
    checkRegistryEntry(missingServer, baseDefinition),
    /without a server envelope/,
  );

  const missingFields = await startRegistry(t, (_url, respond) => {
    respond(200, JSON.stringify({ server: { name: baseDefinition.name } }));
  });
  await assert.rejects(
    checkRegistryEntry(missingFields, baseDefinition),
    /name and version/,
  );
});

test("200 with malformed registry metadata fails instead of skipping", async (t) => {
  for (const meta of [
    "malformed",
    null,
    [],
    {
      "io.modelcontextprotocol.registry/official": "malformed",
    },
    {
      "io.modelcontextprotocol.registry/official": { isLatest: "yes" },
    },
  ]) {
    const registry = await startRegistry(t, (_url, respond) => {
      respond(200, JSON.stringify({ server: baseDefinition, _meta: meta }));
    });
    await assert.rejects(
      checkRegistryEntry(registry, baseDefinition),
      /metadata/,
    );
  }
});

test("404 means the version is absent", async (t) => {
  const registry = await startRegistry(t, (_url, respond) => {
    respond(404, JSON.stringify({ error: "Server not found" }));
  });
  const result = await checkRegistryEntry(registry, baseDefinition);
  assert.deepEqual(result, { exists: false });
});

test("registry errors fail instead of assuming absence", async (t) => {
  for (const status of [401, 429, 500, 502, 503]) {
    const registry = await startRegistry(t, (_url, respond) => {
      respond(status, JSON.stringify({ error: `boom ${status}` }));
    });
    await assert.rejects(
      checkRegistryEntry(registry, baseDefinition),
      new RegExp(`HTTP ${status}`),
    );
  }
});

async function makeArtifact(
  t: test.TestContext,
  serverText: string,
  embeddedText: string,
): Promise<{ serverPath: string; tarballPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jev-registry-artifact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serverPath = join(dir, "server.json");
  await writeFile(serverPath, serverText);
  const staging = join(dir, "staging");
  await mkdir(join(staging, "package"), { recursive: true });
  await writeFile(join(staging, "package", "server.json"), embeddedText);
  const tarballPath = join(dir, "package.tgz");
  execFileSync("tar", [
    "-czf",
    tarballPath,
    "-C",
    staging,
    "package/server.json",
  ]);
  return { serverPath, tarballPath };
}

test("artifact copy must equal the tarball embedded server.json", async (t) => {
  const text = `${JSON.stringify(baseDefinition, null, 2)}\n`;
  const matching = await makeArtifact(t, text, text);
  verifyArtifactTarball(matching.serverPath, matching.tarballPath);

  const changed = structuredClone(baseDefinition);
  changed.version = "9.9.9";
  const diverged = await makeArtifact(
    t,
    text,
    `${JSON.stringify(changed, null, 2)}\n`,
  );
  assert.throws(
    () => verifyArtifactTarball(diverged.serverPath, diverged.tarballPath),
    /differs/,
  );
});

test("CLI against a real HTTP registry reports skip, publish and failure", async (t) => {
  const text = `${JSON.stringify(baseDefinition, null, 2)}\n`;
  const { serverPath, tarballPath } = await makeArtifact(t, text, text);
  const script = fileURLToPath(
    new URL("../scripts/check-mcp-registry.ts", import.meta.url),
  );

  let mode: "same" | "absent" | "changed" = "same";
  const registry = await startRegistry(t, (_url, respond) => {
    if (mode === "absent")
      respond(404, JSON.stringify({ error: "Server not found" }));
    else if (mode === "changed") {
      const changed = structuredClone(baseDefinition);
      const changedPackage = changed.packages[0];
      assert.ok(changedPackage);
      const changedVar = changedPackage.environmentVariables[0];
      assert.ok(changedVar);
      changedVar.isRequired = false;
      respond(200, JSON.stringify({ server: changed }));
    } else respond(200, JSON.stringify({ server: baseDefinition, _meta: {} }));
  });

  async function runCli(
    current: string,
  ): Promise<{ code: number | null; output: string; existsFile: string }> {
    const dir = dirname(serverPath);
    const existsFile = join(dir, `github-output-${current}.txt`);
    await writeFile(existsFile, "");
    // spawn timeout bounds a hung child at the platform level, so the test
    // file itself keeps no wall-clock timer.
    const child = spawn(process.execPath, [script, serverPath, tarballPath], {
      env: {
        ...process.env,
        MCP_REGISTRY: registry,
        GITHUB_OUTPUT: existsFile,
      },
      stdio: "pipe",
      timeout: 15_000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = Promise.withResolvers<number | null>();
    child.on("exit", (code) => exited.resolve(code));
    child.on("error", (error) => exited.reject(error));
    const code = await exited.promise;
    return { code, output, existsFile };
  }

  mode = "same";
  const skipped = await runCli(mode);
  assert.equal(skipped.code, 0);
  assert.match(await readFile(skipped.existsFile, "utf8"), /exists=true/);

  mode = "absent";
  const absent = await runCli(mode);
  assert.equal(absent.code, 0);
  assert.match(await readFile(absent.existsFile, "utf8"), /exists=false/);

  mode = "changed";
  const failed = await runCli(mode);
  assert.equal(failed.code, 1);
  assert.match(failed.output, /differs/);
});
