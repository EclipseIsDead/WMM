import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WorkspaceStoreError } from "@wmm/ports";

const APPLICATION_ID = 0x574d4d41; // WMMA: WMM authoring, not a world or query cache.
const SCHEMA_VERSION = 1;
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

const SCHEMA = [
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
      || header.readUInt32BE(68) !== APPLICATION_ID || header.readUInt32BE(60) !== SCHEMA_VERSION) {
      rejectDatabase("Not a compatible WMM authoring database (application_id/user_version)");
    }
  } finally {
    closeSync(fd);
  }
}

function checkSchema(db: DatabaseSync): void {
  if (db.prepare("PRAGMA application_id").get()?.["application_id"] !== APPLICATION_ID
    || db.prepare("PRAGMA user_version").get()?.["user_version"] !== SCHEMA_VERSION) {
    rejectDatabase("Not a compatible WMM authoring database (application_id/user_version)");
  }
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  if (objects.length !== SCHEMA.length || SCHEMA.some((expected) => !objects.some((actual) =>
    actual["name"] === expected.name && actual["type"] === expected.type && actual["sql"] === expected.sql))) {
    rejectDatabase("Incompatible WMM authoring database schema");
  }
}

function checkPath(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) rejectDatabase("Workspace database path must not be a symlink");
    if (!existing.isFile()) rejectDatabase("Workspace database must be a regular file");
    checkExistingFile(path);
    return false;
  }
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return checkPath(path);
    throw error;
  }
}

/** The path and its containing directory are trusted host configuration, never a model-supplied bundle path. */
export function openWorkspaceDatabase(databasePath: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    if (databasePath.length === 0 || databasePath === ":memory:") {
      rejectDatabase("A durable workspace database file path is required");
    }
    const path = resolve(databasePath);
    const created = checkPath(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (lstatSync(`${path}${suffix}`, { throwIfNoEntry: false })?.isSymbolicLink()) {
        rejectDatabase("Workspace database sidecar must not be a symlink");
      }
    }
    if (!created) {
      const probe = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        probe.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF`);
        checkSchema(probe);
      } finally {
        probe.close();
      }
    }
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL`);
    if (created) {
      // Commit the identity into the main file before entering WAL mode, so the read-only header guard works on reopen.
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const object of SCHEMA) db.exec(object.sql);
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      checkSchema(db);
    }
    if (db.prepare("PRAGMA journal_mode = WAL").get()?.["journal_mode"] !== "wal") {
      rejectDatabase("Workspace storage requires WAL journal mode");
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* Keep the original initialization failure. */ }
    throw storageFailure(error);
  }
}
