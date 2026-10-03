/**
 * Project detection — determines whether the current working directory
 * represents a project and resolves its name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { resolveProjectsRoot } from "./paths.js";
import { detectRepository, type RepositoryIdentity } from "./vcs-identity.js";

export interface ProjectInfo {
  /** Project name (directory basename), or null if not in a project. */
  name: string | null;
  /** Path to the project-scoped memory directory, or null. */
  memoryDir: string | null;
  /** The source repository this project is keyed by, when it has a remote. */
  repo?: RepositoryIdentity | null;
}

export interface ProjectSkillInfo extends ProjectInfo {
  /** Path to the project-scoped skills directory, or null. */
  skillsDir: string | null;
}

/**
 * Resolve the repository root shared by every linked worktree of `dir`'s repo.
 *
 * Mirrors what `git rev-parse --git-common-dir` reports, without spawning git:
 * a linked worktree's `.git` is a file pointing at
 * `<main>/.git/worktrees/<name>`, and that directory carries a `commondir`
 * file pointing back at the shared `<main>/.git`. Returns null outside a
 * repository, or for a bare/detached layout with no obvious working root.
 */
function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);

  while (true) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }

    if (stat?.isDirectory()) return current;

    if (stat?.isFile()) {
      const commonDir = resolveWorktreeCommonDir(current, dotGit);
      if (!commonDir) return current;
      return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorktreeCommonDir(worktreeRoot: string, dotGitFile: string): string | null {
  let pointer: string;
  try {
    pointer = fs.readFileSync(dotGitFile, "utf-8");
  } catch {
    return null;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;

  const gitDir = path.resolve(worktreeRoot, match[1].trim());
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch {
    // Not a linked worktree, or an older layout without `commondir`.
  }

  // `<main>/.git/worktrees/<name>` — two levels up is the shared git dir.
  const parent = path.dirname(gitDir);
  return path.basename(parent) === "worktrees" ? path.dirname(parent) : null;
}

const repoRootCache = new Map<string, string | null>();
const repositoryCache = new Map<string, RepositoryIdentity | null>();

function cachedRepository(dir: string, homeDir: string): RepositoryIdentity | null {
  if (!repositoryCache.has(dir)) repositoryCache.set(dir, detectRepository(dir, { homeDir }));
  return repositoryCache.get(dir) ?? null;
}

/**
 * Local directory name for a repository-keyed project: the repository's last
 * path segment, made filesystem-safe, plus a short hash of the repo key so two
 * repositories with the same name never share a store.
 */
export function repositoryProjectName(repo: RepositoryIdentity): string {
  const lastSegment = repo.key.slice(repo.key.lastIndexOf("/") + 1);
  const readable = lastSegment.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "repo";
  return `${readable}-${createHash("sha256").update(repo.key).digest("hex").slice(0, 8)}`;
}

/**
 * Carry a store written under the folder-name identity of earlier releases
 * over to the repository identity, once, so upgrading never orphans memory.
 */
function adoptLegacyProjectStore(projectsRoot: string, legacyName: string, name: string): void {
  const target = path.join(projectsRoot, name);
  const legacy = path.join(projectsRoot, legacyName);
  if (legacyName === name || fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    fs.renameSync(legacy, target);
  } catch {
    // Another process adopted it first, or the rename is not possible; the
    // repository store simply starts empty.
  }
}

/**
 * Detect project from the current working directory.
 *
 * A "project" is any directory that is not the user's home directory. Inside a
 * Git repository the project name is the *repository* root's basename, so every
 * linked worktree shares one identity instead of stranding its memory and
 * skills under the worktree directory name (#120). Outside Git it stays the
 * working directory's basename.
 *
 * An existing `projects-memory/<cwd-basename>/` directory still wins over a
 * newly derived repository name, so upgrading never orphans memory that was
 * written under the old cwd-basename identity.
 *
 * Project-scoped memory is stored at ~/.pi/agent/<projectsMemoryDir>/<projectName>/.
 */
export function detectProject(projectsMemoryDir = "projects-memory", cwd?: string): ProjectInfo {
  const dir = cwd ?? process.cwd();
  const homeDir = os.homedir();

  // Normalize paths for comparison
  const resolved = path.resolve(dir);
  const resolvedHome = path.resolve(homeDir);

  if (resolved === resolvedHome || resolved === "/" || !resolved || resolved === resolvedHome + "/") {
    return { name: null, memoryDir: null };
  }

  const cwdName = path.basename(resolved);
  if (!cwdName || cwdName === "." || cwdName === "..") {
    return { name: null, memoryDir: null };
  }

  const projectsRoot = resolveProjectsRoot(projectsMemoryDir);
  const repo = cachedRepository(resolved, resolvedHome);
  if (repo) {
    const name = repositoryProjectName(repo);
    adoptLegacyProjectStore(projectsRoot, path.basename(repo.root), name);
    return { name, memoryDir: path.join(projectsRoot, name), repo };
  }
  const name = resolveProjectName(resolved, resolvedHome, cwdName, projectsRoot);

  return {
    name,
    memoryDir: path.join(projectsRoot, name),
    repo: null,
  };
}

function resolveProjectName(
  resolved: string,
  resolvedHome: string,
  cwdName: string,
  projectsRoot: string,
): string {
  let repoRoot = repoRootCache.get(resolved);
  if (repoRoot === undefined) {
    repoRoot = findGitRepoRoot(resolved);
    repoRootCache.set(resolved, repoRoot);
  }

  if (!repoRoot || repoRoot === resolved || repoRoot === resolvedHome) return cwdName;

  const repoName = path.basename(repoRoot);
  if (!repoName || repoName === cwdName) return cwdName;

  // Migration bridge: a store already written under the old cwd-basename
  // identity keeps working. Only fresh directories adopt the repository name.
  if (!fs.existsSync(path.join(projectsRoot, repoName)) && fs.existsSync(path.join(projectsRoot, cwdName))) {
    return cwdName;
  }

  return repoName;
}

export function detectProjectSkills(projectsMemoryDir = "projects-memory", cwd?: string): ProjectSkillInfo {
  const project = detectProject(projectsMemoryDir, cwd);
  return {
    ...project,
    skillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
  };
}
