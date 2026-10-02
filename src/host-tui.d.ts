// Runtime implementations are supplied by the pi/omp extension loader.
declare module "@earendil-works/pi-tui" {
  export function matchesKey(
    data: string,
    key: "enter" | "escape" | "backspace" | "ctrl+c" | "ctrl+u",
  ): boolean;
  export const decodePrintableKey:
    | ((data: string) => string | undefined)
    | undefined;
  export const decodeKittyPrintable:
    | ((data: string) => string | undefined)
    | undefined;
  export function isKeyRelease(data: string): boolean;
}
