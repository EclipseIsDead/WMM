import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), part => part.segment);

/** Presentation only: never write this transformed text back to the service. */
export function terminalText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    // OSC (including hyperlinks), DCS/SOS/PM/APC, CSI, then short ESC sequences.
    // Unterminated strings consume the remainder rather than exposing their payload.
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/g, "");
}

export const cells = (text: string): number => stringWidth(text);

export function crop(text: string, width: number): string {
  let result = "";
  for (const part of graphemes(terminalText(text).replace(/\n/g, " "))) {
    if (cells(result + part) > Math.max(0, width)) break;
    result += part;
  }
  return result;
}

export function ellipsis(text: string, width: number): string {
  const safe = terminalText(text).replace(/\n/g, " ");
  return cells(safe) <= width ? safe : crop(safe, width - 3) + (width >= 3 ? "..." : "");
}

export function fit(text: string, width: number): string {
  const result = crop(text, width);
  return result + " ".repeat(Math.max(0, width - cells(result)));
}

/** Hard wrapping preserves intentional newlines, indentation and whitespace in prose. */
export function wrap(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  for (const source of terminalText(text).split("\n")) {
    let line = "";
    for (const part of graphemes(source)) {
      if (cells(line + part) > width && line) { lines.push(line); line = ""; }
      // A terminal too narrow even for one wide grapheme must not overflow.
      if (cells(part) <= width) line += part;
    }
    lines.push(line);
  }
  return lines;
}

export function viewport(lines: readonly string[], offset: number, height: number, width: number, reportLimit?: (limit: number) => void): string[] {
  if (height <= 0) return [];
  const capacity = Math.max(1, height - 1);
  const limit = Math.max(0, lines.length - capacity);
  reportLimit?.(limit);
  const start = Math.min(Math.max(0, offset), limit);
  const visible = lines.slice(start, start + capacity).map(line => crop(line, width));
  while (visible.length < capacity) visible.push("");
  const more = start > 0 || start + capacity < lines.length;
  visible.push(more ? ellipsis(`[More: ${start + 1}-${Math.min(lines.length, start + capacity)}/${lines.length}; PgUp/PgDn]`, width) : "");
  return visible.slice(0, height);
}
