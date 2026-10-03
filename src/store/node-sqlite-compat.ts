/**
 * A better-sqlite3–shaped database class on top of Node's built-in `node:sqlite`.
 *
 * Hosts that cannot build native modules (PI-Desktop installs extension
 * dependencies with `--ignore-scripts` and runs them in Electron-as-Node, whose
 * ABI no `npm rebuild` targets) still ship `node:sqlite` with FTS5 and the
 * trigram tokenizer. This adapter covers exactly the better-sqlite3 surface the
 * extension uses: prepare/run/get/all/iterate, exec, close, transaction (with
 * savepoints for nesting), pragma, and backup.
 *
 * `HERMES_SQLITE_DRIVER=better-sqlite3` forces the native driver; `node` forces
 * this one. By default `node:sqlite` is preferred when the runtime has it.
 */

import fs from "node:fs";

type NodeSqliteModule = typeof import("node:sqlite");
type NodeDatabase = InstanceType<NodeSqliteModule["DatabaseSync"]>;

export type CompatDatabaseOptions = {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Busy timeout in milliseconds, as in better-sqlite3 (default 5000). */
  timeout?: number;
};

export type CompatStatement = {
  run: (...args: any[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  get: (...args: any[]) => any;
  all: (...args: any[]) => any[];
  iterate: (...args: any[]) => Iterable<Record<string, unknown>>;
};

export type SqliteDriverPreference = "auto" | "node" | "better-sqlite3";

export function sqliteDriverPreference(env: NodeJS.ProcessEnv = process.env): SqliteDriverPreference {
  const value = env.HERMES_SQLITE_DRIVER?.trim().toLowerCase();
  if (value === "node" || value === "node:sqlite") return "node";
  if (value === "better-sqlite3" || value === "native") return "better-sqlite3";
  return "auto";
}

/** SQLite primary result codes, named the way better-sqlite3 names them. */
const PRIMARY_RESULT_CODES: Record<number, string> = {
  1: "SQLITE_ERROR", 2: "SQLITE_INTERNAL", 3: "SQLITE_PERM", 4: "SQLITE_ABORT", 5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED", 7: "SQLITE_NOMEM", 8: "SQLITE_READONLY", 9: "SQLITE_INTERRUPT", 10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT", 12: "SQLITE_NOTFOUND", 13: "SQLITE_FULL", 14: "SQLITE_CANTOPEN", 15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY", 17: "SQLITE_SCHEMA", 18: "SQLITE_TOOBIG", 19: "SQLITE_CONSTRAINT", 20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE", 22: "SQLITE_NOLFS", 23: "SQLITE_AUTH", 24: "SQLITE_FORMAT", 25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
};

/**
 * node:sqlite throws `code: "ERR_SQLITE_ERROR"` with the numeric result in
 * `errcode`; the extension (written for better-sqlite3) tests `code` against
 * names such as SQLITE_BUSY or SQLITE_CORRUPT. Rename to the primary code.
 */
function normalizeSqliteError(error: unknown): unknown {
  const record = error as { code?: unknown; errcode?: unknown } | null;
  if (record && typeof record === "object" && typeof record.errcode === "number") {
    const name = PRIMARY_RESULT_CODES[record.errcode & 0xff];
    if (name) {
      try {
        Object.defineProperty(record, "code", { value: name, configurable: true, writable: true, enumerable: true });
      } catch {
        // A frozen error keeps its original code.
      }
    }
  }
  return error;
}

function sqliteCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw normalizeSqliteError(error);
  }
}

/** node:sqlite rows have a null prototype; better-sqlite3 rows are plain objects. */
function plainRow<T>(row: T): T {
  return row && typeof row === "object" ? ({ ...row } as T) : row;
}

function* plainRows(rows: Iterable<unknown>): Iterable<Record<string, unknown>> {
  for (const row of rows) yield plainRow(row) as Record<string, unknown>;
}

function loadNodeSqlite(requireImpl: NodeRequire): NodeSqliteModule | null {
  try {
    const mod = requireImpl("node:sqlite") as NodeSqliteModule;
    return typeof mod?.DatabaseSync === "function" ? mod : null;
  } catch {
    return null;
  }
}

/**
 * The compat database class, or null when this runtime has no usable
 * `node:sqlite` or the preference asks for better-sqlite3.
 */
export function loadNodeSqliteDatabaseCtor(requireImpl: NodeRequire, env: NodeJS.ProcessEnv = process.env): any {
  if (sqliteDriverPreference(env) === "better-sqlite3") return null;
  const loaded = loadNodeSqlite(requireImpl);
  if (!loaded) return null;
  const sqlite: NodeSqliteModule = loaded;

  return class NodeSqliteCompatDatabase {
    private readonly db: NodeDatabase;
    private depth = 0;

    constructor(dbPath: string, options: CompatDatabaseOptions = {}) {
      const inMemory = dbPath === ":memory:" || dbPath === "";
      if (options.fileMustExist && !inMemory && !fs.existsSync(dbPath)) {
        throw Object.assign(new Error(`unable to open database file: ${dbPath}`), { code: "SQLITE_CANTOPEN" });
      }
      this.db = sqliteCall(() => new sqlite.DatabaseSync(dbPath, {
        readOnly: options.readonly === true,
        timeout: options.timeout ?? 5000,
      }));
    }

    prepare(sql: string): CompatStatement {
      const statement = sqliteCall(() => this.db.prepare(sql));
      return {
        run: (...args) => sqliteCall(() => statement.run(...args)),
        get: (...args) => plainRow(sqliteCall(() => statement.get(...args))),
        all: (...args) => sqliteCall(() => statement.all(...args)).map(plainRow),
        iterate: (...args) => plainRows(sqliteCall(() => statement.iterate(...args))),
      };
    }

    exec(sql: string): void {
      sqliteCall(() => this.db.exec(sql));
    }

    close(): void {
      if (this.db.isOpen) this.db.close();
    }

    /** better-sqlite3 semantics: a wrapper that runs `fn` atomically; nested calls use savepoints. */
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      return ((...args: Parameters<T>) => {
        const savepoint = `hermes_sp_${this.depth}`;
        this.exec(this.depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
        this.depth += 1;
        try {
          const result = fn(...args);
          this.depth -= 1;
          this.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          this.depth -= 1;
          if (this.depth === 0) {
            this.db.exec("ROLLBACK");
          } else {
            this.db.exec(`ROLLBACK TO ${savepoint}`);
            this.db.exec(`RELEASE ${savepoint}`);
          }
          throw error;
        }
      }) as T;
    }

    pragma(query: string, options: { simple?: boolean } = {}): unknown {
      const rows = this.prepare(`PRAGMA ${query}`).all() as Record<string, unknown>[];
      if (!options.simple) return rows;
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }

    async backup(destination: string, options: { progress?: () => number | void } = {}): Promise<void> {
      // node:sqlite only reports progress between steps, so a small database
      // copied in one step never calls back. Callers use the callback as a
      // heartbeat (and tests as a hook), so tick before and after as the
      // bun:sqlite path does.
      options.progress?.();
      try {
        await sqlite.backup(this.db, destination, {
          ...(options.progress ? { progress: () => void options.progress?.() } : {}),
        });
      } catch (error) {
        throw normalizeSqliteError(error);
      }
      options.progress?.();
    }
  };
}
