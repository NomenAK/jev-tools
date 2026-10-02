export type GitExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
