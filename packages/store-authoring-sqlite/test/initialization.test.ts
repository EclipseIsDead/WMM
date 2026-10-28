import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceBaseV1, WorkspaceStateV1 } from "@wmm/wire-contracts";

import { APPLICATION_ID, LEGACY_SCHEMA_V1 } from "../src/database.js";
import { SqliteWorkspaceStore } from "../src/index.js";

const helper = fileURLToPath(new URL("./helpers/initialization-process.ts", import.meta.url));
type Exit = { code: number | null; signal: NodeJS.Signals | null };
const active = new Map<ChildProcess, Promise<Exit>>();
const directories: string[] = [];
const stores: SqliteWorkspaceStore[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "wmm-initialization-"));
  directories.push(root);
  return root;
}

function open(path: string): SqliteWorkspaceStore {
  const store = new SqliteWorkspaceStore(path);
  stores.push(store);
  return store;
}

async function pausedCreator(path: string, checkpoint: string, release: string, action = "continue", schedule: Record<string, string> = {}) {
  const child = spawn(process.execPath, [helper, path, checkpoint, release, action, JSON.stringify(schedule)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let pending = "";
  let errors = "";
  const messages: Record<string, unknown>[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => { errors += data; });
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { active.delete(child); resolve({ code, signal }); });
  });
  active.set(child, exited);
  child.stdout.on("data", (data: string) => {
    output += data;
    pending += data;
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) messages.push(JSON.parse(line) as Record<string, unknown>);
  });
  const waitFor = (point: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); child.stdout.off("data", observe); };
    const observe = () => {
      const message = messages.find((entry) => entry["checkpoint"] === point);
      if (message !== undefined) { cleanup(); resolve(message); }
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Initialization checkpoint not reached: ${point}\n${output}\n${errors}`));
    }, 10_000);
    child.stdout.on("data", observe);
    observe();
    void exited.then((result) => {
      cleanup();
      reject(new Error(`Subprocess exited before checkpoint ${point}: ${JSON.stringify(result)}\n${output}\n${errors}`));
    }, reject);
  });
  try {
    const observed = await waitFor(checkpoint);
    expect(observed["sqliteVersion"]).toMatch(/^\d+\.\d+\.\d+$/);
    return {
      child, exited, observed, waitFor,
      resume: () => { writeFileSync(release, "continue\n"); },
      resumeAt: (point: string) => { writeFileSync(schedule[point]!, "continue\n"); },
      report: () => ({ messages, output, errors }),
    };
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
}

function built(): { state: WorkspaceStateV1; base: WorkspaceBaseV1 } {
  const snapshotDigest = "a".repeat(64);
  return {
    state: {
      format: "wmm.workspace/1", id: "draft", version: 1, title: "Synthetic first-run draft", worldTitle: "Test world",
      goal: "Recover initialization", mode: "world", base: { worldId: "world-test", snapshotDigest },
      proposals: [], pins: [], direction: "", history: [],
    },
    base: {
      snapshot: { format: "wmm.snapshot-record/1", snapshotDigest,
        manifest: { format: "wmm.snapshot-manifest/1", worldId: "world-test", files: [] } },
      world: {
        format: "wmm.world-export/1", snapshotDigest,
        world: { format: "wmm.world/1", worldId: "world-test", semanticProfileDigest: "b".repeat(64),
          descriptorIds: [], sourceIds: [], assertionIds: [], activeAssertionIds: [], supportIds: [], activeSupportIds: [] },
        semanticProfile: { format: "wmm.semantic-profile/1", version: "1", definitions: [],
          numericProfile: "safe-integer-json-v1", propositionGrammar: "explicit-polarity-atom-exists-v1" },
        definitions: [], rosters: [], descriptors: [], sources: [], assertions: [], supports: [], documents: [],
      },
      documents: [],
    },
  };
}

function roundTrip(path: string): void {
  const fixture = built();
  const store = open(path);
  expect(store.create("draft", { idempotencyKey: "create", intent: "same intent" }, () => fixture)).toEqual(fixture.state);
  store.close();
  const reopened = open(path);
  expect(reopened.read("draft")).toEqual(fixture.state);
  expect(reopened.readBase("draft")).toEqual(fixture.base);
  expect(reopened.create("draft", { idempotencyKey: "create", intent: "same intent" }, () => {
    throw new Error("Must replay rather than rebuild");
  })).toEqual(fixture.state);
  reopened.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(APPLICATION_ID);
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
    expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    expect(db.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
  } finally {
    db.close();
  }
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

function savedRows(path: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return ["workspace_bases", "workspace_versions", "workspace_outcomes"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
  } finally { db.close(); }
}

function savedDeleteDatabase(path: string, legacy: boolean) {
  const fixture = built();
  const advanced: WorkspaceStateV1 = {
    ...fixture.state, version: 2, direction: "Preserve this saved direction",
    history: [{ version: 2, action: { kind: "set-direction", text: "Preserve this saved direction" } }],
  };
  if (legacy) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  else open(path).close();
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("PRAGMA journal_mode = DELETE").get()?.["journal_mode"]).toBe("delete");
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    if (legacy) {
      for (const object of LEGACY_SCHEMA_V1) db.exec(object.sql);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
    }
    db.prepare("INSERT INTO workspace_bases VALUES (?, ?, ?, ?)").run(
      "draft", fixture.state.base.worldId, fixture.state.base.snapshotDigest, JSON.stringify(fixture.base),
    );
    for (const state of [fixture.state, advanced]) {
      db.prepare("INSERT INTO workspace_versions VALUES (?, ?, ?)").run("draft", state.version, JSON.stringify(state));
    }
    db.prepare("INSERT INTO workspace_outcomes VALUES (?, ?, ?, ?, ?)").run("draft", "create", "create", "same intent", 1);
    db.prepare("INSERT INTO workspace_outcomes VALUES (?, ?, ?, ?, ?)").run("draft", "advance", "mutate", "advance intent", 2);
    db.exec("COMMIT");
  } finally { db.close(); }
  return { fixture, advanced };
}

/** Snapshot bytes/identities without following symlinks or opening SQLite. */
function snapshot(root: string, excluded: readonly string[] = []): unknown[] {
  return readdirSync(root).filter((name) => !excluded.includes(name)).sort().map((name) => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return [name, stat.ino, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path)
      : stat.isDirectory() ? snapshot(path) : readFileSync(path).toString("hex")];
  });
}

afterEach(async () => {
  const running = [...active];
  for (const [child] of running) child.kill("SIGKILL");
  await Promise.all(running.map(([, exited]) => exited));
  for (const store of stores.splice(0)) store.close();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("first-run database publication", () => {
  it.each(["-wal", "-shm", "-journal"])("refuses an orphaned %s without publishing or changing foreign bytes", (suffix) => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    writeFileSync(`${path}${suffix}`, "Foreign sidecar: do not adopt or remove\n");
    const before = snapshot(root);
    expect(() => open(path)).toThrow(/sidecar/);
    expect(existsSync(path)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it("allows ordinary retry after a creator is killed immediately after exclusive file creation", async () => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const creator = await pausedCreator(path, "created-file", join(root, "release"));
    expect(creator.observed["size"]).toBe(0);
    creator.child.kill("SIGKILL");
    expect(await creator.exited).toEqual({ code: null, signal: "SIGKILL" });

    // This is the ordinary public constructor, not a repair/delete helper.
    roundTrip(path);
  });

  it.each(["before-file-creation", "before-initialization", "during-initialization", "before-publication", "after-publication"])(
    "allows ordinary retry/reopen after SIGKILL at %s", async (checkpoint) => {
      const root = directory();
      const path = join(root, "authoring.sqlite");
      const creator = await pausedCreator(path, checkpoint, join(root, "release"));
      const file = String(creator.observed["file"]);
      expect(dirname(dirname(file))).toBe(root);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
      expect(existsSync(path)).toBe(checkpoint === "after-publication");
      if (checkpoint === "during-initialization") {
        expect(creator.observed).toMatchObject({ tables: [{ name: "workspace_bases" }], applicationId: 0, journal: true });
      }
      if (checkpoint.endsWith("publication")) {
        expect(creator.observed).toMatchObject({ closed: true, entries: ["authoring.sqlite"] });
        const bytes = readFileSync(file);
        expect(bytes.readUInt32BE(68)).toBe(APPLICATION_ID);
        expect(bytes.readUInt32BE(60)).toBe(2);
      }
      creator.child.kill("SIGKILL");
      expect(await creator.exited).toEqual({ code: null, signal: "SIGKILL" });
      const orphanEntries = snapshot(dirname(file));
      roundTrip(path);
      // Retry does not infer ownership from a prefix or sweep abandoned allocations.
      // After publication the abandoned name is a hard link to the owned main file.
      if (checkpoint === "after-publication") expect(statSync(file).ino).toBe(statSync(path).ino);
      else expect(snapshot(dirname(file))).toEqual(orphanEntries);
    }, 15_000,
  );

  it.each(["before-file-creation", "during-initialization", "before-publication", "after-publication"])(
    "cleans only its own allocation after a handled failure at %s", async (checkpoint) => {
      const root = directory();
      const path = join(root, "authoring.sqlite");
      const foreign = join(root, ".wmm-authoring-init-not-owned");
      mkdirSync(foreign);
      writeFileSync(join(foreign, "keep"), "Not this invocation's staging directory");
      const before = snapshot(foreign);
      const creator = await pausedCreator(path, checkpoint, join(root, "release"), "throw");
      const owned = dirname(String(creator.observed["file"]));
      creator.resume();
      expect(await creator.exited).toEqual({ code: 1, signal: null });
      expect(creator.report().messages).toContainEqual({ failure: {
        code: "STORAGE_FAILURE", message: `Workspace storage failure: Injected initialization failure at ${checkpoint}`,
      } });
      expect(existsSync(owned)).toBe(false);
      expect(snapshot(foreign)).toEqual(before);
      expect(existsSync(path)).toBe(checkpoint === "after-publication");
      roundTrip(path);
      expect(snapshot(foreign)).toEqual(before);
    }, 15_000,
  );

  it("does not clobber a concurrent creator or lose its data when both began with an absent target", async () => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const first = await pausedCreator(path, "before-publication", join(root, "release-first"));
    const second = await pausedCreator(path, "before-publication", join(root, "release-second"));
    expect(first.observed["source"]).not.toBe(second.observed["source"]);
    expect(existsSync(path)).toBe(false);
    first.resume();
    expect(await first.exited).toEqual({ code: 0, signal: null });
    const winner = open(path);
    const fixture = built();
    winner.create("draft", { idempotencyKey: "create", intent: "same intent" }, () => fixture);
    const inode = statSync(path).ino;
    second.resume();
    expect(await second.exited).toEqual({ code: 0, signal: null });
    expect(second.report().messages).toContainEqual({ completed: true });
    expect(statSync(path).ino).toBe(inode);
    expect(winner.read("draft")).toEqual(fixture.state);
    expect(winner.readBase("draft")).toEqual(fixture.base);
    winner.close();
    roundTrip(path);
    expect(readdirSync(root).filter((name) => name.startsWith(".wmm-authoring-init-"))).toEqual([]);
  }, 15_000);

  it("opens simultaneous publishers without exposing a placeholder or replacing the winner", async () => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const release = join(root, "release-both");
    const first = await pausedCreator(path, "before-publication", release);
    const second = await pausedCreator(path, "before-publication", release);
    expect(existsSync(path)).toBe(false);
    first.resume();
    expect(await Promise.all([first.exited, second.exited])).toEqual([
      { code: 0, signal: null }, { code: 0, signal: null },
    ]);
    expect(first.report().messages).toContainEqual({ completed: true });
    expect(second.report().messages).toContainEqual({ completed: true });
    expect(readdirSync(root).sort()).toEqual(["authoring.sqlite", "release-both"]);
    roundTrip(path);
  }, 15_000);

  it("acquires WAL after a brief competing main-file BEGIN IMMEDIATE between two first-run creators", async () => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const first = await pausedCreator(path, "before-publication", join(root, "publish-first"), "continue", {
      "before-wal": join(root, "wal-first"),
    });
    const second = await pausedCreator(path, "before-publication", join(root, "publish-second"), "continue", {
      "main-begin": join(root, "commit-second"),
    });
    expect(existsSync(path)).toBe(false);
    first.resume();
    expect(await first.waitFor("before-wal")).toMatchObject({ inTransaction: false });
    const inode = statSync(path).ino;
    second.resume();
    expect(await second.waitFor("main-begin")).toMatchObject({
      inTransaction: true, journalMode: "delete", busyTimeout: 1_000,
    });
    first.resumeAt("before-wal");
    const busy = await first.waitFor("wal-error");
    expect(busy).toMatchObject({
      attempt: 1, busyTimeout: 1_000, inTransaction: false,
      nativeError: { code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" },
    });
    expect(busy["elapsedMs"]).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 30));
    second.resumeAt("main-begin");
    const results = await Promise.all([first.exited, second.exited]);
    expect(results, JSON.stringify({ first: first.report(), second: second.report() }, null, 2)).toEqual([
      { code: 0, signal: null }, { code: 0, signal: null },
    ]);
    expect(first.report().messages).toContainEqual(expect.objectContaining({ checkpoint: "wal-acquired" }));
    expect(first.report().messages).toContainEqual(expect.objectContaining({
      checkpoint: "constructor-opened", busyTimeout: 1_000, inTransaction: false,
    }));
    expect(second.report().messages).toContainEqual(expect.objectContaining({ checkpoint: "publication-error", code: "EEXIST" }));
    expect(statSync(path).ino).toBe(inode);
    roundTrip(path);
    expect(statSync(path).ino).toBe(inode);
    expect(readdirSync(root).filter((name) => name.startsWith(".wmm-authoring-init-"))).toEqual([]);
  });

  it.each([false, true])("acquires WAL on an existing DELETE database (legacy v1: %s) without changing saved state or inode", async (legacy) => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const { fixture, advanced } = savedDeleteDatabase(path, legacy);
    const before = savedRows(path);
    const inode = statSync(path).ino;
    const first = await pausedCreator(path, "before-wal", join(root, "wal-first"));
    const second = await pausedCreator(path, "main-begin", join(root, "commit-second"));
    expect(first.observed).toMatchObject({ inTransaction: false });
    expect(second.observed).toMatchObject({ inTransaction: true, journalMode: "delete", busyTimeout: 1_000 });
    first.resume();
    expect(await first.waitFor("wal-error")).toMatchObject({ nativeError: { code: "ERR_SQLITE_ERROR", errcode: 5 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    second.resume();
    expect(await Promise.all([first.exited, second.exited]), JSON.stringify([first.report(), second.report()])).toEqual([
      { code: 0, signal: null }, { code: 0, signal: null },
    ]);
    expect(savedRows(path)).toEqual(before);
    const reopened = open(path);
    expect(reopened.readBase("draft")).toEqual(fixture.base);
    expect(reopened.read("draft", 1)).toEqual(fixture.state);
    expect(reopened.read("draft")).toEqual(advanced);
    expect(reopened.create("draft", { idempotencyKey: "create", intent: "same intent" }, () => {
      throw new Error("Must replay saved creation");
    })).toEqual(fixture.state);
    expect(reopened.mutate("draft", 1, { idempotencyKey: "advance", intent: "advance intent" }, () => {
      throw new Error("Must replay saved mutation");
    })).toEqual(advanced);
    reopened.close();
    expect(savedRows(path)).toEqual(before);
    expect(statSync(path).ino).toBe(inode);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
      expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
      expect(db.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
    } finally { db.close(); }
  });

  it.each([
    ["write", 0],
    ["read after initial write contention", 0],
    ["read after initial write contention with delayed coordinator", 700],
  ] as const)("bounds WAL acquisition under a sustained %s lock", async (kind, coordinatorDelayMs) => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const readLock = kind !== "write";
    const first = await pausedCreator(path, "before-publication", join(root, "publish-first"), "continue", {
      "before-wal": join(root, "wal-first"),
      ...(readLock ? { "before-native-wait": join(root, "native-wait-first") } : {}),
    });
    const second = await pausedCreator(path, "before-publication", join(root, "publish-second"),
      readLock ? "hold-reader-after-commit" : "continue", {
        "main-begin": join(root, "commit-second"), "main-read": join(root, "reader-second"),
      });
    first.resume();
    await first.waitFor("before-wal");
    const inode = statSync(path).ino;
    second.resume();
    expect(await second.waitFor("main-begin")).toMatchObject({ inTransaction: true, journalMode: "delete" });
    first.resumeAt("before-wal");
    expect(await first.waitFor("wal-error")).toMatchObject({
      attempt: 1, busyTimeout: 1_000, nativeError: { code: "ERR_SQLITE_ERROR", errcode: 5 },
    });
    if (readLock) {
      // Spend part of the one-second budget on immediate BUSY responses before a
      // SHARED reader makes a later real sqlite3_step invoke SQLite's busy handler.
      await first.waitFor("before-native-wait");
      second.resumeAt("main-begin");
      expect(await second.waitFor("main-read")).toMatchObject({ inTransaction: false, readerTransaction: true });
      // The next native timeout is already allocated. Reproduce a slow parent
      // without faking SQLite results or suspending production's monotonic clock.
      if (coordinatorDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, coordinatorDelayMs));
      first.resumeAt("before-native-wait");
    }
    expect(await first.exited, JSON.stringify(first.report())).toEqual({ code: 1, signal: null });
    const errors = first.report().messages.filter((message) => message["checkpoint"] === "wal-error");
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.length).toBeLessThan(150);
    expect(errors.every((message) => (message["nativeError"] as { errcode: number }).errcode === 5)).toBe(true);
    const last = errors.at(-1)!;
    expect(last["phaseElapsedMs"]).toBeGreaterThanOrEqual(900);
    const allocations = first.report().messages.filter((message) => message["checkpoint"] === "wal-timeout-set");
    expect(allocations).toHaveLength(errors.length - 1);
    for (let index = 1; index < errors.length; index += 1) {
      const previousElapsedMs = Number(errors[index - 1]!["phaseElapsedMs"]);
      const busyTimeout = Number(errors[index]!["busyTimeout"]);
      expect(allocations[index - 1]).toMatchObject({
        attempt: index + 1, busyTimeout, previousErrorElapsedMs: previousElapsedMs,
      });
      expect(Number.isInteger(busyTimeout)).toBe(true);
      expect(busyTimeout).toBeGreaterThan(0);
      // Allocation follows the preceding real native error. Even if descheduled
      // after allocation, a retry must never receive a fresh one-second timeout.
      expect(busyTimeout + previousElapsedMs, JSON.stringify(allocations[index - 1])).toBeLessThanOrEqual(1_000);
      expect(Number(errors[index]!["phaseElapsedMs"]) - previousElapsedMs).toBeGreaterThanOrEqual(5);
    }
    if (readLock) {
      expect(last["busyTimeout"]).toBeLessThan(700);
      expect(last["elapsedMs"]).toBeGreaterThan(200);
    }
    if (coordinatorDelayMs > 0) {
      expect(last["walPausedMs"]).toBeGreaterThanOrEqual(coordinatorDelayMs);
      // A real remaining-budget native wait still occurs after the IPC pause;
      // the old end-to-end upper bound incorrectly counted that pause as work.
      expect(last["phaseElapsedMs"]).toBeGreaterThan(1_250);
    }
    expect(first.report().messages).toContainEqual({ failure: {
      code: "STORAGE_FAILURE", message: "Workspace storage failure: database is locked",
    } });
    second.resumeAt("main-begin");
    second.resumeAt("main-read");
    expect(await second.exited, JSON.stringify(second.report())).toEqual({ code: 0, signal: null });
    roundTrip(path);
    expect(statSync(path).ino).toBe(inode);
  });

  it.each([
    ["wal-own-transaction", "ERR_SQLITE_ERROR", 1],
    ["wal-active-reader", "ERR_SQLITE_ERROR", 1],
    ["wal-finalized", "ERR_INVALID_STATE", undefined],
  ] as const)("propagates native non-BUSY %s immediately without retrying WAL", async (action, code, errcode) => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    savedDeleteDatabase(path, false);
    const before = savedRows(path);
    const inode = statSync(path).ino;
    const creator = await pausedCreator(path, "before-wal", join(root, "release"), action);
    creator.resume();
    expect(await creator.exited, JSON.stringify(creator.report())).toEqual({ code: 1, signal: null });
    const errors = creator.report().messages.filter((message) => message["checkpoint"] === "wal-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ nativeError: { code, ...(errcode === undefined ? {} : { errcode }) } });
    expect(errors[0]!["phaseElapsedMs"]).toBeLessThan(250);
    expect(creator.report().messages).toContainEqual({ failure: {
      code: "STORAGE_FAILURE", message: `Workspace storage failure: ${(errors[0]!["nativeError"] as { message: string }).message}`,
    } });
    expect(savedRows(path)).toEqual(before);
    const reopened = open(path);
    expect(reopened.read("draft").version).toBe(2);
    reopened.close();
    expect(savedRows(path)).toEqual(before);
    expect(statSync(path).ino).toBe(inode);
  });

  it.each(["empty", "foreign SQLite", "corrupt owned SQLite", "symlink", "directory"])(
    "leaves a racing %s target and all its sidecars unchanged", async (kind) => {
      const root = directory();
      const path = join(root, "authoring.sqlite");
      const creator = await pausedCreator(path, "before-publication", join(root, "release"));
      if (kind === "foreign SQLite") {
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE important (data TEXT); INSERT INTO important VALUES ('keep me'); PRAGMA user_version = 12");
        db.close();
      } else if (kind === "corrupt owned SQLite") {
        open(path).close();
        const bytes = readFileSync(path);
        bytes[100] = 0;
        writeFileSync(path, bytes);
      } else if (kind === "symlink") {
        writeFileSync(join(root, "foreign"), "Keep symlink target unchanged");
        symlinkSync(join(root, "foreign"), path);
      } else if (kind === "directory") {
        mkdirSync(path);
        writeFileSync(join(path, "foreign"), "Keep directory unchanged");
      } else writeFileSync(path, "", { mode: 0o644 });
      for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(`${path}${suffix}`, `Foreign ${suffix}\n`);
      const ownedName = basename(dirname(String(creator.observed["file"])));
      const before = snapshot(root, [ownedName]);
      creator.resume();
      expect(await creator.exited).toEqual({ code: 1, signal: null });
      expect(creator.report().messages).toContainEqual({ failure: {
        code: "STORAGE_FAILURE", message: expect.any(String),
      } });
      expect(snapshot(root, ["release"])).toEqual(before);
      expect(() => open(path)).toThrow();
      expect(snapshot(root, ["release"])).toEqual(before);
    }, 15_000,
  );

  it.each(["-wal", "-shm", "-journal"])("rechecks orphaned %s created during initialization before publishing", async (suffix) => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const creator = await pausedCreator(path, "initialized-closed", join(root, "release"));
    const sidecar = `${path}${suffix}`;
    writeFileSync(sidecar, "Sidecar created while another process was initializing");
    const before = readFileSync(sidecar);
    creator.resume();
    expect(await creator.exited).toEqual({ code: 1, signal: null });
    expect(creator.report().messages).toContainEqual({ failure: {
      code: "STORAGE_FAILURE", message: "Unowned workspace database sidecar without a database",
    } });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(sidecar)).toEqual(before);
    expect(existsSync(dirname(String(creator.observed["file"])))).toBe(false);
  }, 15_000);
});
