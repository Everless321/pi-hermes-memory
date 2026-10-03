/**
 * Company memory sync with dibs.
 *
 * The Markdown files stay the local source of truth for reading; dibs is the
 * shared record. Each synced store keeps `.dibs-sync.json`, mapping dibs entry
 * ids to the entry text last seen on both sides, and every reconcile is a
 * four-way diff against it:
 *
 *   new on dibs      → written locally
 *   gone on dibs     → removed locally (deleted, or flagged as wrong)
 *   new locally      → posted to dibs (including entries written offline)
 *   removed locally  → deleted on dibs; if dibs refuses (someone else's team
 *                      entry), the entry is restored locally
 *
 * Scopes: the global store syncs as the caller's personal memory (`user`),
 * a repository-keyed project store as team memory (`project`) for that repo.
 *
 * Configuration, read at the time of every request (a desktop host signs the
 * user in after the extension has loaded): PI-Desktop hands
 * { baseUrl, token } to the `pi.hermes-memory` extension through its
 * `@pi-desktop/extension-host` module; otherwise HERMES_DIBS_URL and
 * HERMES_DIBS_TOKEN. Without a base URL and a token, nothing syncs.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from "../constants.js";
import { withMarkdownMutationLock } from "../store/markdown-mutation-lock.js";

export type SyncScope = "project" | "user";
type Target = "memory" | "user" | "failure";

const SCOPE_TARGETS: Record<SyncScope, Target[]> = {
  project: ["memory", "failure"],
  user: ["memory", "user", "failure"],
};
const TARGET_FILES: Record<Target, string> = { memory: MEMORY_FILE, user: USER_FILE, failure: "failures.md" };
const STATE_FILE = ".dibs-sync.json";
const REQUEST_TIMEOUT_MS = 8_000;
const PUSH_DEBOUNCE_MS = 400;

export type DibsEndpoint = { baseUrl: string; token: string };

export type DibsSyncConfig = {
  /** Current endpoint, or null when signed out. Called before every request. */
  endpoint: () => DibsEndpoint | null;
  fetchImpl?: typeof fetch;
  log?: (level: "info" | "warn", message: string) => void;
  now?: () => Date;
};

function cleanEndpoint(baseUrl: unknown, token: unknown): DibsEndpoint | null {
  const url = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
  const secret = typeof token === "string" ? token.trim() : "";
  return url && secret ? { baseUrl: url, token: secret } : null;
}

export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): DibsEndpoint | null {
  return cleanEndpoint(env.HERMES_DIBS_URL, env.HERMES_DIBS_TOKEN);
}

/** The extension id PI-Desktop keys host-provided config by. */
export const DESKTOP_EXTENSION_ID = "pi.hermes-memory";

type DesktopHost = { getConfig?: (extensionId: string) => Record<string, unknown> | undefined };

/**
 * Endpoint provider for this process: PI-Desktop's host module when present
 * (loaded once, read per call), otherwise the environment.
 */
export async function createEndpointProvider(env: NodeJS.ProcessEnv = process.env): Promise<() => DibsEndpoint | null> {
  // PI-Desktop publishes its extension host on a global symbol (its loader
  // maps only static imports, and a static import would fail everywhere else).
  const host = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-desktop.extension-host")] as DesktopHost | undefined;
  return () => {
    const config = host?.getConfig?.(DESKTOP_EXTENSION_ID);
    return (config ? cleanEndpoint(config.baseUrl, config.token) : null) ?? endpointFromEnv(env);
  };
}

type ServerEntry = {
  id: number | string;
  scope: SyncScope;
  target: Target;
  content: string;
  status?: string;
  createdAt?: string | number;
};

type SyncState = {
  scope: SyncScope;
  repoKey: string | null;
  /** target → dibs id → entry text as last synced */
  known: Partial<Record<Target, Record<string, string>>>;
  /** Text dibs refused (e.g. secret detected); not re-posted until it changes. */
  rejected?: string[];
};

class DibsHttpError extends Error {
  readonly status: number;
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

/** Entry text without the `<!-- created=…, last=… -->` metadata comment. */
export function entryText(raw: string): string {
  const match = raw.match(/^(.*?)\s*<!--\s*created=[^,]+,\s*last=[^,>]+(?:,\s*project64=[A-Za-z0-9_-]+)?\s*-->\s*$/s);
  return (match ? match[1] : raw).trim();
}

function day(value: string | number | undefined, fallback: Date): string {
  const date = value === undefined ? fallback : new Date(value);
  return (Number.isNaN(date.getTime()) ? fallback : date).toISOString().slice(0, 10);
}

async function readEntries(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim() ? content.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeEntries(filePath: string, entries: string[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.dibs-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temp, entries.length ? `${entries.join(ENTRY_DELIMITER)}\n` : "", "utf8");
  await fs.rename(temp, filePath);
}

export class DibsMemorySync {
  private readonly config: DibsSyncConfig;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; scope: SyncScope; repoKey: string | null }>();
  private readonly unlinked = new Set<string>();

  constructor(config: DibsSyncConfig) {
    this.config = config;
  }

  private get fetch(): typeof fetch {
    return this.config.fetchImpl ?? fetch;
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  /** Whether a request could be made right now. */
  get enabled(): boolean {
    return this.config.endpoint() !== null;
  }

  private async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const endpoint = this.config.endpoint();
    if (!endpoint) throw new DibsHttpError(0, "NOT_CONFIGURED", "dibs is not configured");
    const res = await this.fetch(`${endpoint.baseUrl}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new DibsHttpError(res.status, String(json.errorCode ?? ""), String(json.error ?? `HTTP ${res.status}`));
    }
    return json as T;
  }

  private async readState(storeDir: string, scope: SyncScope, repoKey: string | null): Promise<SyncState> {
    try {
      const state = JSON.parse(await fs.readFile(path.join(storeDir, STATE_FILE), "utf8")) as SyncState;
      // A store re-bound to another scope or repository starts its mapping over.
      if (state.scope === scope && state.repoKey === repoKey && state.known) return state;
    } catch {
      // Missing or unreadable: start fresh.
    }
    return { scope, repoKey, known: {} };
  }

  private async writeState(storeDir: string, state: SyncState): Promise<void> {
    await fs.mkdir(storeDir, { recursive: true });
    const file = path.join(storeDir, STATE_FILE);
    const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
  }

  /** Bring one store and dibs in step. Serialized per store directory. */
  reconcile(storeDir: string, scope: SyncScope, repoKey: string | null = null): Promise<void> {
    const key = path.resolve(storeDir);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.reconcileNow(key, scope, repoKey));
    this.queues.set(key, run);
    return run.finally(() => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    });
  }

  /** Debounced reconcile after a local mutation; never throws. */
  schedule(storeDir: string, scope: SyncScope, repoKey: string | null = null): void {
    const key = path.resolve(storeDir);
    clearTimeout(this.timers.get(key)?.timer);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.runLogged(key, scope, repoKey);
    }, PUSH_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(key, { timer, scope, repoKey });
  }

  private runLogged(storeDir: string, scope: SyncScope, repoKey: string | null): void {
    this.reconcile(storeDir, scope, repoKey).catch((error) =>
      this.config.log?.("warn", `dibs sync failed for ${scope} memory: ${String(error)}`),
    );
  }

  /** Run scheduled pushes now and wait for every sync in flight, up to `timeoutMs`. */
  async flush(timeoutMs = 3_000): Promise<void> {
    for (const [key, pending] of this.timers) {
      clearTimeout(pending.timer);
      this.timers.delete(key);
      this.runLogged(key, pending.scope, pending.repoKey);
    }
    const pending = [...this.queues.values()].map((run) => run.catch(() => undefined));
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  private async reconcileNow(storeDir: string, scope: SyncScope, repoKey: string | null): Promise<void> {
    if (scope === "project" && !repoKey) return;
    if (!this.enabled) return;
    const query = scope === "project" ? `?repoKey=${encodeURIComponent(repoKey!)}` : "";
    const remote = await this.request<{ project?: { id: number | string } | null; entries?: ServerEntry[] }>(
      "GET",
      `/api/agent/memory${query}`,
    );
    const linked = scope === "user" || Boolean(remote.project);
    if (scope === "project") {
      if (!linked) {
        if (!this.unlinked.has(repoKey!)) {
          this.unlinked.add(repoKey!);
          this.config.log?.(
            "info",
            `Team memory is not shared: no dibs project lists repository ${repoKey}. Add this source address to the project in dibs.`,
          );
        }
        return;
      }
      this.unlinked.delete(repoKey!);
    }

    const state = await this.readState(storeDir, scope, repoKey);
    const rejected = new Set(state.rejected ?? []);
    const live = (remote.entries ?? []).filter(
      (entry) => entry.scope === scope && (entry.status ?? "active") === "active",
    );

    for (const target of SCOPE_TARGETS[scope]) {
      const filePath = path.join(storeDir, TARGET_FILES[target]);
      await withMarkdownMutationLock(filePath, async () => {
        const known = { ...(state.known[target] ?? {}) };
        const server = new Map(live.filter((entry) => entry.target === target).map((entry) => [String(entry.id), entry]));
        let entries = await readEntries(filePath);
        let changed = false;
        const texts = () => new Set(entries.map(entryText));

        // Gone on dibs: drop locally.
        for (const [id, text] of Object.entries(known)) {
          if (server.has(id)) continue;
          const before = entries.length;
          entries = entries.filter((entry) => entryText(entry) !== text);
          changed ||= entries.length !== before;
          delete known[id];
        }

        // New on dibs: add locally.
        for (const [id, entry] of server) {
          if (known[id] !== undefined) continue;
          const text = entry.content.trim();
          known[id] = text;
          if (!texts().has(text)) {
            const stamp = day(entry.createdAt, this.now());
            entries.push(`${text} <!-- created=${stamp}, last=${stamp} -->`);
            changed = true;
          }
        }

        // Removed locally: delete on dibs, or restore when dibs refuses.
        const local = texts();
        for (const [id, text] of Object.entries(known)) {
          if (local.has(text)) continue;
          try {
            await this.request("DELETE", `/api/agent/memory/${encodeURIComponent(id)}`);
            delete known[id];
          } catch (error) {
            if (error instanceof DibsHttpError && error.status === 404) {
              delete known[id];
            } else if (error instanceof DibsHttpError && error.status === 403) {
              const stamp = day(undefined, this.now());
              entries.push(`${text} <!-- created=${stamp}, last=${stamp} -->`);
              changed = true;
            } else {
              throw error;
            }
          }
        }

        // New locally: post to dibs.
        const knownTexts = new Set(Object.values(known));
        for (const text of texts()) {
          if (knownTexts.has(text) || rejected.has(text)) continue;
          try {
            const created = await this.request<ServerEntry>("POST", "/api/agent/memory", {
              scope,
              ...(scope === "project" ? { repoKey } : {}),
              target,
              content: text,
            });
            known[String(created.id)] = text;
            knownTexts.add(text);
          } catch (error) {
            if (error instanceof DibsHttpError && (error.status === 422 || error.status === 400)) {
              rejected.add(text);
              this.config.log?.("warn", `dibs refused a ${target} entry (${error.errorCode || error.status}); it stays local only.`);
            } else {
              throw error;
            }
          }
        }

        if (changed) await writeEntries(filePath, entries);
        state.known[target] = known;
      });
    }

    state.rejected = [...rejected];
    await this.writeState(storeDir, state);
  }
}
