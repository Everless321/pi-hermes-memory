/**
 * Which repository a working directory belongs to: Git first, then SVN
 * (docs/company/repo-key.md, "Detection order"). Command-line clients are
 * preferred because they apply the user's own configuration (Git `insteadOf`
 * rewrites); without them the repository metadata is read directly.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { repoKey, type RepoKind } from "./repo-key.js";

export type RepositoryIdentity = {
  kind: RepoKind;
  /** The remote URL as configured, credentials removed. */
  url: string;
  key: string;
  /** Working-copy root on this machine. */
  root: string;
};

const COMMAND_TIMEOUT_MS = 3000;

export type VcsDetectionOptions = {
  /** Directory treated as "not a project" even when it is a repository root. */
  homeDir?: string;
  /** Set false to read metadata only (tests, hosts without a usable PATH). */
  useCommands?: boolean;
};

function stripCredentials(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

function runCommand(command: string, args: string[], cwd: string): string | null {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function findUp(start: string, marker: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, marker))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The shared git directory of a working copy, following linked worktrees. */
function commonGitDir(root: string): string | null {
  const dotGit = path.join(root, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!pointer) return null;
    const gitDir = path.resolve(root, pointer[1].trim());
    try {
      const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
      if (common) return path.resolve(gitDir, common);
    } catch {
      // Not a linked worktree.
    }
    return gitDir;
  } catch {
    return null;
  }
}

/** Remote URLs from a git config file, in file order. */
export function parseGitRemotes(config: string): Array<{ name: string; url: string }> {
  const remotes: Array<{ name: string; url: string }> = [];
  let current: string | null = null;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const url = current ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (url && current && !remotes.some((remote) => remote.name === current)) {
      remotes.push({ name: current, url: url[1].trim().replace(/^"(.*)"$/, "$1") });
    }
  }
  return remotes;
}

function gitRemoteUrl(root: string, useCommands: boolean): string | null {
  if (useCommands) {
    const names = runCommand("git", ["remote"], root)?.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    if (names && names.length > 0) {
      const name = names.includes("origin") ? "origin" : names[0];
      const url = runCommand("git", ["remote", "get-url", name], root);
      if (url) return url;
    }
  }
  const gitDir = commonGitDir(root);
  if (!gitDir) return null;
  try {
    const remotes = parseGitRemotes(fs.readFileSync(path.join(gitDir, "config"), "utf8"));
    return (remotes.find((remote) => remote.name === "origin") ?? remotes[0])?.url ?? null;
  } catch {
    return null;
  }
}

/** Repository URL of an SVN working-copy root, read from `.svn/wc.db`. */
export function svnUrlFromWcDb(root: string): string | null {
  const dbPath = path.join(root, ".svn", "wc.db");
  if (!fs.existsSync(dbPath)) return null;
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite");
  } catch {
    return null;
  }
  let db: InstanceType<typeof sqlite.DatabaseSync> | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT r.root AS root, n.repos_path AS reposPath
           FROM NODES n JOIN REPOSITORY r ON r.id = n.repos_id
          WHERE n.local_relpath = '' AND n.op_depth = 0
          LIMIT 1`,
      )
      .get() as { root?: unknown; reposPath?: unknown } | undefined;
    if (!row || typeof row.root !== "string") return null;
    const reposPath = typeof row.reposPath === "string" ? row.reposPath : "";
    return reposPath ? `${row.root.replace(/\/+$/, "")}/${reposPath.replace(/^\/+/, "")}` : row.root;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

function svnRootUrl(root: string, useCommands: boolean): string | null {
  if (useCommands) {
    const url = runCommand("svn", ["info", "--show-item", "url", "--no-newline", root], root);
    if (url) return url;
  }
  return svnUrlFromWcDb(root);
}

function identity(kind: RepoKind, rawUrl: string | null, root: string): RepositoryIdentity | null {
  if (!rawUrl) return null;
  const url = stripCredentials(rawUrl);
  const key = repoKey(kind, url);
  return key ? { kind, url, key, root } : null;
}

/** The repository `cwd` belongs to, or null for a local-only directory. */
export function detectRepository(cwd: string, options: VcsDetectionOptions = {}): RepositoryIdentity | null {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const useCommands = options.useCommands !== false;
  const usable = (root: string | null) => (root && path.resolve(root) !== home ? root : null);

  const gitRoot = usable(findUp(cwd, ".git"));
  if (gitRoot) {
    const found = identity("git", gitRemoteUrl(gitRoot, useCommands), gitRoot);
    if (found) return found;
  }
  const svnRoot = usable(findUp(cwd, ".svn"));
  if (svnRoot) return identity("svn", svnRootUrl(svnRoot, useCommands), svnRoot);
  return null;
}
