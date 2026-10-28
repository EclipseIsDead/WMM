import { closeSync, constants, copyFileSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WorkspaceStoreError } from "@wmm/ports";

export const APPLICATION_ID = 0x574d4d41; // WMMA: WMM authoring, not a world or query cache.
const SCHEMA_VERSION = 2;
const BUSY_TIMEOUT_MS = 1_000;

const TABLES = [
  {
    name: "workspace_bases",
    sql: `CREATE TABLE workspace_bases (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      world_id TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      base_json TEXT NOT NULL CHECK (json_valid(base_json))
    ) STRICT`,
  },
  {
    name: "workspace_versions",
    sql: `CREATE TABLE workspace_versions (
      workspace_id TEXT NOT NULL REFERENCES workspace_bases(workspace_id),
      version INTEGER NOT NULL CHECK (version >= 1 AND version <= 9007199254740991),
      state_json TEXT NOT NULL CHECK (
        json_valid(state_json)
        AND json_extract(state_json, '$.format') IS 'wmm.workspace/1'
        AND json_extract(state_json, '$.id') IS workspace_id
        AND json_extract(state_json, '$.version') IS version
      ),
      PRIMARY KEY (workspace_id, version)
    ) STRICT`,
  },
  {
    name: "workspace_outcomes",
    sql: `CREATE TABLE workspace_outcomes (
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'mutate')),
      intent TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, idempotency_key),
      FOREIGN KEY (workspace_id, version) REFERENCES workspace_versions(workspace_id, version)
    ) STRICT`,
  },
];

/** Captured v1 DDL, deliberately unchanged: only this exact owned schema may be migrated. */
export const LEGACY_SCHEMA_V1 = [
  ...TABLES.map((table) => ({ ...table, type: "table" })),
  {
    type: "trigger",
    name: "workspace_versions_insert_guard",
    sql: `CREATE TRIGGER workspace_versions_insert_guard BEFORE INSERT ON workspace_versions BEGIN
      SELECT CASE WHEN
        json_extract(NEW.state_json, '$.base.worldId') IS NOT
          (SELECT world_id FROM workspace_bases WHERE workspace_id = NEW.workspace_id)
        OR json_extract(NEW.state_json, '$.base.snapshotDigest') IS NOT
          (SELECT snapshot_digest FROM workspace_bases WHERE workspace_id = NEW.workspace_id)
        THEN RAISE(ABORT, 'Workspace base cannot change') END;
      SELECT CASE WHEN
        EXISTS (SELECT 1 FROM workspace_versions WHERE workspace_id = NEW.workspace_id)
        AND NEW.version != (SELECT MAX(version) + 1 FROM workspace_versions WHERE workspace_id = NEW.workspace_id)
        THEN RAISE(ABORT, 'Workspace version must advance by one') END;
    END`,
  },
  ...TABLES.flatMap((table) => ["UPDATE", "DELETE"].map((operation) => ({
    type: "trigger",
    name: `${table.name}_no_${operation.toLowerCase()}`,
    sql: `CREATE TRIGGER ${table.name}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table.name} BEGIN
      SELECT RAISE(ABORT, 'Workspace records are immutable');
    END`,
  }))),
];

const REVIEW_SCHEMA = [
  {
    type: "table",
    name: "workspace_reviews",
    sql: `CREATE TABLE workspace_reviews (
      sequence INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      evaluation_digest TEXT NOT NULL,
      version INTEGER NOT NULL,
      review_json TEXT NOT NULL CHECK (
        json_valid(review_json)
        AND json_extract(review_json, '$.format') IS 'wmm.workspace-review/1'
        AND json_extract(review_json, '$.binding.workspaceId') IS workspace_id
        AND json_extract(review_json, '$.binding.workspaceVersion') IS version
        AND json_extract(review_json, '$.evaluationDigest') IS evaluation_digest
      ),
      UNIQUE (workspace_id, evaluation_digest),
      FOREIGN KEY (workspace_id, version) REFERENCES workspace_versions(workspace_id, version)
    ) STRICT`,
  },
  {
    type: "trigger",
    name: "workspace_reviews_insert_guard",
    sql: `CREATE TRIGGER workspace_reviews_insert_guard BEFORE INSERT ON workspace_reviews BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM workspace_reviews WHERE sequence = NEW.sequence
          OR (workspace_id = NEW.workspace_id AND evaluation_digest = NEW.evaluation_digest)
      ) THEN RAISE(ABORT, 'Workspace records are immutable') END;
      SELECT CASE WHEN
        json_extract(NEW.review_json, '$.binding.worldId') IS NOT
          (SELECT world_id FROM workspace_bases WHERE workspace_id = NEW.workspace_id)
        OR json_extract(NEW.review_json, '$.binding.baseSnapshotDigest') IS NOT
          (SELECT snapshot_digest FROM workspace_bases WHERE workspace_id = NEW.workspace_id)
        OR json_extract(NEW.review_json, '$.binding.semanticProfileDigest') IS NOT
          (SELECT json_extract(base_json, '$.world.world.semanticProfileDigest') FROM workspace_bases WHERE workspace_id = NEW.workspace_id)
        THEN RAISE(ABORT, 'Review must match the workspace base') END;
    END`,
  },
  ...["UPDATE", "DELETE"].map((operation) => ({
    type: "trigger",
    name: `workspace_reviews_no_${operation.toLowerCase()}`,
    sql: `CREATE TRIGGER workspace_reviews_no_${operation.toLowerCase()} BEFORE ${operation} ON workspace_reviews BEGIN
      SELECT RAISE(ABORT, 'Workspace records are immutable');
    END`,
  })),
];

const OUTCOME_REVIEW_SCHEMA = [
  {
    type: "table",
    name: "workspace_outcome_reviews",
    sql: `CREATE TABLE workspace_outcome_reviews (
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      review_sequence INTEGER REFERENCES workspace_reviews(sequence),
      PRIMARY KEY (workspace_id, idempotency_key),
      FOREIGN KEY (workspace_id, idempotency_key) REFERENCES workspace_outcomes(workspace_id, idempotency_key)
    ) STRICT`,
  },
  {
    type: "trigger",
    name: "workspace_outcome_reviews_insert_guard",
    sql: `CREATE TRIGGER workspace_outcome_reviews_insert_guard BEFORE INSERT ON workspace_outcome_reviews BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM workspace_outcome_reviews
          WHERE workspace_id = NEW.workspace_id AND idempotency_key = NEW.idempotency_key
      ) THEN RAISE(ABORT, 'Workspace records are immutable') END;
      SELECT CASE WHEN NEW.review_sequence IS NOT NULL AND (
        EXISTS (SELECT 1 FROM workspace_reviews WHERE sequence = NEW.review_sequence AND workspace_id != NEW.workspace_id)
        OR (SELECT operation FROM workspace_outcomes
          WHERE workspace_id = NEW.workspace_id AND idempotency_key = NEW.idempotency_key) IS 'create'
      ) THEN RAISE(ABORT, 'Review must match a mutation outcome in the same workspace') END;
    END`,
  },
  ...["UPDATE", "DELETE"].map((operation) => ({
    type: "trigger",
    name: `workspace_outcome_reviews_no_${operation.toLowerCase()}`,
    sql: `CREATE TRIGGER workspace_outcome_reviews_no_${operation.toLowerCase()} BEFORE ${operation} ON workspace_outcome_reviews BEGIN
      SELECT RAISE(ABORT, 'Workspace records are immutable');
    END`,
  })),
];

const SCHEMA = [...LEGACY_SCHEMA_V1, ...REVIEW_SCHEMA, ...OUTCOME_REVIEW_SCHEMA];

export function storageFailure(error: unknown): WorkspaceStoreError {
  if (error instanceof WorkspaceStoreError) return error;
  return new WorkspaceStoreError("STORAGE_FAILURE", `Workspace storage failure: ${error instanceof Error ? error.message : String(error)}`);
}

function rejectDatabase(message: string): never {
  throw new WorkspaceStoreError("STORAGE_FAILURE", message);
}

/** Check the header without opening SQLite: even WAL sidecars of foreign databases stay untouched. */
function checkExistingFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) rejectDatabase("Workspace database must be a regular file");
    const header = Buffer.alloc(100);
    let offset = 0;
    while (offset < header.length) {
      const length = readSync(fd, header, offset, header.length - offset, offset);
      if (length === 0) break;
      offset += length;
    }
    if (offset !== header.length || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0"
      || header.readUInt32BE(68) !== APPLICATION_ID || ![1, SCHEMA_VERSION].includes(header.readUInt32BE(60))) {
      rejectDatabase("Not a compatible WMM authoring database (application_id/user_version)");
    }
  } finally {
    closeSync(fd);
  }
}

function checkSchema(db: DatabaseSync): number {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (db.prepare("PRAGMA application_id").get()?.["application_id"] !== APPLICATION_ID
    || (version !== 1 && version !== SCHEMA_VERSION)) {
    rejectDatabase("Not a compatible WMM authoring database (application_id/user_version)");
  }
  const schema = version === 1 ? LEGACY_SCHEMA_V1 : SCHEMA;
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  if (objects.length !== schema.length || schema.some((expected) => !objects.some((actual) =>
    actual["name"] === expected.name && actual["type"] === expected.type && actual["sql"] === expected.sql))) {
    rejectDatabase("Incompatible WMM authoring database schema");
  }
  return version;
}

function probeExistingDatabase(path: string): void {
  // Even a read-only SQLite connection can write WAL shared-memory read marks. Validate a
  // private copy (including uncheckpointed DDL), never opening a rejected original in SQLite.
  const directory = mkdtempSync(join(tmpdir(), "wmm-authoring-probe-"));
  const snapshot = join(directory, "authoring.sqlite");
  let probe: DatabaseSync | undefined;
  try {
    copyFileSync(path, snapshot);
    try {
      copyFileSync(`${path}-wal`, `${snapshot}-wal`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    probe = new DatabaseSync(snapshot, { readOnly: true, allowExtension: false });
    probe.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF`);
    checkSchema(probe);
  } finally {
    try { probe?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

/** Validate an existing path without SQLite; true means the main file is absent. */
function checkPath(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) rejectDatabase("Workspace database path must not be a symlink");
    if (!existing.isFile()) rejectDatabase("Workspace database must be a regular file");
    checkExistingFile(path);
    return false;
  }
  return true;
}

function checkSidecars(path: string, unpublished = false): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
    if (sidecar === undefined) continue;
    if (sidecar.isSymbolicLink()) rejectDatabase("Workspace database sidecar must not be a symlink");
    if (!sidecar.isFile()) rejectDatabase("Workspace database sidecar must be a regular file");
    // An absent main file supplies no ownership evidence for any existing sidecar.
    // Recheck the main path, since another creator may just have published its database.
    if (unpublished && lstatSync(path, { throwIfNoEntry: false }) === undefined) {
      rejectDatabase("Unowned workspace database sidecar without a database");
    }
  }
}

function publishInitializedDatabase(path: string): void {
  // Stage on the same filesystem in a private, exclusively allocated directory. A killed
  // creator may leave this directory behind, but never an uninitialized database at path.
  const directory = mkdtempSync(join(dirname(path), ".wmm-authoring-init-"));
  const staged = join(directory, "authoring.sqlite");
  let db: DatabaseSync | undefined;
  try {
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    db = new DatabaseSync(staged, { enableForeignKeyConstraints: true, allowExtension: false });
    db.exec(`PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const object of SCHEMA) db.exec(object.sql);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original initialization failure. */ }
      throw error;
    }
    checkSchema(db);
    // No connection or WAL/journal is carried across publication: all schema/identity
    // bytes are committed to the closed main file before the configured path appears.
    db.close();
    db = undefined;
    checkSidecars(path, true);
    try {
      linkSync(staged, path); // Atomic no-clobber publication, never rename over a rival.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrent creator/foreign file won. The caller validates it from scratch.
    }
  } finally {
    try { db?.close(); } finally {
      // Only this invocation's allocation is owned; never sweep old staging names.
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function acquireWal(db: DatabaseSync): void {
  const statement = db.prepare("PRAGMA journal_mode = WAL");
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let retried = false;
  for (;;) {
    try {
      if (statement.get()?.["journal_mode"] !== "wal") rejectDatabase("Workspace storage requires WAL journal mode");
      break;
    } catch (error) {
      const native = error as { code?: unknown; errcode?: unknown };
      // WAL's lock upgrade can bypass SQLite's busy handler. Node resets get()'s
      // statement even on failure, so retry only this idempotent step after COMMIT.
      // errcode is an extended SQLite code; its low byte is the primary result.
      if (!(error instanceof Error) || native.code !== "ERR_SQLITE_ERROR"
        || typeof native.errcode !== "number" || (native.errcode & 0xff) !== 5 || db.isTransaction) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      Atomics.wait(wait, 0, 0, Math.min(10, remaining));
      const timeout = Math.floor(deadline - performance.now());
      if (timeout <= 0) throw error;
      // Native waiting on later attempts shares the deadline, not a fresh second.
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
      retried = true;
    }
  }
  if (retried) db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/** The path and its containing directory are trusted host configuration, never a model-supplied bundle path. */
export function openWorkspaceDatabase(databasePath: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    if (databasePath.length === 0 || databasePath === ":memory:") {
      rejectDatabase("A durable workspace database file path is required");
    }
    const path = resolve(databasePath);
    const missing = checkPath(path);
    checkSidecars(path, missing);
    if (missing) {
      publishInitializedDatabase(path);
      if (checkPath(path)) rejectDatabase("Workspace database disappeared during publication");
      checkSidecars(path);
    }
    probeExistingDatabase(path);
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL`);
    db.exec("BEGIN IMMEDIATE");
    try {
      // Recheck under the write lock: another connection may already have migrated v1.
      if (checkSchema(db) === 1) {
        for (const object of [...REVIEW_SCHEMA, ...OUTCOME_REVIEW_SCHEMA]) db.exec(object.sql);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        checkSchema(db);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original migration failure. */ }
      throw error;
    }
    acquireWal(db);
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* Keep the original initialization failure. */ }
    throw storageFailure(error);
  }
}
