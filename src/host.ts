export interface Host {
  isOmp: boolean;
  names: Names;
}
export function detectHost(api: { pi?: unknown }): Host {
  const isOmp = api.pi !== undefined;
  return {
    isOmp,
    names: {
      grep: "grep",
      byName: isOmp ? "glob" : "find",
      semantic: isOmp
        ? "find or jev_find_files, whichever is available"
        : "jev_find_files",
    },
  };
}
export interface Names {
  grep: string;
  byName: string;
  semantic: string;
}
