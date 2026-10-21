import type { DatabaseSync } from "node:sqlite";

import { WorkspaceStoreError, type WorkspaceIntent, type WorkspaceStore } from "@wmm/ports";
import type { WorkspaceBaseV1, WorkspaceStateV1 } from "@wmm/wire-contracts";

import { openWorkspaceDatabase, storageFailure } from "./database.js";

type Operation = "create" | "mutate";
type BaseIdentity = WorkspaceStateV1["base"];

function invalid(message: string): never {
  throw new WorkspaceStoreError("INVALID_WORKSPACE_ACTION", message);
}

function serialize(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) invalid("Workspace records must be JSON data");
    return json;
  } catch (error) {
    if (error instanceof WorkspaceStoreError) throw error;
    return invalid("Workspace records must be serializable JSON data");
  }
}

function validateState(state: WorkspaceStateV1, id: string, base: BaseIdentity, version?: number): void {
  if (state === null || state.format !== "wmm.workspace/1" || state.id !== id) {
    invalid("Workspace format and ID must remain unchanged");
  }
  if (!Number.isSafeInteger(state.version) || state.version < 1
    || (version !== undefined && state.version !== version)) {
    invalid("Workspace version must be a safe positive integer and advance by exactly one");
  }
  if (state.base?.worldId !== base.worldId || state.base?.snapshotDigest !== base.snapshotDigest) {
    invalid("Workspace base cannot change");
  }
}

function baseIdentity(base: WorkspaceBaseV1): BaseIdentity {
  const worldId = base?.snapshot?.manifest?.worldId;
  const snapshotDigest = base?.snapshot?.snapshotDigest;
  if (typeof worldId !== "string" || typeof snapshotDigest !== "string"
    || base.snapshot.format !== "wmm.snapshot-record/1" || base.world?.format !== "wmm.world-export/1"
    || base.world.world?.worldId !== worldId || base.world.snapshotDigest !== snapshotDigest) {
    invalid("Workspace base snapshot and exported world must identify the same world and snapshot");
  }
  return { worldId, snapshotDigest };
}

/** Durable draft authoring only. No source-world filesystem or Git operations are performed. */
export class SqliteWorkspaceStore implements WorkspaceStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    this.#db = openWorkspaceDatabase(databasePath);
  }

  create(id: string, intent: WorkspaceIntent, build: () => { readonly state: WorkspaceStateV1; readonly base: WorkspaceBaseV1 }): WorkspaceStateV1 {
    return this.#transaction(() => {
      const replay = this.#replay(id, intent, "create");
      if (replay !== undefined) return replay;
      if (this.#sql(() => this.#db.prepare("SELECT 1 FROM workspace_bases WHERE workspace_id = ?").get(id)) !== undefined) {
        throw new WorkspaceStoreError("WORKSPACE_EXISTS", `Workspace already exists: ${id}`);
      }
      const built = build();
      // Snapshot callback-owned objects before validating or returning them; no live references are retained.
      const stateJson = serialize(built.state);
      const baseJson = serialize(built.base);
      const state = JSON.parse(stateJson) as WorkspaceStateV1;
      const base = baseIdentity(JSON.parse(baseJson) as WorkspaceBaseV1);
      validateState(state, id, base);
      this.#sql(() => this.#db.prepare(`INSERT INTO workspace_bases
        (workspace_id, world_id, snapshot_digest, base_json) VALUES (?, ?, ?, ?)`).run(id, base.worldId, base.snapshotDigest, baseJson));
      this.#insertVersion(id, state.version, stateJson, intent, "create");
      return state;
    });
  }

  read(id: string, atVersion?: number): WorkspaceStateV1 {
    const row = this.#sql(() => atVersion === undefined
      ? this.#db.prepare("SELECT state_json FROM workspace_versions WHERE workspace_id = ? ORDER BY version DESC LIMIT 1").get(id)
      : this.#db.prepare("SELECT state_json FROM workspace_versions WHERE workspace_id = ? AND version = ?").get(id, atVersion));
    if (row === undefined) {
      throw new WorkspaceStoreError("WORKSPACE_NOT_FOUND", `Workspace not found: ${id}${atVersion === undefined ? "" : ` at version ${atVersion}`}`);
    }
    return this.#decode<WorkspaceStateV1>(row["state_json"]);
  }

  readBase(id: string): WorkspaceBaseV1 {
    const row = this.#sql(() => this.#db.prepare("SELECT base_json FROM workspace_bases WHERE workspace_id = ?").get(id));
    if (row === undefined) throw new WorkspaceStoreError("WORKSPACE_NOT_FOUND", `Workspace not found: ${id}`);
    return this.#decode<WorkspaceBaseV1>(row["base_json"]);
  }

  mutate(id: string, expectedVersion: number, intent: WorkspaceIntent, apply: (state: WorkspaceStateV1) => WorkspaceStateV1): WorkspaceStateV1 {
    return this.#transaction(() => {
      const replay = this.#replay(id, intent, "mutate");
      if (replay !== undefined) return replay;
      const current = this.read(id);
      if (current.version !== expectedVersion) {
        throw new WorkspaceStoreError("STALE_WORKSPACE", `Workspace ${id} is at version ${current.version}, not ${expectedVersion}`);
      }
      const nextVersion = current.version + 1;
      if (!Number.isSafeInteger(nextVersion)) invalid("Workspace version cannot exceed the safe integer limit");
      // Capture invariants before apply: even an in-place edit cannot rewrite its own preconditions.
      const base = { ...current.base };
      const stateJson = serialize(apply(current));
      const state = JSON.parse(stateJson) as WorkspaceStateV1;
      validateState(state, id, base, nextVersion);
      this.#insertVersion(id, state.version, stateJson, intent, "mutate");
      return state;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#sql(() => this.#db.close());
    this.#closed = true;
  }

  #replay(id: string, intent: WorkspaceIntent, operation: Operation): WorkspaceStateV1 | undefined {
    const row = this.#sql(() => this.#db.prepare(`SELECT operation, intent, version FROM workspace_outcomes
      WHERE workspace_id = ? AND idempotency_key = ?`).get(id, intent.idempotencyKey));
    if (row === undefined) return undefined;
    if (row["operation"] !== operation || row["intent"] !== intent.intent) {
      throw new WorkspaceStoreError("IDEMPOTENCY_CONFLICT", `Idempotency key already has a different intent for workspace ${id}`);
    }
    return this.read(id, Number(row["version"]));
  }

  #insertVersion(id: string, version: number, stateJson: string, intent: WorkspaceIntent, operation: Operation): void {
    this.#sql(() => {
      this.#db.prepare("INSERT INTO workspace_versions (workspace_id, version, state_json) VALUES (?, ?, ?)").run(id, version, stateJson);
      this.#db.prepare(`INSERT INTO workspace_outcomes
        (workspace_id, idempotency_key, operation, intent, version) VALUES (?, ?, ?, ?, ?)`).run(id, intent.idempotencyKey, operation, intent.intent, version);
    });
  }

  #decode<T>(json: unknown): T {
    return this.#sql(() => {
      if (typeof json !== "string") throw new Error("Invalid stored workspace record");
      return JSON.parse(json) as T;
    });
  }

  #sql<T>(execute: () => T): T {
    try {
      if (this.#closed) throw new Error("Workspace store is closed");
      return execute();
    } catch (error) {
      throw storageFailure(error);
    }
  }

  #transaction<T>(execute: () => T): T {
    this.#sql(() => this.#db.exec("BEGIN IMMEDIATE"));
    try {
      const result = execute();
      this.#sql(() => this.#db.exec("COMMIT"));
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // A failed rollback must not hide the callback/constraint error that caused it.
      }
      throw error;
    }
  }
}
