import { createRequire } from "node:module";
import { MIGRATIONS } from "./migrations";

// One SQLite connection, synchronous. bun:sqlite under Bun (the compiled sidecar), node:sqlite under Node 24 (unit tests).
// Both expose prepare().run/get/all with positional parameters, which is all this file relies on.

interface Stmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface Raw {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

function openRaw(path: string): Raw {
  const req = createRequire(import.meta.url);
  if (process.versions.bun) {
    const { Database } = req("bun:sqlite");
    return new Database(path);
  }
  const { DatabaseSync } = req("node:sqlite");
  return new DatabaseSync(path);
}

export type Param = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export class Db {
  private readonly raw: Raw;
  private readonly cache = new Map<string, Stmt>();
  private depth = 0;
  private commitHooks: (() => void)[] = [];

  constructor(path = ":memory:") {
    this.raw = openRaw(path);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate() {
    const version = Number((this.get("PRAGMA user_version") as { user_version: number }).user_version);
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]);
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  private stmt(sql: string): Stmt {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.raw.prepare(sql)));
    return s;
  }

  run(sql: string, ...params: Param[]): void {
    this.stmt(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    const r = this.stmt(sql).get(...params);
    return r == null ? undefined : ({ ...(r as object) } as T);
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params).map((r) => ({ ...(r as object) }) as T);
  }

  /** Runs `fn` in one transaction (BEGIN IMMEDIATE: single writer). Nested calls become savepoints. A throw rolls back. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp${this.depth}`;
    this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error("a transaction function must be synchronous");
    } catch (e) {
      this.depth--;
      this.raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      if (outer) this.commitHooks = [];
      throw e;
    }
    this.depth--;
    if (outer) {
      this.raw.exec("COMMIT");
      const hooks = this.commitHooks;
      this.commitHooks = [];
      for (const h of hooks) h();
    } else this.raw.exec(`RELEASE ${name}`);
    return result;
  }

  get inTx() {
    return this.depth > 0;
  }

  /** Runs `fn` after the outermost transaction commits (immediately when none is open); a rollback drops it. */
  afterCommit(fn: () => void) {
    if (this.depth === 0) fn();
    else this.commitHooks.push(fn);
  }

  close() {
    this.raw.close();
  }
}

// ------------------------------------------------------------------ row helpers
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const enc = (v: unknown): Param => (v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "object" ? JSON.stringify(v) : (v as Param));

/** `UPDATE table SET <camelCase keys as snake_case> WHERE <where>`. `undefined` and `null` both store NULL; objects are JSON. */
export function update(db: Db, table: string, where: Record<string, Param>, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const wk = Object.keys(where);
  db.run(
    `UPDATE ${table} SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE ${wk.map((k) => `${snake(k)} = ?`).join(" AND ")}`,
    ...keys.map((k) => enc(patch[k])),
    ...wk.map((k) => where[k]),
  );
}

/** `INSERT INTO table (...)` from camelCase keys. */
export function insert(db: Db, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table} (${keys.map(snake).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => enc(row[k])));
}

export const json = <T>(s: unknown): T | undefined => (typeof s === "string" ? (JSON.parse(s) as T) : undefined);
export const bool = (n: unknown) => n === 1 || n === true;
