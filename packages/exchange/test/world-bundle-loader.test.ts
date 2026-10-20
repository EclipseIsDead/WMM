import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonBytes, sha256Hex, snapshotDigest } from "@wmm/canonical";
import { validateWorldRecord, type JsonValue, type SnapshotFileEntryV1 } from "@wmm/wire-contracts";
import {
  loadWorldBundle,
  WorldBundleError,
  type WorldBundleErrorCode,
} from "../src/world-bundle.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
  };
});

vi.mock("@wmm/wire-contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wmm/wire-contracts")>();
  return { ...actual, validateWorldRecord: vi.fn(actual.validateWorldRecord) };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const realWire = await vi.importActual<typeof import("@wmm/wire-contracts")>("@wmm/wire-contracts");
const fixturePath = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const fixtureSnapshot = JSON.parse(realFs.readFileSync(join(fixturePath, "snapshot.json"), "utf8"));
const MAX_FILE_BYTES = 10 * 1024 * 1024;
type BoundedRead = (
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | bigint | null,
) => number;
const read = vi.mocked(fs.readSync as BoundedRead);
const temporaryDirectories: string[] = [];
const trust = {
  trustedDefinitionDigests: new Set<string>(),
  trustedProfileDigests: new Set<string>(),
};

function temporaryDirectory(): string {
  const directory = realFs.mkdtempSync(join(tmpdir(), "wmm-bounded-loader-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSnapshot(root: string, files: readonly SnapshotFileEntryV1[]): void {
  const manifest = {
    format: "wmm.snapshot-manifest/1" as const,
    worldId: fixtureSnapshot.manifest.worldId as string,
    files: [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  realFs.writeFileSync(join(root, "snapshot.json"), canonicalJsonBytes({
    format: "wmm.snapshot-record/1",
    manifest,
    snapshotDigest: snapshotDigest(manifest),
  } as unknown as JsonValue));
}

function emptyBundle(): string {
  const root = join(temporaryDirectory(), "bundle");
  realFs.mkdirSync(join(root, "payload"), { recursive: true });
  writeSnapshot(root, []);
  return root;
}

function addFile(root: string, path: string, bytes = Buffer.from([0])): SnapshotFileEntryV1 {
  const absolute = join(root, "payload", path);
  realFs.mkdirSync(dirname(absolute), { recursive: true });
  realFs.writeFileSync(absolute, bytes);
  return {
    path,
    mediaType: path.endsWith(".json") ? "application/json" : "application/octet-stream",
    byteLength: String(bytes.length),
    sha256: sha256Hex(bytes),
  };
}

function expectFailure(root: string, code: WorldBundleErrorCode, message: RegExp): WorldBundleError {
  let failure: unknown;
  try {
    loadWorldBundle(root, trust);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(WorldBundleError);
  expect(failure).toMatchObject({ code, message: expect.stringMatching(message) });
  return failure as WorldBundleError;
}

beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(realFs.openSync);
  read.mockReset().mockImplementation(realFs.readSync);

  vi.mocked(validateWorldRecord).mockReset().mockImplementation(realWire.validateWorldRecord);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    realFs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("bounded world bundle loading", () => {
  it("rejects an oversized snapshot before reading or validating any JSON", () => {
    const root = emptyBundle();
    realFs.truncateSync(join(root, "snapshot.json"), MAX_FILE_BYTES + 1);
    expectFailure(root, "INVALID_WORLD", /file-size limit.*snapshot\.json/);
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(validateWorldRecord).not.toHaveBeenCalled();
  });

  it("rejects oversized actual payload bytes despite a tiny manifest declaration", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin");
    writeSnapshot(root, [entry]);
    realFs.truncateSync(join(root, "payload", entry.path), MAX_FILE_BYTES + 1);
    expectFailure(root, "INVALID_WORLD", /file-size limit.*data\.bin/);
    expect(vi.mocked(fs.openSync).mock.calls.map(([path]) => String(path)))
      .toEqual([join(root, "snapshot.json")]);
  });

  it("preflights total actual bytes, not the declared total, before reading payloads", () => {
    const root = emptyBundle();
    const files = Array.from({ length: 11 }, (_, index) => addFile(root, `data_${index}.bin`));
    writeSnapshot(root, files);
    for (const entry of files) realFs.truncateSync(join(root, "payload", entry.path), MAX_FILE_BYTES);
    expectFailure(root, "INVALID_WORLD", /total-size limit/);
    expect(fs.openSync).toHaveBeenCalledTimes(1);
  });

  it("includes the snapshot in the 100 MiB actual-byte budget", () => {
    const root = emptyBundle();
    const files = Array.from({ length: 10 }, (_, index) => addFile(root, `data_${index}.bin`));
    writeSnapshot(root, files);
    for (const entry of files) realFs.truncateSync(join(root, "payload", entry.path), MAX_FILE_BYTES);
    expectFailure(root, "INVALID_WORLD", /total-size limit/);
    expect(fs.openSync).toHaveBeenCalledTimes(1);
  });

  it("accepts the inclusive per-file limit and handles short reads", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin", Buffer.alloc(MAX_FILE_BYTES));
    writeSnapshot(root, [entry]);
    read.mockImplementation((fd, buffer, offset, length, position) =>
      realFs.readSync(fd, buffer, offset, Math.min(length, 4096), position));
    // The minimal bundle deliberately has no world catalog; byte validation must get past data.bin.
    expectFailure(root, "INVALID_WORLD", /Required world record is missing: world\.json/);
    expect(fs.readSync).toHaveBeenCalled();
  });

  it("checks manifest cardinality before schema deep-uniqueness validation", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin");
    writeSnapshot(root, Array.from({ length: 10_001 }, () => entry));
    expectFailure(root, "INVALID_WORLD", /manifest exceeds the file-count limit/);
    expect(validateWorldRecord).not.toHaveBeenCalled();
  });

  it.each(["future/new.json", "revisions/new.bin", "unknown.json"])(
    "rejects the unsupported reserved namespace records/%s",
    (suffix) => {
      const root = emptyBundle();
      writeSnapshot(root, [addFile(root, `records/${suffix}`, Buffer.from("{}"))]);
      expectFailure(root, "INVALID_WORLD", /Unsupported reserved record namespace/);
    },
  );

  it("rejects deeply nested empty directories before recursion becomes unbounded", () => {
    const root = emptyBundle();
    realFs.mkdirSync(join(root, "payload", ...Array.from({ length: 33 }, () => "nested")), { recursive: true });
    expectFailure(root, "INVALID_WORLD", /directory-depth limit/);
  });

  it("counts empty directories toward a global traversal limit", () => {
    const root = emptyBundle();
    for (let index = 0; index < 1_001; index += 1) {
      realFs.mkdirSync(join(root, "payload", `empty_${index}`));
    }
    expectFailure(root, "INVALID_WORLD", /directory-count limit/);
    expect(fs.openSync).toHaveBeenCalledTimes(1);
  });
});

describe("no-follow reads and replacement checks", () => {
  it.each(["root", "snapshot", "payload", "directory", "file"])(
    "rejects a static %s symlink",
    (kind) => {
      const root = emptyBundle();
      const entry = addFile(root, "nested/data.bin");
      writeSnapshot(root, [entry]);
      const path = kind === "root" ? root
        : kind === "snapshot" ? join(root, "snapshot.json")
        : kind === "payload" ? join(root, "payload")
        : kind === "directory" ? join(root, "payload", "nested")
        : join(root, "payload", entry.path);
      const moved = join(temporaryDirectory(), "target");
      realFs.renameSync(path, moved);
      realFs.symlinkSync(moved, path);
      expectFailure(root, "INVALID_WORLD", /symlink/);
    },
  );

  it("uses O_NOFOLLOW even when a file becomes a symlink immediately before open", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin");
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    const moved = join(temporaryDirectory(), "target.bin");
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      if (path === absolute) {
        expect(Number(flags) & fs.constants.O_NOFOLLOW).not.toBe(0);
        realFs.renameSync(absolute, moved);
        realFs.symlinkSync(moved, absolute);
      }
      return realFs.openSync(path, flags, mode);
    });
    expectFailure(root, "INVALID_WORLD", /symlink/);
  });

  it("detects an ordinary parent-directory symlink swap during a file read", () => {
    const root = emptyBundle();
    const entry = addFile(root, "nested/data.bin");
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    const parent = dirname(absolute);
    const moved = join(temporaryDirectory(), "moved");
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      if (path === absolute) {
        realFs.renameSync(parent, moved);
        realFs.symlinkSync(moved, parent);
      }
      return realFs.openSync(path, flags, mode);
    });
    // This detects the persistent swap, not atomic confinement: Node has no openat.
    expectFailure(root, "INVALID_WORLD", /symlink|changed while loading/);
  });

  it("checks the opened inode's actual size before any payload read", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin");
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    let payloadFd: number | undefined;
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      if (path === absolute) realFs.truncateSync(absolute, MAX_FILE_BYTES + 1);
      const fd = realFs.openSync(path, flags, mode);
      if (path === absolute) payloadFd = fd;
      return fd;
    });
    expectFailure(root, "INVALID_WORLD", /file-size limit/);
    // File descriptor numbers can be reused after snapshot close; inspect reads after payload open.
    const openedAt = vi.mocked(fs.openSync).mock.invocationCallOrder.at(-1)!;
    expect(read.mock.calls.filter((_, index) => read.mock.invocationCallOrder[index]! > openedAt))
      .toEqual([]);
    expect(payloadFd).toBeDefined();
  });

  it("rejects a same-size file replacement between lstat and open without reading it", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin");
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      if (path === absolute) {
        realFs.renameSync(absolute, join(temporaryDirectory(), "original.bin"));
        realFs.writeFileSync(absolute, Buffer.from([0]));
      }
      return realFs.openSync(path, flags, mode);
    });
    expectFailure(root, "INVALID_WORLD", /changed while loading/);
    expect(fs.readSync).toHaveBeenCalledTimes(1); // snapshot only
  });

  it("caps reads at the checked inode size and rejects growth during a read", () => {
    const root = emptyBundle();
    const originalSize = 64 * 1024;
    const entry = addFile(root, "data.bin", Buffer.alloc(originalSize));
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    let payloadFd: number | undefined;
    let actualBytesRead = 0;
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      const fd = realFs.openSync(path, flags, mode);
      if (path === absolute) payloadFd = fd;
      return fd;
    });
    read.mockImplementation((fd, buffer, offset, length, position) => {
      const count = realFs.readSync(fd, buffer, offset, Math.min(length, 4096), position);
      if (fd === payloadFd) {
        expect(buffer.byteLength).toBe(originalSize);
        expect(Number(position) + length).toBeLessThanOrEqual(originalSize);
        actualBytesRead += count;
        realFs.truncateSync(absolute, MAX_FILE_BYTES + 1);
      }
      return count;
    });
    expectFailure(root, "INVALID_WORLD", /changed while loading/);
    expect(actualBytesRead).toBe(originalSize);
  });

  it("rejects truncation during a read", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin", Buffer.alloc(1024));
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    let payloadFd: number | undefined;
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      const fd = realFs.openSync(path, flags, mode);
      if (path === absolute) payloadFd = fd;
      return fd;
    });
    read.mockImplementation((fd, buffer, offset, length, position) => {
      if (fd === payloadFd) realFs.truncateSync(absolute, 0);
      return realFs.readSync(fd, buffer, offset, length, position);
    });
    expectFailure(root, "INVALID_WORLD", /truncated while loading/);
  });

  it("checks the final pathname again after reading an open inode", () => {
    const root = emptyBundle();
    const entry = addFile(root, "data.bin");
    writeSnapshot(root, [entry]);
    const absolute = join(root, "payload", entry.path);
    let payloadFd: number | undefined;
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      const fd = realFs.openSync(path, flags, mode);
      if (path === absolute) payloadFd = fd;
      return fd;
    });
    read.mockImplementation((fd, buffer, offset, length, position) => {
      const count = realFs.readSync(fd, buffer, offset, length, position);
      if (fd === payloadFd) {
        realFs.renameSync(absolute, join(temporaryDirectory(), "original.bin"));
        realFs.writeFileSync(absolute, Buffer.from([0]));
      }
      return count;
    });
    expectFailure(root, "INVALID_WORLD", /changed while loading/);
  });
});

describe("typed loader errors", () => {
  it("classifies malformed JSON as invalid input", () => {
    const root = emptyBundle();
    realFs.writeFileSync(join(root, "snapshot.json"), "{");
    expectFailure(root, "INVALID_WORLD", /Invalid JSON/);
  });

  it("classifies invalid UTF-8 as invalid input", () => {
    const root = emptyBundle();
    realFs.writeFileSync(join(root, "snapshot.json"), Buffer.from([0xff]));
    expectFailure(root, "INVALID_WORLD", /Invalid UTF-8/);
  });

  it("preserves filesystem failures and their causes, distinct from invalid worlds", () => {
    const root = emptyBundle();
    const failure = expectFailure(join(root, "missing"), "FILESYSTEM_ERROR", /Cannot stat/);
    expect(failure.cause).toMatchObject({ code: "ENOENT" });
  });

  it("does not convert read I/O failures into malformed-world errors", () => {
    const root = emptyBundle();
    const cause = Object.assign(new Error("I/O failure"), { code: "EIO", errno: -5 });
    read.mockImplementation(() => { throw cause; });
    expect(expectFailure(root, "FILESYSTEM_ERROR", /Cannot read bundle file/).cause).toBe(cause);
  });

  it("does not convert unexpected internal TypeErrors into malformed-world errors", () => {
    const root = emptyBundle();
    const cause = new TypeError("unexpected validator bug");
    vi.mocked(validateWorldRecord).mockImplementation(() => { throw cause; });
    expect(expectFailure(root, "INTERNAL_ERROR", /Unexpected world bundle loader failure/).cause).toBe(cause);
  });
});
