import { describe, expect, it, vi } from "vitest";
import { crop, wrap } from "../src/workspace/text.js";

describe("ASCII framebuffer layout hot path", () => {
  it("crops and wraps printable ASCII without invoking Unicode grapheme segmentation", () => {
    const segmentation = vi.spyOn(Intl.Segmenter.prototype, "segment");
    try {
      expect(crop("A".repeat(10000), 160)).toBe("A".repeat(160));
      expect(wrap("abc def  gh", 4)).toEqual(["abc ", "def ", " gh"]);
      expect(wrap("\n", 40)).toEqual(["", ""]);
      expect(segmentation).not.toHaveBeenCalled();
    } finally { segmentation.mockRestore(); }
  });
  it("still sanitizes controls and measures non-ASCII graphemes rather than UTF-16 length", () => {
    expect(crop("\x1b[31mabcdef\x1b[0m", 3)).toBe("abc");
    expect(crop("中🙂ab", 5)).toBe("中🙂a");
    expect(wrap("👩‍💻ab", 3)).toEqual(["👩‍💻a", "b"]);
    expect(crop("abcdef", -1)).toBe("");
    expect(crop("abcdef", 2.5)).toBe("ab");
    expect(wrap("abc", 1.5)).toEqual(["a", "b", "c"]);
  });
});
