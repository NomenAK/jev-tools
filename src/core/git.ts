export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
export type GitExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<GitResult>;
