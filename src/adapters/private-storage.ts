import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { join } from "node:path";

/**
 * Owner-only storage, checked with each operating system's own model.
 *
 * POSIX: no group/other mode bits and owned by the current user.
 * Windows: mode bits are synthesized (always 0o666), so the real ACL is read.
 * Storage is private when every allow entry belongs to the current user,
 * SYSTEM or the Administrators group (the Windows equivalent of root), and
 * the owner is the current user or Administrators. Entries are compared as
 * SIDs, so localized account names do not matter.
 */
export interface PrivateStorage {
  /** True when every path is private. One check for all paths. */
  isPrivate(
    entries: readonly { path: string; stat: Stats }[],
  ): Promise<boolean>;
  /** Restrict a directory the current user owns so new files inherit privacy. */
  restrictDirectory(path: string): Promise<void>;
}

const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const CREATOR_OWNER = "S-1-3-0";

export const posixStorage: PrivateStorage = {
  async isPrivate(entries) {
    return entries.every(
      ({ stat }) =>
        (stat.mode & 0o077) === 0 &&
        (!process.getuid || stat.uid === process.getuid()),
    );
  },
  async restrictDirectory() {
    // mkdir(..., { mode: 0o700 }) already creates POSIX directories privately.
  },
};

// Paths arrive as JSON in an environment variable, never in the command text.
const CHECK = `$ErrorActionPreference = 'Stop'
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($me, '${SYSTEM}', '${ADMINISTRATORS}')
$sid = [System.Security.Principal.SecurityIdentifier]
$results = foreach ($path in (ConvertFrom-Json $env:JEV_PRIVATE_PATHS)) {
  try {
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner($sid).Value
    $private = ($owner -eq $me) -or ($owner -eq '${ADMINISTRATORS}')
    foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
      if ($rule.AccessControlType -ne 'Allow') { continue }
      $id = $rule.IdentityReference.Value
      $inheritOnly = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
      if ($id -eq '${CREATOR_OWNER}' -and $inheritOnly) { continue }
      if ($trusted -notcontains $id) { $private = $false }
    }
    $private
  } catch { $false }
}
ConvertTo-Json -Compress @($results)`;

const RESTRICT = `$ErrorActionPreference = 'Stop'
$path = $env:JEV_PRIVATE_PATH
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $me.Value) { throw 'not owner' }
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($id in @($me.Value, '${SYSTEM}', '${ADMINISTRATORS}')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    (New-Object System.Security.Principal.SecurityIdentifier($id)),
    'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl`;

function powershell(
  script: string,
  env: Record<string, string>,
): Promise<string> {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  // A fixed system path, so a powershell.exe earlier on PATH is never used.
  const executable = join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // PowerShell 7 parents export PSModulePath, which stops Windows PowerShell
  // 5.1 from loading its own Get-Acl module; 5.1 rebuilds it when unset.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(childEnv))
    if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        // UTF-16LE base64 runs the script as one unit; stdin runs line by line.
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env: childEnv, windowsHide: true, timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export const windowsStorage: PrivateStorage = {
  async isPrivate(entries) {
    if (!entries.length) return true;
    try {
      const output = await powershell(CHECK, {
        JEV_PRIVATE_PATHS: JSON.stringify(entries.map(({ path }) => path)),
      });
      const results: unknown = JSON.parse(output.trim());
      return (
        Array.isArray(results) &&
        results.length === entries.length &&
        results.every((result) => result === true)
      );
    } catch {
      // An ACL that cannot be read is never treated as private.
      return false;
    }
  },
  async restrictDirectory(path) {
    await powershell(RESTRICT, { JEV_PRIVATE_PATH: path });
  },
};

export function privateStorage(
  platform: NodeJS.Platform = process.platform,
): PrivateStorage {
  return platform === "win32" ? windowsStorage : posixStorage;
}
