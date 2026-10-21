import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceStoreError, type WorkspaceIntent } from "@wmm/ports";
import type { WorkspaceBaseV1, WorkspaceStateV1 } from "@wmm/wire-contracts";

import { SqliteWorkspaceStore } from "../src/index.js";

const directories: string[] = [];
const stores: SqliteWorkspaceStore[] = [];
const databases: DatabaseSync[] = [];
const digest = "a".repeat(64);
const worldId = "world-test";

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "wmm-workspace-store-"));
  directories.push(path);
  return path;
}

function open(path: string): SqliteWorkspaceStore {
  const store = new SqliteWorkspaceStore(path);
  stores.push(store);
  return store;
}

function inspect(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  databases.push(db);
  return db;
}

function intent(idempotencyKey: string, canonicalIntent = idempotencyKey): WorkspaceIntent {
  return { idempotencyKey, intent: canonicalIntent };
}

function fixture(id = "draft", bytes = Buffer.from([0, 255, 13, 10, 65, 194, 169])): { state: WorkspaceStateV1; base: WorkspaceBaseV1 } {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const document = { path: "prose/original.bin", mediaType: "application/octet-stream" as const, sha256, byteLength: String(bytes.length) };
  return {
    state: {
      format: "wmm.workspace/1", id, version: 1,
      title: "An immutable-base draft", worldTitle: "Test world", goal: "Test durable authoring", mode: "world",
      base: { worldId, snapshotDigest: digest }, proposals: [], pins: [], direction: "", history: [],
    },
    base: {
      snapshot: {
        format: "wmm.snapshot-record/1", snapshotDigest: digest,
        manifest: { format: "wmm.snapshot-manifest/1", worldId, files: [document] },
      },
      world: {
        format: "wmm.world-export/1", snapshotDigest: digest,
        world: {
          format: "wmm.world/1", worldId, semanticProfileDigest: "b".repeat(64), descriptorIds: [], sourceIds: [],
          assertionIds: [], activeAssertionIds: [], supportIds: [], activeSupportIds: [],
        },
        semanticProfile: {
          format: "wmm.semantic-profile/1", version: "1", definitions: [],
          numericProfile: "safe-integer-json-v1", propositionGrammar: "explicit-polarity-atom-exists-v1",
        },
        definitions: [], rosters: [], descriptors: [], sources: [], assertions: [], supports: [], documents: [document],
      },
      documents: [{ path: document.path, mediaType: document.mediaType, sha256, base64: bytes.toString("base64") }],
    },
  };
}

function steer(text: string): (state: WorkspaceStateV1) => WorkspaceStateV1 {
  return (state) => ({
    ...state, version: state.version + 1, direction: text,
    history: [...state.history, { version: state.version + 1, action: { kind: "set-direction", text } }],
  });
}

function expectCode(run: () => unknown, code: WorkspaceStoreError["code"]): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(WorkspaceStoreError);
  expect(failure).toMatchObject({ code });
}

function counts(db: DatabaseSync): number[] {
  return ["workspace_bases", "workspace_versions", "workspace_outcomes"].map((table) =>
    Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"]));
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable workspace base and historical states", () => {
  it("persists the full base, exact binary document bytes, all versions and replay outcomes across reopen", () => {
    const path = join(directory(), "authoring.sqlite");
    const first = open(path);
    const built = fixture();
    const initial = first.create("draft", intent("create"), () => built);
    const second = first.mutate("draft", 1, intent("direction-1"), steer("Avoid war"));
    const third = first.mutate("draft", 2, intent("direction-2"), steer("Keep the council"));
    first.close();

    const reopened = open(path);
    expect(reopened.read("draft")).toEqual(third);
    expect(reopened.read("draft", 1)).toEqual(initial);
    expect(reopened.read("draft", 2)).toEqual(second);
    expect(reopened.read("draft", 3)).toEqual(third);
    expect(reopened.readBase("draft")).toEqual(built.base);
    expect(Buffer.from(reopened.readBase("draft").documents[0]!.base64, "base64"))
      .toEqual(Buffer.from([0, 255, 13, 10, 65, 194, 169]));
    expectCode(() => reopened.read("draft", 0), "WORKSPACE_NOT_FOUND");
    expectCode(() => reopened.read("draft", 4), "WORKSPACE_NOT_FOUND");
    expectCode(() => reopened.read("missing"), "WORKSPACE_NOT_FOUND");
    expectCode(() => reopened.readBase("missing"), "WORKSPACE_NOT_FOUND");
    expectCode(() => reopened.mutate("missing", 1, intent("missing"), steer("no")), "WORKSPACE_NOT_FOUND");
    expect(reopened.mutate("draft", 1, intent("direction-1"), () => { throw new Error("must not reapply"); })).toEqual(second);
    const db = inspect(path);
    expect(counts(db)).toEqual([1, 3, 3]);
    expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not retain callback-owned or returned mutable references", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    const built = fixture();
    const original = structuredClone(built);
    const created = store.create("draft", intent("create"), () => built);
    Object.assign(built.state.base, { worldId: "tampered" });
    Object.assign(built.base.documents[0]!, { base64: "tampered" });
    Object.assign(created, { direction: "not saved" });
    Object.assign(store.read("draft"), { title: "not saved" });
    Object.assign(store.readBase("draft").documents[0]!, { path: "not saved" });
    expect(store.read("draft")).toEqual(original.state);
    expect(store.readBase("draft")).toEqual(original.base);
  });

  it("enforces append-only bases, versions and outcomes in SQLite too", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const db = inspect(path);
    for (const table of ["workspace_bases", "workspace_versions", "workspace_outcomes"]) {
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/immutable/);
      expect(() => db.exec(`UPDATE ${table} SET workspace_id = 'changed'`)).toThrow(/immutable/);
    }
    expect(counts(db)).toEqual([1, 1, 1]);
    expect(store.readBase("draft")).toEqual(built.base);
  });
});

describe("workspace-scoped idempotency", () => {
  it("replays create before existence/build checks even after advancement, restart and source removal", () => {
    const root = directory();
    const source = join(root, "source.bin");
    const bytes = Buffer.from("Verified source prose\n");
    writeFileSync(source, bytes);
    const path = join(root, "authoring.sqlite");
    const store = open(path);
    const build = vi.fn(() => fixture("draft", readFileSync(source)));
    const created = store.create("draft", intent("create", '{"bundlePath":"source.bin"}'), build);
    store.mutate("draft", 1, intent("advance"), steer("later"));
    expect(readFileSync(source)).toEqual(bytes);
    store.close();
    rmSync(source);
    const reopened = open(path);
    expect(reopened.create("draft", intent("create", '{"bundlePath":"source.bin"}'), build)).toEqual(created);
    expect(build).toHaveBeenCalledTimes(1);
    expect(reopened.read("draft").version).toBe(2);
    expect(Buffer.from(reopened.readBase("draft").documents[0]!.base64, "base64")).toEqual(bytes);
  });

  it("replays the original mutation before stale-version checking or apply", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    store.create("draft", intent("create"), () => fixture());
    const original = store.mutate("draft", 1, intent("change", '{"kind":"set-direction","text":"first"}'), steer("first"));
    store.mutate("draft", 2, intent("later"), steer("later"));
    const apply = vi.fn(() => { throw new Error("must not apply"); });
    expect(store.mutate("draft", -100, intent("change", '{"kind":"set-direction","text":"first"}'), apply)).toEqual(original);
    expect(apply).not.toHaveBeenCalled();
    expect(store.read("draft").version).toBe(3);
    expectCode(() => store.mutate("draft", 1, intent("change", "different canonical intent"), apply), "IDEMPOTENCY_CONFLICT");
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects changed create intent and create/mutate key collisions, including identical intent strings", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    store.create("draft", intent("create", "canonical"), () => fixture());
    const build = vi.fn(() => fixture());
    const apply = vi.fn(steer("no"));
    expectCode(() => store.create("draft", intent("create", "changed"), build), "IDEMPOTENCY_CONFLICT");
    expectCode(() => store.create("draft", intent("fresh"), build), "WORKSPACE_EXISTS");
    expectCode(() => store.mutate("draft", 999, intent("create", "canonical"), apply), "IDEMPOTENCY_CONFLICT");
    store.mutate("draft", 1, intent("mutation", "canonical"), steer("yes"));
    expectCode(() => store.create("draft", intent("mutation", "canonical"), build), "IDEMPOTENCY_CONFLICT");
    expect(build).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("allows the same key with different intents in different workspaces", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    store.create("one", intent("same-key", "first workspace"), () => fixture("one"));
    store.create("two", intent("same-key", "second workspace"), () => fixture("two"));
    store.mutate("one", 1, intent("mutation", "one"), steer("one"));
    store.mutate("two", 1, intent("mutation", "two"), steer("two"));
    expect(store.read("one").direction).toBe("one");
    expect(store.read("two").direction).toBe("two");
  });
});

describe("transactions and concurrent connections", () => {
  it("serializes two connections, detects stale writes and shares durable replay outcomes", () => {
    const path = join(directory(), "authoring.sqlite");
    const first = open(path);
    const second = open(path);
    const initial = first.create("draft", intent("create"), () => fixture());
    expect(second.read("draft")).toEqual(initial);
    const secondClientVersion = second.read("draft").version;
    const updated = first.mutate("draft", 1, intent("first"), steer("first"));
    const apply = vi.fn(steer("stale"));
    expectCode(() => second.mutate("draft", secondClientVersion, intent("stale"), apply), "STALE_WORKSPACE");
    expect(apply).not.toHaveBeenCalled();
    const latest = second.mutate("draft", 2, intent("stale"), steer("retried"));
    expect(latest.version).toBe(3);
    expect(first.read("draft")).toEqual(latest);
    expect(second.mutate("draft", 1, intent("first"), apply)).toEqual(updated);
    expect(second.create("draft", intent("create"), () => { throw new Error("must not build"); })).toEqual(initial);
    expect(counts(inspect(path))).toEqual([1, 3, 3]);
  });

  it("bounds busy waiting when another connection holds BEGIN IMMEDIATE, then allows retry", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    store.create("draft", intent("create"), () => fixture());
    const other = inspect(path);
    other.exec("BEGIN IMMEDIATE");
    const apply = vi.fn(steer("saved after lock release"));
    const start = performance.now();
    try {
      let failure: unknown;
      try { store.mutate("draft", 1, intent("locked"), apply); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(WorkspaceStoreError);
      expect(failure).toMatchObject({ code: "STORAGE_FAILURE", message: expect.stringMatching(/locked|busy/i) });
      expect(performance.now() - start).toBeLessThan(3_000);
      expect(apply).not.toHaveBeenCalled();
      // WAL readers still see committed state while a writer owns the lock.
      expect(store.read("draft").version).toBe(1);
    } finally {
      other.exec("ROLLBACK");
    }
    expect(store.mutate("draft", 1, intent("locked"), apply).version).toBe(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("rolls back a throwing build/apply, including in-place edits, without consuming the key", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const failure = new Error("callback failed");
    expect(() => store.create("draft", intent("create"), () => { throw failure; })).toThrow(failure);
    expect(counts(inspect(path))).toEqual([0, 0, 0]);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    expect(() => store.mutate("draft", 1, intent("change"), (state) => {
      Object.assign(state, { version: 2, direction: "not saved" });
      Object.assign(state.base, { worldId: "not saved" });
      throw failure;
    })).toThrow(failure);
    expect(store.read("draft")).toEqual(built.state);
    expect(store.readBase("draft")).toEqual(built.base);
    expect(store.mutate("draft", 1, intent("change", "a new intent is fine after rollback"), steer("saved")).version).toBe(2);
  });

  it("rolls back base, state and outcome if the last create insert fails", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const db = inspect(path);
    db.exec(`CREATE TRIGGER reject_outcome BEFORE INSERT ON workspace_outcomes BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
    expectCode(() => store.create("draft", intent("create"), () => fixture()), "STORAGE_FAILURE");
    expect(counts(db)).toEqual([0, 0, 0]);
    expectCode(() => store.read("draft"), "WORKSPACE_NOT_FOUND");
    expectCode(() => store.readBase("draft"), "WORKSPACE_NOT_FOUND");
    db.exec("DROP TRIGGER reject_outcome");
    expect(store.create("draft", intent("create", "changed after failed insert"), () => fixture()).version).toBe(1);
    expect(counts(db)).toEqual([1, 1, 1]);
  });

  it("rolls back a mutation state record if its outcome insert fails, including across restart", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const db = inspect(path);
    db.exec(`CREATE TRIGGER reject_outcome BEFORE INSERT ON workspace_outcomes BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
    expectCode(() => store.mutate("draft", 1, intent("change"), steer("rolled back")), "STORAGE_FAILURE");
    expect(counts(db)).toEqual([1, 1, 1]);
    expect(store.read("draft")).toEqual(built.state);
    db.exec("DROP TRIGGER reject_outcome");
    store.close();
    const reopened = open(path);
    expect(reopened.read("draft")).toEqual(built.state);
    expect(reopened.readBase("draft")).toEqual(built.base);
    expect(reopened.mutate("draft", 1, intent("change", "retry after rollback"), steer("saved")).version).toBe(2);
    expect(counts(db)).toEqual([1, 2, 2]);
  });
});

describe("workspace invariants", () => {
  const invalidMutations: readonly [string, (state: WorkspaceStateV1) => WorkspaceStateV1][] = [
    ["ID", (state) => ({ ...state, version: 2, id: "changed" })],
    ["format", (state) => Object.assign({ ...state, version: 2 }, { format: "other" }) as WorkspaceStateV1],
    ["base world", (state) => ({ ...state, version: 2, base: { ...state.base, worldId: "changed" } })],
    ["base snapshot", (state) => ({ ...state, version: 2, base: { ...state.base, snapshotDigest: "changed" } })],
    ["in-place base", (state) => { Object.assign(state.base, { worldId: "changed" }); return { ...state, version: 2 }; }],
    ["unchanged version", (state) => state],
    ["skipped version", (state) => ({ ...state, version: 3 })],
    ["negative version", (state) => ({ ...state, version: -1 })],
    ["fractional version", (state) => ({ ...state, version: 1.5 })],
    ["unsafe version", (state) => ({ ...state, version: Number.MAX_SAFE_INTEGER + 1 })],
  ];

  it.each(invalidMutations)("rejects changes to %s without recording a version or key", (_name, apply) => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    expectCode(() => store.mutate("draft", 1, intent("change"), apply), "INVALID_WORKSPACE_ACTION");
    expect(store.read("draft")).toEqual(built.state);
    expect(store.readBase("draft")).toEqual(built.base);
    expect(counts(inspect(path))).toEqual([1, 1, 1]);
    expect(store.mutate("draft", 1, intent("change", "valid retry"), steer("valid")).version).toBe(2);
  });

  it.each(["state ID", "state base", "world ID", "snapshot digest", "zero version", "negative version", "unsafe version"])(
    "rejects an inconsistent initial %s atomically", (kind) => {
      const path = join(directory(), "authoring.sqlite");
      const store = open(path);
      const built = fixture();
      if (kind === "state ID") Object.assign(built.state, { id: "wrong" });
      if (kind === "state base") Object.assign(built.state.base, { snapshotDigest: "wrong" });
      if (kind === "world ID") Object.assign(built.base.world.world, { worldId: "wrong" });
      if (kind === "snapshot digest") Object.assign(built.base.world, { snapshotDigest: "wrong" });
      if (kind === "zero version") Object.assign(built.state, { version: 0 });
      if (kind === "negative version") Object.assign(built.state, { version: -1 });
      if (kind === "unsafe version") Object.assign(built.state, { version: Number.MAX_SAFE_INTEGER + 1 });
      expectCode(() => store.create("draft", intent("create"), () => built), "INVALID_WORKSPACE_ACTION");
      expect(counts(inspect(path))).toEqual([0, 0, 0]);
      expect(store.create("draft", intent("create", "valid retry"), () => fixture()).version).toBe(1);
    },
  );

  it("rejects an initial zero version through the SQL constraint too", () => {
    const path = join(directory(), "authoring.sqlite");
    open(path);
    const db = inspect(path);
    const built = fixture();
    Object.assign(built.state, { version: 0 });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO workspace_bases
        (workspace_id, world_id, snapshot_digest, base_json) VALUES (?, ?, ?, ?)`)
        .run("draft", worldId, digest, JSON.stringify(built.base));
      expect(() => db.prepare(`INSERT INTO workspace_versions
        (workspace_id, version, state_json) VALUES (?, ?, ?)`)
        .run("draft", 0, JSON.stringify(built.state))).toThrow(/CHECK constraint failed: version >= 1/);
    } finally {
      db.exec("ROLLBACK");
    }
    expect(counts(db)).toEqual([0, 0, 0]);
  });

  it("rejects version overflow before calling apply", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    const built = fixture();
    Object.assign(built.state, { version: Number.MAX_SAFE_INTEGER });
    store.create("draft", intent("create"), () => built);
    const apply = vi.fn(steer("overflow"));
    expectCode(() => store.mutate("draft", Number.MAX_SAFE_INTEGER, intent("overflow"), apply), "INVALID_WORKSPACE_ACTION");
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("database identity and path safety", () => {
  it("rejects a foreign SQLite database without changing its data, pragmas, bytes or directory entries", () => {
    const root = directory();
    const path = join(root, "foreign.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE important (data TEXT); INSERT INTO important VALUES ('keep me'); PRAGMA user_version = 12");
    db.close();
    const before = readFileSync(path);
    const files = readdirSync(root);
    expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(root)).toEqual(files);
    const unchanged = inspect(path);
    expect(unchanged.prepare("SELECT data FROM important").get()?.["data"]).toBe("keep me");
    expect(unchanged.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(0);
    expect(unchanged.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(12);
    expect(unchanged.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("delete");
  });

  it.each(["", "not a sqlite database"])("does not adopt or modify a preexisting unowned file (%j)", (contents) => {
    const root = directory();
    const path = join(root, "foreign.sqlite");
    writeFileSync(path, contents, { mode: 0o644 });
    expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readdirSync(root)).toEqual(["foreign.sqlite"]);
  });

  it("does not even touch the sidecars of a live foreign WAL database", () => {
    const root = directory();
    const path = join(root, "foreign.sqlite");
    const db = inspect(path);
    db.exec(`CREATE TABLE important (data TEXT);
      PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      INSERT INTO important VALUES ('uncheckpointed foreign data')`);
    const files = readdirSync(root);
    expect(files).toContain("foreign.sqlite-wal");
    expect(files).toContain("foreign.sqlite-shm");
    const before = files.map((name) => readFileSync(join(root, name)));
    expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
    expect(readdirSync(root)).toEqual(files);
    expect(files.map((name) => readFileSync(join(root, name)))).toEqual(before);
  });

  it.each(["application_id", "user_version", "schema", "sqlite-like name"])("rejects an incompatible %s without repairing it", (kind) => {
    const path = join(directory(), "authoring.sqlite");
    open(path).close();
    const db = new DatabaseSync(path);
    db.exec(kind === "schema" ? "CREATE TABLE unrelated (data TEXT)"
      : kind === "sqlite-like name" ? "CREATE TABLE sqliteXforeign (data TEXT)"
      : `PRAGMA ${kind} = 123`);
    db.close();
    const before = readFileSync(path);
    expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([false, true])("rejects a database symlink (dangling: %s)", (dangling) => {
    const root = directory();
    const target = join(root, "target.sqlite");
    if (!dangling) open(target).close();
    const path = join(root, "link.sqlite");
    symlinkSync(target, path);
    const before = dangling ? undefined : readFileSync(target);
    expect(() => new SqliteWorkspaceStore(path)).toThrow(/symlink/);
    if (before !== undefined) expect(readFileSync(target)).toEqual(before);
    else expect(readdirSync(root)).toEqual(["link.sqlite"]);
  });

  it("rejects non-durable paths and directories", () => {
    expectCode(() => new SqliteWorkspaceStore(":memory:"), "STORAGE_FAILURE");
    expectCode(() => new SqliteWorkspaceStore(""), "STORAGE_FAILURE");
    expectCode(() => new SqliteWorkspaceStore(directory()), "STORAGE_FAILURE");
  });

  it("has idempotent close and reports access after close as storage failure", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    store.close();
    store.close();
    expectCode(() => store.read("draft"), "STORAGE_FAILURE");
    expectCode(() => store.readBase("draft"), "STORAGE_FAILURE");
    expectCode(() => store.create("draft", intent("create"), () => fixture()), "STORAGE_FAILURE");
    expectCode(() => store.mutate("draft", 1, intent("mutate"), steer("closed")), "STORAGE_FAILURE");
  });
});
