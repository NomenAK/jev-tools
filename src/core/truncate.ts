/** Keep a UTF-16 prefix without splitting a valid surrogate pair. */
export function truncate(text: string, maxChars: number): string {
  let end = Math.max(0, Math.min(text.length, Math.floor(maxChars)));
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end--;
  return text.slice(0, end);
}
