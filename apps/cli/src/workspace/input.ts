import { graphemes } from "./text.js";

export interface TextBuffer {
  readonly text: string;
  /** Cursor in grapheme clusters, not UTF-16 code units. */
  readonly cursor: number;
  readonly preferredColumn: number | null;
}
export type TextEdit =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "left" | "right" | "up" | "down" | "home" | "end" | "backspace" | "delete" | "start" | "finish" };

export function textBuffer(text = ""): TextBuffer {
  return { text, cursor: graphemes(text).length, preferredColumn: null };
}

export function editText(state: TextBuffer, action: TextEdit): TextBuffer {
  const parts = graphemes(state.text);
  const cursor = Math.min(parts.length, Math.max(0, state.cursor));
  let next = cursor;
  let preferredColumn: number | null = null;
  const lineStart = parts.slice(0, cursor).lastIndexOf("\n") + 1;
  const foundEnd = parts.indexOf("\n", cursor);
  const lineEnd = foundEnd < 0 ? parts.length : foundEnd;
  switch (action.kind) {
    case "insert": {
      const inserted = graphemes(action.text.replace(/\r\n?/g, "\n"));
      parts.splice(cursor, 0, ...inserted);
      // Insertion can join a combining mark/ZWJ to the preceding grapheme.
      const prefix = parts.slice(0, cursor + inserted.length).join("");
      return { text: parts.join(""), cursor: graphemes(prefix).length, preferredColumn: null };
    }
    case "backspace": if (cursor > 0) { parts.splice(cursor - 1, 1); next--; } break;
    case "delete": parts.splice(cursor, 1); break;
    case "left": next = Math.max(0, cursor - 1); break;
    case "right": next = Math.min(parts.length, cursor + 1); break;
    case "start": next = 0; break;
    case "finish": next = parts.length; break;
    case "home": next = lineStart; break;
    case "end": next = lineEnd; break;
    case "up": {
      preferredColumn = state.preferredColumn ?? cursor - lineStart;
      const previousStart = parts.slice(0, Math.max(0, lineStart - 1)).lastIndexOf("\n") + 1;
      next = lineStart === 0 ? cursor : Math.min(previousStart + preferredColumn, lineStart - 1);
      break;
    }
    case "down": {
      preferredColumn = state.preferredColumn ?? cursor - lineStart;
      const followingEnd = parts.indexOf("\n", lineEnd + 1);
      next = lineEnd === parts.length ? cursor : Math.min(lineEnd + 1 + preferredColumn, followingEnd < 0 ? parts.length : followingEnd);
      break;
    }
  }
  return { text: parts.join(""), cursor: next, preferredColumn };
}

export function textWithCursor(buffer: TextBuffer): string {
  const parts = graphemes(buffer.text);
  parts.splice(buffer.cursor, 0, "|");
  return parts.join("");
}


