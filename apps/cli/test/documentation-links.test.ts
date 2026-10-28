import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

it("resolves relative Markdown documentation links in README and docs", () => {
  const files = [join(root, "README.md"), ...readdirSync(join(root, "docs"))
    .filter((name) => name.endsWith(".md")).map((name) => join(root, "docs", name))];
  const missing: { file: string; target: string }[] = [];
  let references = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      references += 1;
      const path = resolve(dirname(file), decodeURIComponent(target));
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
        missing.push({ file: relative(root, file), target });
      }
    }
  }
  expect(references).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});
