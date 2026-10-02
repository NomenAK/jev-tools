type SecretKey = "enter" | "escape" | "ctrl+c" | "backspace";

export interface SecretKeyHelpers {
  matchesKey(data: string, key: SecretKey): boolean;
  decodePrintableKey(data: string): string | undefined;
  isKeyRelease(data: string): boolean;
}

export interface SecretUIContext {
  ui: {
    custom<T>(
      factory: (
        tui: { requestRender(): void },
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => MaskedSecretInput,
    ): Promise<T>;
  };
}

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";

/** A dedicated input: no editor, clipboard, history, undo stack or kill ring. */
export class MaskedSecretInput {
  #characters: number[] = [];
  #pasting = false;
  #pasteLength = 0;
  #invalidPaste = false;
  #pasteRejected = false;
  #pasteMarker = "";
  #closed = false;
  #required = false;
  #title: string;
  #existing: boolean;
  #keys: SecretKeyHelpers;
  #done: (result: string | undefined) => void;
  #requestRender: () => void;

  constructor(
    title: string,
    existing: boolean,
    keys: SecretKeyHelpers,
    done: (result: string | undefined) => void,
    requestRender: () => void,
  ) {
    this.#title = title.replace(/[^\x20-\x7e]/g, "?");
    this.#existing = existing;
    this.#keys = keys;
    this.#done = done;
    this.#requestRender = requestRender;
  }

  render(width: number): string[] {
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    return [
      this.#title,
      `Key: ${"*".repeat(Math.min(this.#characters.length, columns))}`,
      this.#existing ? "Enter: save (empty keeps current key)" : "Enter: save",
      "Esc / Ctrl+C: cancel",
      this.#pasteRejected
        ? "Paste rejected: use a single line without controls."
        : "",
      this.#required ? "A key is required." : "",
    ].map((line) => line.slice(0, columns));
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (this.#pasting) {
      // Keep only a possible delimiter prefix, never a second secret buffer.
      let offset = 0;
      for (const character of data) {
        offset += character.length;
        while (
          this.#pasteMarker &&
          character !== pasteEnd[this.#pasteMarker.length]
        ) {
          this.#append(this.#pasteMarker);
          this.#pasteMarker = "";
        }
        if (character === pasteEnd[this.#pasteMarker.length]) {
          this.#pasteMarker += character;
          if (this.#pasteMarker === pasteEnd) {
            this.#pasteMarker = "";
            if (this.#invalidPaste) {
              this.#characters.fill(0, this.#pasteLength);
              this.#characters.length = this.#pasteLength;
              this.#pasteRejected = true;
            }
            this.#invalidPaste = false;
            this.#pasting = false;
            this.handleInput(data.slice(offset));
            break;
          }
        } else if (this.#pasting) {
          this.#append(character);
        }
      }
      this.#requestRender();
      return;
    }
    const start = data.indexOf(pasteStart);
    if (start !== -1) {
      if (start > 0) this.handleInput(data.slice(0, start));
      if (this.#closed) return;
      this.#pasting = true;
      this.#pasteLength = this.#characters.length;
      this.#invalidPaste = false;
      this.#pasteRejected = false;
      this.handleInput(data.slice(start + pasteStart.length));
      return;
    }
    if (this.#keys.isKeyRelease(data)) return;
    if (
      this.#keys.matchesKey(data, "escape") ||
      this.#keys.matchesKey(data, "ctrl+c")
    ) {
      this.#finish(undefined);
      return;
    }
    if (this.#keys.matchesKey(data, "enter")) {
      if (!this.#characters.length && !this.#existing) {
        this.#required = true;
        this.#requestRender();
        return;
      }
      // Strings supplied by the terminal and returned to the caller are immutable;
      // JavaScript cannot guarantee their erasure. Our retained numeric buffer can.
      const result = this.#characters
        .map((codepoint) => String.fromCodePoint(codepoint))
        .join("");
      this.#finish(result);
      return;
    }
    if (this.#keys.matchesKey(data, "backspace")) {
      if (this.#characters.length) {
        this.#characters[this.#characters.length - 1] = 0;
        this.#characters.pop();
      }
      this.#required = false;
      this.#requestRender();
      return;
    }
    const printable = this.#keys.decodePrintableKey(data);
    if (printable !== undefined) this.#append(printable);
    else if (
      [...data].every((character) => {
        const code = character.codePointAt(0) as number;
        return code >= 0x20 && (code < 0x7f || code > 0x9f);
      })
    )
      this.#append(data);
    this.#requestRender();
  }

  #append(text: string): void {
    for (const character of text) {
      const code = character.codePointAt(0) as number;
      if (this.#pasting && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) {
        this.#invalidPaste = true;
        continue;
      }
      this.#characters.push(character.codePointAt(0) as number);
    }
    this.#required = false;
  }

  #finish(result: string | undefined): void {
    this.dispose();
    this.#done(result);
  }

  invalidate(): void {
    // Rendering has no cache or theme-dependent state.
  }

  dispose(): void {
    this.#characters.fill(0);
    this.#characters.length = 0;
    this.#pasteMarker = "";
    this.#pasting = false;
    this.#pasteLength = 0;
    this.#invalidPaste = false;
    this.#pasteRejected = false;
    this.#required = false;
    this.#closed = true;
  }
}

/** Caller must restrict this to the host's interactive TUI mode. */
export async function readSecret(
  ctx: SecretUIContext,
  title: string,
  existing: boolean,
): Promise<string | undefined> {
  // Both hosts provide this module at runtime; pi exports decodeKittyPrintable and
  // omp exports decodePrintableKey, so static package resolution cannot be used.
  const hostKeys = await import("@earendil-works/pi-tui");
  const decodePrintableKey =
    hostKeys.decodeKittyPrintable ?? hostKeys.decodePrintableKey;
  if (!decodePrintableKey) {
    throw new Error(
      "This host cannot decode printable keys for masked Jev setup; use environment variables.",
    );
  }
  const keys: SecretKeyHelpers = { ...hostKeys, decodePrintableKey };
  let input: MaskedSecretInput | undefined;
  try {
    return await ctx.ui.custom<string | undefined>(
      (tui, _theme, _keybindings, done) => {
        input = new MaskedSecretInput(title, existing, keys, done, () =>
          tui.requestRender(),
        );
        return input;
      },
    );
  } finally {
    input?.dispose();
  }
}
