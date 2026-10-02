import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  posixStorage,
  privateStorage,
  windowsStorage,
} from "../src/adapters/private-storage.ts";

const windowsOnly =
  process.platform === "win32" ? {} : { skip: "Windows ACL behavior" };
const stat = (mode: number, uid = process.getuid?.() ?? 0) =>
  ({ mode, uid }) as Stats;

test("each platform gets its own permission model", () => {
  assert.equal(privateStorage("win32"), windowsStorage);
  assert.equal(privateStorage("linux"), posixStorage);
  assert.equal(privateStorage("darwin"), posixStorage);
});

test("POSIX storage requires owner-only mode bits", async () => {
  const entry = (mode: number) => ({ path: "x", stat: stat(mode) });
  assert.equal(
    await posixStorage.isPrivate([entry(0o40700), entry(0o100600)]),
    true,
  );
  assert.equal(await posixStorage.isPrivate([entry(0o40750)]), false);
  assert.equal(await posixStorage.isPrivate([entry(0o100604)]), false);
});

test(
  "Windows ACLs: restricted storage is private, widened storage is not",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "jev-acl-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "config");
    await mkdir(directory);
    const entry = async (path: string) => ({ path, stat: await lstat(path) });
    await windowsStorage.restrictDirectory(directory);
    const file = join(directory, "config.json");
    await writeFile(file, "{}");
    // A new file inherits the restricted ACL.
    assert.equal(
      await windowsStorage.isPrivate([
        await entry(directory),
        await entry(file),
      ]),
      true,
    );
    // Everyone (S-1-1-0) able to read the file makes it non-private.
    execFileSync("icacls", [file, "/grant", "*S-1-1-0:(R)"]);
    assert.equal(await windowsStorage.isPrivate([await entry(file)]), false);
    // One non-private path fails the whole batch.
    assert.equal(
      await windowsStorage.isPrivate([
        await entry(directory),
        await entry(file),
      ]),
      false,
    );
    // Users (S-1-5-32-545) on the directory makes it non-private.
    execFileSync("icacls", [directory, "/grant", "*S-1-5-32-545:(OI)(CI)(R)"]);
    assert.equal(
      await windowsStorage.isPrivate([await entry(directory)]),
      false,
    );
  },
);

test(
  "Windows ACLs: unreadable and unusual paths are never private",
  windowsOnly,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "jev-acl-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const rootStat = await lstat(root);
    for (const name of ["missing", "a'b$(whoami).json", 'quote".json']) {
      assert.equal(
        await windowsStorage.isPrivate([
          { path: join(root, name), stat: rootStat },
        ]),
        false,
        name,
      );
    }
  },
);
