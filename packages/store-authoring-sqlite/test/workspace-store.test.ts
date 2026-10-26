import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceStoreError, type WorkspaceIntent } from "@wmm/ports";
import type { WorkspaceBaseV1, WorkspaceReviewV1, WorkspaceStateV1 } from "@wmm/wire-contracts";

import { SqliteWorkspaceStore } from "../src/index.js";
import { APPLICATION_ID, LEGACY_SCHEMA_V1 } from "../src/database.js";

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

function review(state: WorkspaceStateV1, base: WorkspaceBaseV1, evaluationDigest = "c".repeat(64)): WorkspaceReviewV1 {
  return {
    format: "wmm.workspace-review/1",
    binding: {
      worldId: state.base.worldId, workspaceId: state.id, workspaceVersion: state.version,
      baseSnapshotDigest: state.base.snapshotDigest, semanticProfileDigest: base.world.world.semanticProfileDigest,
      evaluator: "bundled-workspace-review-v1",
      selectedGroups: state.proposals.filter((group) => group.decision === "selected")
        .map((group) => ({ id: group.id, version: group.version })),
      operationsDigest: "d".repeat(64), steeringDigest: "e".repeat(64),
    },
    candidateDigest: "f".repeat(64), candidateSnapshotDigest: null, evaluationDigest,
    limits: { maxWorkUnits: 100 }, execution: "completed", validity: "valid",
    checks: [{ id: "selection", status: "passed" }], diff: { documents: [], assertions: [] },
    diagnostics: [], limitations: ["No implicit or narrative claims are inferred"],
  };
}

function seedLegacy(db: DatabaseSync, wal = false): { built: ReturnType<typeof fixture>; states: WorkspaceStateV1[] } {
  db.exec("BEGIN IMMEDIATE");
  for (const object of LEGACY_SCHEMA_V1) db.exec(object.sql);
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1; COMMIT`);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  const built = fixture();
  const states = [built.state];
  states.push(steer("Avoid war")(states[0]!));
  states.push(steer("Keep the council")(states[1]!));
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO workspace_bases VALUES (?, ?, ?, ?)")
    .run("draft", worldId, digest, JSON.stringify(built.base, null, 2));
  for (const state of states) {
    db.prepare("INSERT INTO workspace_versions VALUES (?, ?, ?)")
      .run("draft", state.version, JSON.stringify(state, null, 2));
    db.prepare("INSERT INTO workspace_outcomes VALUES (?, ?, ?, ?, ?)")
      .run("draft", `legacy-${state.version}`, state.version === 1 ? "create" : "mutate", `exact intent ${state.version}\n`, state.version);
  }
  db.exec("COMMIT");
  return { built, states };
}

function legacyRows(db: DatabaseSync): unknown[] {
  return [
    db.prepare("SELECT * FROM workspace_bases ORDER BY workspace_id").all(),
    db.prepare("SELECT * FROM workspace_versions ORDER BY workspace_id, version").all(),
    db.prepare("SELECT * FROM workspace_outcomes ORDER BY workspace_id, idempotency_key").all(),
  ];
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
    expect(db.prepare("SELECT * FROM workspace_outcome_reviews").all()).toEqual([]);
    expect(store.readOutcomeReview("draft", "change")).toBeUndefined();
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
    expectCode(() => store.readReview("draft"), "STORAGE_FAILURE");
    expectCode(() => store.readOutcomeReview("draft", "create"), "STORAGE_FAILURE");
    expectCode(() => store.putReview("draft", 1, review(fixture().state, fixture().base)), "STORAGE_FAILURE");
    expectCode(() => store.create("draft", intent("create"), () => fixture()), "STORAGE_FAILURE");
    expectCode(() => store.mutate("draft", 1, intent("mutate"), steer("closed")), "STORAGE_FAILURE");
  });
});

describe("immutable workspace review receipts", () => {
  it("persists detached receipts across restart without changing semantic state, history or replay outcomes", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    const initial = store.create("draft", intent("create"), () => built);
    const current = store.mutate("draft", 1, intent("direction"), steer("Avoid war"));
    const db = inspect(path);
    const before = legacyRows(db);
    const receipt = review(current, built.base);
    const original = structuredClone(receipt);
    expect(store.putReview("draft", 2, receipt)).toBeUndefined();
    store.putReview("draft", 2, structuredClone(receipt));
    expect(db.prepare("SELECT count(*) AS count FROM workspace_reviews").get()?.["count"]).toBe(1);
    expect(legacyRows(db)).toEqual(before);
    expect(store.read("draft")).toEqual(current);
    expect(store.read("draft", 1)).toEqual(initial);
    Object.assign(receipt.binding, { workspaceId: "tampered" });
    Object.assign(receipt.limits, { maxWorkUnits: 999 });
    Object.assign(store.readReview("draft")!.binding, { worldId: "tampered" });
    expect(store.readReview("draft")).toEqual(original);
    store.close();

    const reopened = open(path);
    expect(reopened.readReview("draft")).toEqual(original);
    expect(reopened.readReview("draft", 2)).toEqual(original);
    expect(reopened.read("draft")).toEqual(current);
    expect(reopened.readBase("draft")).toEqual(built.base);
    const callback = vi.fn(() => { throw new Error("must replay"); });
    expect(reopened.create("draft", intent("create"), callback)).toEqual(initial);
    expect(reopened.mutate("draft", 1, intent("direction"), callback)).toEqual(current);
    expect(callback).not.toHaveBeenCalled();
    expect(legacyRows(db)).toEqual(before);
  });

  it("returns the latest insertion across all states, or only the exact requested state version", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    const initial = store.create("draft", intent("create"), () => built);
    expect(store.readReview("draft")).toBeUndefined();
    expect(store.readReview("missing")).toBeUndefined();
    const first = review(initial, built.base, "f".repeat(64));
    const second = review(initial, built.base, "1".repeat(64));
    store.putReview("draft", 1, first);
    store.putReview("draft", 1, second);
    store.putReview("draft", 1, first);
    expect(store.readReview("draft")).toEqual(second);
    expect(store.readReview("draft", 1)).toEqual(second);
    const versionTwo = store.mutate("draft", 1, intent("second"), steer("second"));
    expect(store.readReview("draft")).toEqual(second);
    expect(store.readReview("draft", 2)).toBeUndefined();
    const third = review(versionTwo, built.base, "2".repeat(64));
    store.putReview("draft", 2, third);
    store.mutate("draft", 2, intent("third"), steer("third"));
    expect(store.readReview("draft")).toEqual(third);
    expect(store.readReview("draft", 1)).toEqual(second);
    expect(store.readReview("draft", 2)).toEqual(third);
    expect(store.readReview("draft", 3)).toBeUndefined();
    expect(store.readReview("draft", 0)).toBeUndefined();
    expect(store.readReview("draft", 4)).toBeUndefined();
    store.close();
    const reopened = open(path);
    expect(reopened.readReview("draft")).toEqual(third);
    expect(reopened.readReview("draft", 1)).toEqual(second);
    expect(reopened.readReview("draft", 3)).toBeUndefined();
    expect(inspect(path).prepare("SELECT sequence FROM workspace_reviews ORDER BY sequence").all())
      .toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]);
  });

  it("isolates receipt identities and latest lookups by workspace", () => {
    const store = open(join(directory(), "authoring.sqlite"));
    const first = fixture("first");
    const second = fixture("second");
    store.create("first", intent("create"), () => first);
    store.create("second", intent("create"), () => second);
    const firstReceipt = review(first.state, first.base);
    const secondReceipt = review(second.state, second.base);
    store.putReview("first", 1, firstReceipt);
    store.putReview("second", 1, secondReceipt);
    expect(store.readReview("first")).toEqual(firstReceipt);
    expect(store.readReview("second", 1)).toEqual(secondReceipt);
    expectCode(() => store.putReview("missing", 1, firstReceipt), "WORKSPACE_NOT_FOUND");
  });

  it("serializes a stale reviewer against a mutation from a second connection, including duplicate receipts", () => {
    const path = join(directory(), "authoring.sqlite");
    const writer = open(path);
    const reviewer = open(path);
    const built = fixture();
    writer.create("draft", intent("create"), () => built);
    const receipt = review(reviewer.read("draft"), reviewer.readBase("draft"));
    reviewer.putReview("draft", 1, receipt);
    const next = writer.mutate("draft", 1, intent("advance"), steer("changed during review"));
    expectCode(() => reviewer.putReview("draft", 1, receipt), "STALE_WORKSPACE");
    expectCode(() => reviewer.putReview("draft", 1, { ...receipt, evaluationDigest: "2".repeat(64) }), "STALE_WORKSPACE");
    expect(writer.readReview("draft")).toEqual(receipt);
    expect(writer.readReview("draft", 2)).toBeUndefined();
    const nextReceipt = review(next, built.base, "3".repeat(64));
    reviewer.putReview("draft", 2, nextReceipt);
    expect(writer.readReview("draft")).toEqual(nextReceipt);
    expect(counts(inspect(path))).toEqual([1, 2, 2]);
    expect(inspect(path).prepare("SELECT count(*) AS count FROM workspace_reviews").get()?.["count"]).toBe(2);
  });

  it("acquires BEGIN IMMEDIATE before saving and allows a retry after a competing writer releases its lock", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const other = inspect(path);
    const receipt = review(built.state, built.base);
    other.exec("BEGIN IMMEDIATE");
    try {
      expectCode(() => store.putReview("draft", 1, receipt), "STORAGE_FAILURE");
      expect(store.readReview("draft")).toBeUndefined();
      expect(store.read("draft")).toEqual(built.state);
    } finally {
      other.exec("ROLLBACK");
    }
    store.putReview("draft", 1, receipt);
    expect(store.readReview("draft")).toEqual(receipt);
  });

  it.each([
    ["workspace ID", { workspaceId: "other" }],
    ["state version", { workspaceVersion: 2 }],
    ["zero version", { workspaceVersion: 0 }],
    ["string version", { workspaceVersion: "1" }],
    ["world", { worldId: "other" }],
    ["base snapshot", { baseSnapshotDigest: "2".repeat(64) }],
    ["semantic profile", { semanticProfileDigest: "2".repeat(64) }],
    ["evaluator", { evaluator: "other" }],
    ["missing selected group", { selectedGroups: [] }],
    ["unknown selected group", { selectedGroups: [{ id: "other", version: 1 }] }],
    ["wrong group version", { selectedGroups: [{ id: "selected", version: 2 }] }],
    ["null selected group", { selectedGroups: [null] }],
    ["operations digest", { operationsDigest: "bad digest" }],
    ["steering digest", { steeringDigest: "bad digest" }],
  ])("rejects malformed %s binding without changing stored records", (_name, binding) => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    Object.assign(built.state, { proposals: [{
      id: "selected", version: 1, title: "Selected", author: "Author", rationale: "Rationale",
      dependencies: [], exclusions: [], operations: [], decision: "selected", rejectionReason: null,
    }] });
    store.create("draft", intent("create"), () => built);
    const receipt = review(built.state, built.base);
    const before = legacyRows(inspect(path));
    Object.assign(receipt.binding, binding);
    expectCode(() => store.putReview("draft", 1, receipt), "INVALID_WORKSPACE_ACTION");
    expect(store.readReview("draft")).toBeUndefined();
    expect(legacyRows(inspect(path))).toEqual(before);
  });

  it.each([
    ["format", { format: "other" }],
    ["null binding", { binding: null }],
    ["candidate digest", { candidateDigest: "invalid" }],
    ["candidate snapshot digest", { candidateSnapshotDigest: "invalid" }],
    ["evaluation digest", { evaluationDigest: "invalid" }],
    ["execution", { execution: "interrupted" }],
    ["limits", { limits: { maxWorkUnits: 0 } }],
  ])("rejects malformed review %s", (_name, fields) => {
    const store = open(join(directory(), "authoring.sqlite"));
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const receipt = review(built.state, built.base);
    Object.assign(receipt, fields);
    expectCode(() => store.putReview("draft", 1, receipt), "INVALID_WORKSPACE_ACTION");
    expect(store.readReview("draft")).toBeUndefined();
  });

  it("compares the complete selected set and stored proposal versions, without depending on group order", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    const group = {
      title: "Proposal", author: "Author", rationale: "Rationale", dependencies: [], exclusions: [],
      operations: [], decision: "selected", rejectionReason: null,
    } as const;
    Object.assign(built.state, { proposals: [
      { ...group, id: "z", version: 3 }, { ...group, id: "a", version: 2 },
      { ...group, id: "undecided", version: 1, decision: "undecided" },
    ] });
    store.create("draft", intent("create"), () => built);
    const receipt = review(built.state, built.base);
    const duplicate = structuredClone(receipt);
    Object.assign(duplicate.binding, { selectedGroups: [{ id: "z", version: 3 }, { id: "z", version: 3 }] });
    expectCode(() => store.putReview("draft", 1, duplicate), "INVALID_WORKSPACE_ACTION");
    Object.assign(receipt.binding, { selectedGroups: [...receipt.binding.selectedGroups].reverse() });
    store.putReview("draft", 1, receipt);
    expect(store.readReview("draft")).toEqual(receipt);
  });

  it("rejects different receipt JSON under the same evaluation digest, preserving the original", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const receipt = review(built.state, built.base);
    store.putReview("draft", 1, receipt);
    for (const change of [
      { candidateDigest: "2".repeat(64) }, { validity: "invalid" }, { limits: { maxWorkUnits: 101 } },
      { limitations: ["different JSON under the same digest"] },
    ]) {
      expectCode(() => store.putReview("draft", 1, Object.assign(structuredClone(receipt), change)), "INVALID_WORKSPACE_ACTION");
    }
    const reordered = Object.assign({ evaluationDigest: receipt.evaluationDigest }, receipt);
    expectCode(() => store.putReview("draft", 1, reordered), "INVALID_WORKSPACE_ACTION");
    expect(store.readReview("draft")).toEqual(receipt);
    const db = inspect(path);
    expect(db.prepare("SELECT count(*) AS count FROM workspace_reviews").get()?.["count"]).toBe(1);
    expect(counts(db)).toEqual([1, 1, 1]);
  });

  it("enforces immutable reviews, their version foreign key and binding constraints in SQLite", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const receipt = review(built.state, built.base);
    store.putReview("draft", 1, receipt);
    const db = inspect(path);
    expect(() => db.exec("DELETE FROM workspace_reviews")).toThrow(/immutable/);
    expect(() => db.exec("UPDATE workspace_reviews SET review_json = '{}'")).toThrow(/immutable/);
    expect(() => db.prepare(`INSERT OR REPLACE INTO workspace_reviews
      (workspace_id, evaluation_digest, version, review_json) VALUES (?, ?, ?, ?)`)
      .run("draft", receipt.evaluationDigest, 1, JSON.stringify({ ...receipt, validity: "invalid" }))).toThrow(/immutable/);
    expect(() => db.prepare(`INSERT OR REPLACE INTO workspace_reviews
      (sequence, workspace_id, evaluation_digest, version, review_json) VALUES (1, ?, ?, ?, ?)`)
      .run("draft", "2".repeat(64), 1, JSON.stringify({ ...receipt, evaluationDigest: "2".repeat(64) }))).toThrow(/immutable/);
    const insert = db.prepare(`INSERT INTO workspace_reviews
      (workspace_id, evaluation_digest, version, review_json) VALUES (?, ?, ?, ?)`);
    const unknownVersion = review({ ...built.state, version: 2 }, built.base, "3".repeat(64));
    expect(() => insert.run("draft", unknownVersion.evaluationDigest, 2, JSON.stringify(unknownVersion))).toThrow(/FOREIGN KEY/);
    for (const binding of [
      { workspaceId: "other" }, { workspaceVersion: 2 }, { worldId: "other" },
      { baseSnapshotDigest: "2".repeat(64) }, { semanticProfileDigest: "2".repeat(64) },
    ]) {
      const malformed = review(built.state, built.base, "4".repeat(64));
      Object.assign(malformed.binding, binding);
      expect(() => insert.run("draft", malformed.evaluationDigest, 1, JSON.stringify(malformed))).toThrow();
    }
    expect(store.readReview("draft")).toEqual(receipt);
    expect(counts(db)).toEqual([1, 1, 1]);
  });

  it("rolls back a failed review insert and permits retry without consuming state or receipt identity", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const db = inspect(path);
    const before = legacyRows(db);
    const receipt = review(built.state, built.base);
    db.exec("CREATE TRIGGER reject_review AFTER INSERT ON workspace_reviews BEGIN SELECT RAISE(ABORT, 'injected review failure'); END");
    expectCode(() => store.putReview("draft", 1, receipt), "STORAGE_FAILURE");
    expect(store.readReview("draft")).toBeUndefined();
    expect(legacyRows(db)).toEqual(before);
    db.exec("DROP TRIGGER reject_review");
    store.close();
    const reopened = open(path);
    expect(reopened.readReview("draft")).toBeUndefined();
    reopened.putReview("draft", 1, receipt);
    expect(reopened.readReview("draft")).toEqual(receipt);
    expect(legacyRows(db)).toEqual(before);
  });
});

describe("review associations frozen with mutation outcomes", () => {
  it("freezes an absent receipt even if reviews are saved later at the mutation's state version", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    const initial = store.create("draft", intent("create"), () => built);
    const updated = store.mutate("draft", 1, intent("change"), steer("changed"));
    const db = inspect(path);
    const association = [{ workspace_id: "draft", idempotency_key: "change", review_sequence: null }];
    expect(db.prepare("SELECT * FROM workspace_outcome_reviews").all()).toEqual(association);
    expect(store.readOutcomeReview("draft", "change")).toBeUndefined();
    store.putReview("draft", 2, review(updated, built.base));
    const latest = review(updated, built.base, "2".repeat(64));
    store.putReview("draft", 2, latest);
    expect(store.readReview("draft", 2)).toEqual(latest);
    const callback = vi.fn(() => { throw new Error("must replay"); });
    expect(store.mutate("draft", 0, intent("change"), callback)).toEqual(updated);
    expect(store.readOutcomeReview("draft", "change")).toBeUndefined();
    expect(store.create("draft", intent("create"), callback)).toEqual(initial);
    expect(store.readOutcomeReview("draft", "create")).toBeUndefined();
    expect(store.readOutcomeReview("draft", "missing")).toBeUndefined();
    expect(store.readOutcomeReview("missing", "change")).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM workspace_outcome_reviews").all()).toEqual(association);
    expect(counts(db)).toEqual([1, 2, 2]);
    store.close();
    const reopened = open(path);
    expect(reopened.mutate("draft", 1, intent("change"), callback)).toEqual(updated);
    expect(reopened.readOutcomeReview("draft", "change")).toBeUndefined();
    expect(reopened.readOutcomeReview("draft", "create")).toBeUndefined();
    expect(reopened.readReview("draft")).toEqual(latest);
  });

  it.each(["same state version", "later edited state"])("keeps the original receipt after a new review of the %s", (when) => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const reviewer = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const original = review(built.state, built.base);
    reviewer.putReview("draft", 1, original);
    const updated = store.mutate("draft", 1, intent("change"), steer("changed"));
    expect(store.readOutcomeReview("draft", "change")).toEqual(original);
    const current = when === "same state version" ? updated
      : reviewer.mutate("draft", 2, intent("later edit"), steer("edited again"));
    const latest = review(current, built.base, "2".repeat(64));
    reviewer.putReview("draft", current.version, latest);
    expect(store.readReview("draft")).toEqual(latest);
    const callback = vi.fn(() => { throw new Error("must replay"); });
    expect(reviewer.mutate("draft", 1, intent("change"), callback)).toEqual(updated);
    expect(reviewer.readOutcomeReview("draft", "change")).toEqual(original);
    expect(reviewer.readOutcomeReview("draft", "create")).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    Object.assign(store.readOutcomeReview("draft", "change")!.binding, { worldId: "tampered" });
    expect(store.readOutcomeReview("draft", "change")).toEqual(original);
    store.close();
    reviewer.close();
    const reopened = open(path);
    expect(reopened.mutate("draft", 0, intent("change"), callback)).toEqual(updated);
    expect(reopened.readOutcomeReview("draft", "change")).toEqual(original);
    expect(reopened.readReview("draft")).toEqual(latest);
    expect(reopened.read("draft")).toEqual(current);
  });

  it("captures the latest insertion per workspace and isolates identical idempotency keys", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const first = fixture("first");
    const second = fixture("second");
    store.create("first", intent("create"), () => first);
    store.create("second", intent("create"), () => second);
    const old = review(first.state, first.base, "f".repeat(64));
    const latestFirst = review(first.state, first.base, "1".repeat(64));
    const latestSecond = review(second.state, second.base, "2".repeat(64));
    store.putReview("first", 1, old);
    store.putReview("first", 1, latestFirst);
    store.putReview("second", 1, latestSecond);
    store.putReview("first", 1, old);
    store.mutate("first", 1, intent("change"), steer("first change"));
    store.mutate("second", 1, intent("change"), steer("second change"));
    expect(store.readOutcomeReview("first", "change")).toEqual(latestFirst);
    expect(store.readOutcomeReview("second", "change")).toEqual(latestSecond);
    expect(store.readOutcomeReview("first", "create")).toBeUndefined();
    expect(store.readOutcomeReview("second", "create")).toBeUndefined();
    expect(inspect(path).prepare("SELECT * FROM workspace_outcome_reviews ORDER BY workspace_id").all()).toEqual([
      { workspace_id: "first", idempotency_key: "change", review_sequence: 2 },
      { workspace_id: "second", idempotency_key: "change", review_sequence: 3 },
    ]);
  });

  it("enforces immutable associations, both foreign keys and workspace ownership in SQLite", () => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    const other = fixture("other");
    store.create("draft", intent("create"), () => built);
    store.create("other", intent("create"), () => other);
    const receipt = review(built.state, built.base);
    store.putReview("draft", 1, receipt);
    store.putReview("other", 1, review(other.state, other.base));
    store.mutate("draft", 1, intent("change"), steer("changed"));
    const db = inspect(path);
    expect(() => db.exec("UPDATE workspace_outcome_reviews SET review_sequence = NULL")).toThrow(/immutable/);
    expect(() => db.exec("DELETE FROM workspace_outcome_reviews")).toThrow(/immutable/);
    expect(() => db.exec(`INSERT OR REPLACE INTO workspace_outcome_reviews VALUES ('draft', 'change', NULL)`)).toThrow(/immutable/);
    expect(() => db.exec(`INSERT INTO workspace_outcome_reviews VALUES ('draft', 'missing-outcome', NULL)`)).toThrow(/FOREIGN KEY/);
    db.exec(`INSERT INTO workspace_outcomes VALUES ('draft', 'manual', 'mutate', 'manual', 2)`);
    expect(() => db.exec(`INSERT INTO workspace_outcome_reviews VALUES ('draft', 'manual', 9999)`)).toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`INSERT INTO workspace_outcome_reviews VALUES ('draft', 'manual', 2)`)).toThrow(/same workspace/);
    expect(() => db.exec(`INSERT INTO workspace_outcome_reviews VALUES ('draft', 'create', 1)`)).toThrow(/mutation outcome/);
    db.exec(`INSERT INTO workspace_outcome_reviews VALUES ('draft', 'manual', NULL)`);
    expect(store.readOutcomeReview("draft", "manual")).toBeUndefined();
    expect(store.readOutcomeReview("draft", "change")).toEqual(receipt);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([false, true])("rolls back state, outcome and association if the association insert fails (review present: %s)", (reviewPresent) => {
    const path = join(directory(), "authoring.sqlite");
    const store = open(path);
    const built = fixture();
    store.create("draft", intent("create"), () => built);
    const receipt = reviewPresent ? review(built.state, built.base) : undefined;
    if (receipt !== undefined) store.putReview("draft", 1, receipt);
    const db = inspect(path);
    const before = legacyRows(db);
    db.exec(`CREATE TRIGGER reject_outcome_review AFTER INSERT ON workspace_outcome_reviews
      BEGIN SELECT RAISE(ABORT, 'injected association failure'); END`);
    expectCode(() => store.mutate("draft", 1, intent("change"), steer("rolled back")), "STORAGE_FAILURE");
    expect(legacyRows(db)).toEqual(before);
    expect(db.prepare("SELECT * FROM workspace_outcome_reviews").all()).toEqual([]);
    expect(store.readOutcomeReview("draft", "change")).toBeUndefined();
    expect(store.readReview("draft")).toEqual(receipt);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("DROP TRIGGER reject_outcome_review");
    store.close();
    const reopened = open(path);
    expect(reopened.read("draft")).toEqual(built.state);
    expect(reopened.readOutcomeReview("draft", "change")).toBeUndefined();
    const updated = reopened.mutate("draft", 1, intent("change", "new intent after rollback"), steer("saved"));
    expect(updated.version).toBe(2);
    expect(reopened.readOutcomeReview("draft", "change")).toEqual(receipt);
    expect(db.prepare("SELECT count(*) AS count FROM workspace_outcome_reviews").get()?.["count"]).toBe(1);
    expect(counts(db)).toEqual([1, 2, 2]);
  });
});

describe("owned authoring v1 to v2 migration", () => {
  it("preserves exact legacy base/state JSON, decisions and replay keys while adding durable reviews", () => {
    const path = join(directory(), "authoring.sqlite");
    const legacy = new DatabaseSync(path);
    const { built, states } = seedLegacy(legacy);
    const before = legacyRows(legacy);
    legacy.close();
    const store = open(path);
    const db = inspect(path);
    expect(db.prepare("PRAGMA application_id").get()?.["application_id"]).toBe(APPLICATION_ID);
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
    expect(legacyRows(db)).toEqual(before);
    expect(store.readBase("draft")).toEqual(built.base);
    for (const state of states) expect(store.read("draft", state.version)).toEqual(state);
    const callback = vi.fn(() => { throw new Error("legacy replay must not execute"); });
    expect(store.create("draft", intent("legacy-1", "exact intent 1\n"), callback)).toEqual(states[0]);
    for (const state of states.slice(1)) {
      expect(store.mutate("draft", 0, intent(`legacy-${state.version}`, `exact intent ${state.version}\n`), callback)).toEqual(state);
    }
    expect(callback).not.toHaveBeenCalled();
    expectCode(() => store.mutate("draft", 3, intent("legacy-2", "changed intent"), callback), "IDEMPOTENCY_CONFLICT");
    const receipt = review(states[2]!, built.base);
    store.putReview("draft", 3, receipt);
    expect(store.readReview("draft", 3)).toEqual(receipt);
    for (const state of states) expect(store.readOutcomeReview("draft", `legacy-${state.version}`)).toBeUndefined();
    expect(store.mutate("draft", 0, intent("legacy-2", "exact intent 2\n"), callback)).toEqual(states[1]);
    expect(db.prepare("SELECT * FROM workspace_outcome_reviews").all()).toEqual([]);
    expect(legacyRows(db)).toEqual(before);
    store.close();
    const reopened = open(path);
    expect(reopened.readReview("draft")).toEqual(receipt);
    expect(reopened.read("draft")).toEqual(states[2]);
    expect(legacyRows(db)).toEqual(before);
    expect(reopened.mutate("draft", 3, intent("post-migration"), steer("v2 mutation")).version).toBe(4);
    expect(reopened.readOutcomeReview("draft", "post-migration")).toEqual(receipt);
    for (const state of states) expect(reopened.readOutcomeReview("draft", `legacy-${state.version}`)).toBeUndefined();
  });

  it("migrates live owned v1 WAL data and reopens while the v2 header remains uncheckpointed", () => {
    const path = join(directory(), "authoring.sqlite");
    const legacy = inspect(path);
    const { states, built } = seedLegacy(legacy, true);
    const before = legacyRows(legacy);
    expect(readFileSync(path).readUInt32BE(60)).toBe(1);
    expect(readFileSync(`${path}-wal`).length).toBeGreaterThan(0);
    const first = open(path);
    expect(legacyRows(legacy)).toEqual(before);
    expect(legacy.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
    const second = open(path);
    const receipt = review(states[2]!, built.base);
    second.putReview("draft", 3, receipt);
    expect(first.readReview("draft")).toEqual(receipt);
    expect(first.read("draft")).toEqual(states[2]);
    expect(legacyRows(legacy)).toEqual(before);
  });

  it("creates new databases directly at schema v2 without changing the captured v1 objects", () => {
    const path = join(directory(), "authoring.sqlite");
    open(path);
    const db = inspect(path);
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
    for (const object of LEGACY_SCHEMA_V1) {
      expect(db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name = ?").get(object.name)).toEqual(object);
    }
  });

  it.each(["foreign application", "future v3", "extra table", "missing guard", "modified guard", "pretend v2"])(
    "rejects %s v1 databases without changing bytes or sidecars", (kind) => {
      const root = directory();
      const path = join(root, "authoring.sqlite");
      const db = new DatabaseSync(path);
      seedLegacy(db);
      db.exec(kind === "foreign application" ? "PRAGMA application_id = 123"
        : kind === "future v3" ? "PRAGMA user_version = 3"
        : kind === "extra table" ? "CREATE TABLE unrelated (data TEXT)"
        : kind === "missing guard" ? "DROP TRIGGER workspace_versions_insert_guard"
        : kind === "modified guard" ? `DROP TRIGGER workspace_versions_no_update;
          CREATE TRIGGER workspace_versions_no_update BEFORE UPDATE ON workspace_versions BEGIN SELECT RAISE(ABORT, 'different'); END`
        : "PRAGMA user_version = 2");
      db.close();
      const files = readdirSync(root);
      const before = files.map((name) => readFileSync(join(root, name)));
      expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
      expect(readdirSync(root)).toEqual(files);
      expect(files.map((name) => readFileSync(join(root, name)))).toEqual(before);
    },
  );

  it("rejects an owned but malformed v1 SQLite file without changing it", () => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const legacy = new DatabaseSync(path);
    seedLegacy(legacy);
    legacy.close();
    const malformed = readFileSync(path);
    malformed[100] = 0; // Invalid page-one b-tree type, leaving the owned v1 identity intact.
    writeFileSync(path, malformed);
    expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
    expect(readFileSync(path)).toEqual(malformed);
    expect(readdirSync(root)).toEqual(["authoring.sqlite"]);
  });

  it.each(["modified schema", "future version"])("rejects %s present only in live v1 WAL without touching original sidecars", (kind) => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const legacy = inspect(path);
    seedLegacy(legacy, true);
    legacy.exec(kind === "modified schema" ? "CREATE TABLE unrelated (data TEXT)" : "PRAGMA user_version = 3");
    expect(readFileSync(path).readUInt32BE(60)).toBe(1);
    const files = readdirSync(root);
    expect(files).toContain("authoring.sqlite-wal");
    expect(files).toContain("authoring.sqlite-shm");
    const before = files.map((name) => readFileSync(join(root, name)));
    expectCode(() => new SqliteWorkspaceStore(path), "STORAGE_FAILURE");
    expect(readdirSync(root)).toEqual(files);
    expect(files.map((name) => readFileSync(join(root, name)))).toEqual(before);
  });

  it("rolls back all migration DDL and user_version after an injected failure, then permits migration on retry", () => {
    const root = directory();
    const path = join(root, "authoring.sqlite");
    const legacy = new DatabaseSync(path);
    seedLegacy(legacy);
    const rows = legacyRows(legacy);
    legacy.close();
    const before = readFileSync(path);
    const execute = DatabaseSync.prototype.exec;
    const failure = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      execute.call(this, sql);
      if (sql === "PRAGMA user_version = 2") throw new Error("injected migration failure after DDL and version change");
    });
    try {
      expect(() => new SqliteWorkspaceStore(path)).toThrow(/injected migration failure/);
    } finally {
      failure.mockRestore();
    }
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(root)).toEqual(["authoring.sqlite"]);
    const db = inspect(path);
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(1);
    expect(db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all())
      .toEqual(LEGACY_SCHEMA_V1);
    expect(legacyRows(db)).toEqual(rows);
    const store = open(path);
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
    expect(legacyRows(db)).toEqual(rows);
    expect(store.read("draft").version).toBe(3);
  });
});
