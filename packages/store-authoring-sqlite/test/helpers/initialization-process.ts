// Fault injection stays in this subprocess: production code has no test hooks.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync, StatementSync, type SQLInputValue } from "node:sqlite";

const [databasePath, checkpoint, releasePath, action = "continue", scheduleJson = "{}"] = process.argv.slice(2);
if (databasePath === undefined || checkpoint === undefined || releasePath === undefined) {
  throw new Error("Expected database path, checkpoint and release path");
}
const root = `${dirname(resolve(databasePath))}${sep}`;
const native = new DatabaseSync(":memory:");
const sqliteVersion = native.prepare("SELECT sqlite_version() AS version").get()?.["version"];
native.close();
const wait = new Int32Array(new SharedArrayBuffer(4));
const schedule = JSON.parse(scheduleJson) as Record<string, string>;
const reached = new Set<string>();
let file: string | undefined;
let initializing: DatabaseSync | undefined;
let mainConnection: DatabaseSync | undefined;
let closed = false;
let walAttempts = 0;
let walStarted: number | undefined;

function report(point: string, details: Record<string, unknown> = {}): void {
  fs.writeSync(1, `${JSON.stringify({ checkpoint: point, sqliteVersion, file, closed, ...details })}\n`);
}

function pause(point: string, details: Record<string, unknown> = {}): void {
  const release = checkpoint === point ? releasePath : schedule[point];
  if (release === undefined || reached.has(point)) return;
  reached.add(point);
  report(point, details);
  while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
  if (action === "throw") throw new Error(`Injected initialization failure at ${point}`);
}

function isMain(db: DatabaseSync): boolean {
  return db.location() === resolve(databasePath!);
}

const open = fs.openSync;
fs.openSync = function (path, flags, mode) {
  const creating = typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0
    && typeof path === "string" && resolve(path).startsWith(root);
  if (creating) {
    file = path as string;
    pause("before-file-creation");
  }
  const fd = open(path, flags, mode);
  if (creating) pause("created-file", { size: fs.fstatSync(fd).size });
  return fd;
};
const execute = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql: string): void {
  if (sql === "BEGIN IMMEDIATE" && initializing === undefined && !isMain(this)) {
    initializing = this;
    pause("before-initialization", { applicationId: this.prepare("PRAGMA application_id").get()?.["application_id"] });
  }
  execute.call(this, sql);
  if (sql === "BEGIN IMMEDIATE" && isMain(this)) {
    mainConnection = this;
    pause("main-begin", {
      inTransaction: this.isTransaction,
      journalMode: this.prepare("PRAGMA journal_mode").get()?.["journal_mode"],
      busyTimeout: this.prepare("PRAGMA busy_timeout").get()?.["timeout"],
    });
  }
  if (sql === "COMMIT" && isMain(this)) {
    report("main-committed", { inTransaction: this.isTransaction });
    let reader: DatabaseSync | undefined;
    if (action === "hold-reader-after-commit") {
      // The rival has acknowledged its retry barrier before this COMMIT, so its
      // next native WAL step cannot race between COMMIT and this SHARED read.
      reader = new DatabaseSync(databasePath!, { readOnly: true });
      execute.call(reader, "BEGIN");
      reader.prepare("SELECT count(*) FROM sqlite_schema").get();
    }
    try { pause("main-read", { inTransaction: this.isTransaction, readerTransaction: reader?.isTransaction }); }
    finally { reader?.close(); }
  }
  if (sql.startsWith("CREATE TABLE workspace_bases")) {
    pause("during-initialization", {
      tables: this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
      applicationId: this.prepare("PRAGMA application_id").get()?.["application_id"],
      journal: fs.existsSync(`${file}-journal`),
    });
  }
};
const walStatements = new WeakMap<StatementSync, DatabaseSync>();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
  const statement = prepare.call(this, sql);
  if (sql === "PRAGMA journal_mode = WAL" && isMain(this)) {
    walStatements.set(statement, this);
    walStarted ??= performance.now();
  }
  return statement;
};
const get = StatementSync.prototype.get;
StatementSync.prototype.get = function (...args: (SQLInputValue | Record<string, SQLInputValue>)[]): ReturnType<typeof get> {
  const db = walStatements.get(this);
  if (db === undefined) return Reflect.apply(get, this, args) as ReturnType<typeof get>;
  pause("before-wal", { inTransaction: db.isTransaction });
  if (performance.now() - walStarted! >= 400) pause("before-native-wait");
  const busyTimeout = db.prepare("PRAGMA busy_timeout").get()?.["timeout"];
  const started = performance.now();
  walAttempts += 1;
  let rows: ReturnType<StatementSync["iterate"]> | undefined;
  if (action === "wal-own-transaction") execute.call(db, "BEGIN");
  if (action === "wal-active-reader") {
    rows = db.prepare("SELECT * FROM workspace_versions").iterate();
    rows.next();
  }
  if (action === "wal-finalized") db.close();
  try {
    const row = Reflect.apply(get, this, args) as ReturnType<typeof get>;
    report("wal-acquired", {
      attempt: walAttempts, busyTimeout, elapsedMs: performance.now() - started,
      phaseElapsedMs: performance.now() - walStarted!, row,
    });
    return row;
  } catch (error) {
    const nativeError = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
    report("wal-error", {
      attempt: walAttempts, busyTimeout, elapsedMs: performance.now() - started,
      phaseElapsedMs: performance.now() - walStarted!, inTransaction: db.isOpen ? db.isTransaction : null,
      nativeError: { code: nativeError.code, errcode: nativeError.errcode, errstr: nativeError.errstr, message: nativeError.message },
    });
    throw error; // Forward the exact native exception, never a synthesized BUSY result.
  } finally {
    rows?.return?.();
  }
};
const close = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function (): void {
  close.call(this);
  if (this === initializing) {
    closed = true;
    pause("initialized-closed");
  }
};
const link = fs.linkSync;
fs.linkSync = function (source, target) {
  const details = { source, target, entries: fs.readdirSync(dirname(String(source))) };
  pause("before-publication", details);
  try { link(source, target); }
  catch (error) {
    report("publication-error", { code: (error as NodeJS.ErrnoException).code });
    throw error;
  }
  pause("after-publication", details);
};
syncBuiltinESMExports();

const { SqliteWorkspaceStore } = await import("@wmm/store-authoring-sqlite");
const started = performance.now();
try {
  const store = new SqliteWorkspaceStore(databasePath);
  report("constructor-opened", {
    busyTimeout: mainConnection?.prepare("PRAGMA busy_timeout").get()?.["timeout"],
    inTransaction: mainConnection?.isTransaction,
  });
  store.close();
  fs.writeSync(1, `${JSON.stringify({ completed: true })}\n`);
} catch (error) {
  fs.writeSync(1, `${JSON.stringify({ failure: {
    code: (error as { code?: unknown }).code,
    message: error instanceof Error ? error.message : String(error),
  } })}\n`);
  process.exitCode = 1;
} finally {
  report("constructor-finished", { elapsedMs: performance.now() - started, walAttempts });
}
