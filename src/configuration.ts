import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type PrivateStorage,
  privateStorage,
} from "./adapters/private-storage.ts";
import { createJevClient } from "./jev/client.ts";
import type { JevClient } from "./jev/types.ts";

export interface ConfigurationValues {
  url: string;
  apiKey: string;
  model: string;
}

type SavedConfiguration = Partial<ConfigurationValues>;
const fields = ["url", "apiKey", "model"] as const;
const defaults: ConfigurationValues = { url: "", apiKey: "", model: "openjev" };
const storageError = () =>
  new Error(
    "Cannot read or save Jev configuration. Check that the configuration directory and config.json are owned by you, private, regular storage without symlinks, and contain valid configuration JSON.",
  );

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function validate(values: ConfigurationValues): void {
  let validUrl = false;
  try {
    const url = new URL(values.url);
    validUrl =
      /^https?:\/\//i.test(values.url) &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "";
  } catch {
    // Keep user-controlled URL and credentials out of error messages.
  }
  if (
    !validUrl ||
    !nonempty(values.apiKey) ||
    /[^\x20-\x7e\x80-\xff]/.test(values.apiKey) ||
    !nonempty(values.model)
  ) {
    throw new Error(
      "Jev configuration requires a full HTTP(S) URL without embedded credentials, a nonempty HTTP-header-compatible API key, and a nonempty model.",
    );
  }
}

/** Effective configuration and its client move together, only after a save succeeds. */
export class ConfigController {
  private readonly environment: SavedConfiguration = {};
  private flags: SavedConfiguration = {};
  private saved: SavedConfiguration = {};
  private session: SavedConfiguration = {};
  private readonly directory: string;
  private readonly storage: PrivateStorage;
  private initialization: Promise<void> | undefined;
  private currentClient: JevClient | undefined;

  constructor(
    options: {
      env?: NodeJS.ProcessEnv;
      directory?: string;
      storage?: PrivateStorage;
    } = {},
  ) {
    const env = options.env ?? process.env;
    this.storage = options.storage ?? privateStorage();
    for (const [field, name] of [
      ["url", "JEV_TOOLS_URL"],
      ["apiKey", "JEV_TOOLS_API_KEY"],
      ["model", "JEV_TOOLS_MODEL"],
    ] as const) {
      if (nonempty(env[name])) this.environment[field] = env[name];
    }
    const base =
      nonempty(env.XDG_CONFIG_HOME) && isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : join(homedir(), ".config");
    this.directory = resolve(
      options.directory ?? join(base, "jev-agent-tools"),
    );
    if (nonempty(this.environment.url) && nonempty(this.environment.apiKey)) {
      const effective = this.values();
      validate(effective);
      this.currentClient = createJevClient(effective);
    }
  }

  get client(): JevClient | undefined {
    return this.currentClient;
  }

  initialize(flags: { url?: string; model?: string }): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.load(flags).catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  values(): ConfigurationValues {
    return {
      ...defaults,
      ...this.saved,
      ...this.session,
      ...this.flags,
      ...this.environment,
    };
  }

  locked(field: keyof ConfigurationValues): boolean {
    return (
      this.environment[field] !== undefined || this.flags[field] !== undefined
    );
  }

  async apply(values: ConfigurationValues, persist: boolean): Promise<void> {
    if (!this.initialization) {
      throw new Error("Initialize Jev configuration before applying changes.");
    }
    await this.initialization;
    const session = { ...this.session };
    for (const field of fields) {
      if (!this.locked(field)) session[field] = values[field];
    }
    const effective = {
      ...defaults,
      ...this.saved,
      ...session,
      ...this.flags,
      ...this.environment,
    };
    validate(effective);
    const saved = { ...this.saved, ...session };
    if (persist) await this.save(saved);
    const previous = this.values();
    this.session = session;
    if (persist) this.saved = saved;
    if (fields.some((field) => previous[field] !== effective[field])) {
      this.currentClient?.clearCache();
      this.currentClient = createJevClient(effective);
    } else {
      this.currentClient ??= createJevClient(effective);
    }
  }

  private async load(flags: { url?: string; model?: string }): Promise<void> {
    const saved = await this.readSaved();
    const supplied: SavedConfiguration = {};
    if (nonempty(flags.url)) supplied.url = flags.url;
    if (nonempty(flags.model)) supplied.model = flags.model;
    const effective = {
      ...defaults,
      ...saved,
      ...supplied,
      ...this.environment,
    };
    if (nonempty(effective.url) && nonempty(effective.apiKey)) {
      validate(effective);
      this.currentClient?.clearCache();
      this.currentClient = createJevClient(effective);
    }
    this.saved = saved;
    this.flags = supplied;
  }

  private async checkDirectory(): Promise<boolean> {
    // Check ancestors too: recursive mkdir and path-based reads must not follow symlinks.
    // Privacy of the directory itself is checked with its file in readSaved,
    // using the operating system's own permission model.
    let path = this.directory;
    let exists = true;
    while (true) {
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
          throw storageError();
        if (path === this.directory) exists = false;
      }
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    return exists;
  }

  private async readSaved(): Promise<SavedConfiguration> {
    try {
      if (!(await this.checkDirectory())) return {};
      const directory = {
        path: this.directory,
        stat: await lstat(this.directory),
      };
      const path = join(this.directory, "config.json");
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw storageError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          if (!(await this.storage.isPrivate([directory])))
            throw storageError();
          return {};
        }
        throw error;
      }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !(await this.storage.isPrivate([directory, { path, stat }]))
        ) {
          throw storageError();
        }
        const value: unknown = JSON.parse(await file.readFile("utf8"));
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.entries(value).some(
            ([key, entry]) =>
              !fields.some((field) => field === key) ||
              typeof entry !== "string",
          )
        ) {
          throw storageError();
        }
        return value as SavedConfiguration;
      } finally {
        await file.close();
      }
    } catch {
      throw storageError();
    }
  }

  private async save(values: SavedConfiguration): Promise<void> {
    let temporary: string | undefined;
    try {
      const existed = await this.checkDirectory();
      if (!existed) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
      }
      // Windows ignores mkdir's mode, so restrict the ACL before any secret is
      // written: always for a new directory, and for an existing one only while
      // it holds no configuration (e.g. left behind by an earlier failed save).
      // Existing configuration is never re-permissioned; readSaved refuses it.
      if (
        !existed ||
        !(await lstat(join(this.directory, "config.json")).then(
          () => true,
          () => false,
        ))
      )
        await this.storage.restrictDirectory(this.directory);
      // Refuse to replace malformed, insecure or newly introduced storage.
      await this.readSaved();
      temporary = join(this.directory, `.config-${randomUUID()}.tmp`);
      const file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(`${JSON.stringify(values, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.readSaved();
      await rename(temporary, join(this.directory, "config.json"));
      temporary = undefined;
    } catch {
      throw storageError();
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
}
