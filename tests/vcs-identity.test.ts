import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { detectRepository, parseGitRemotes } from "../src/vcs-identity.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });

/** A minimal `.svn/wc.db` with the two tables detection reads. */
function fakeSvnWorkingCopy(root: string, repoRoot: string, reposPath: string): void {
  fs.mkdirSync(path.join(root, ".svn"), { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(root, ".svn", "wc.db"));
  db.exec(`CREATE TABLE REPOSITORY (id INTEGER PRIMARY KEY, root TEXT, uuid TEXT);
           CREATE TABLE NODES (wc_id INTEGER, local_relpath TEXT, op_depth INTEGER, repos_id INTEGER, repos_path TEXT);`);
  db.prepare("INSERT INTO REPOSITORY VALUES (1, ?, 'uuid-1')").run(repoRoot);
  db.prepare("INSERT INTO NODES VALUES (1, '', 0, 1, ?)").run(reposPath);
  db.prepare("INSERT INTO NODES VALUES (1, 'src', 0, 1, ?)").run(`${reposPath}/src`);
  db.close();
}

describe("detectRepository", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-identity-")));
    home = path.join(tmp, "home");
    fs.mkdirSync(home);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("keys a git working copy by origin, from any subdirectory", () => {
    const repo = path.join(tmp, "api");
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "remote", "add", "upstream", "https://gitea.corp/other/fork.git");
    git(repo, "remote", "add", "origin", "git@gitea.corp:Team/API.git");
    const found = detectRepository(path.join(repo, "src", "deep"), { homeDir: home });
    assert.deepEqual(found, { kind: "git", url: "git@gitea.corp:Team/API.git", key: "git:gitea.corp/team/api", root: repo });
  });

  it("reads .git/config when the git client is unavailable, and strips credentials", () => {
    const repo = path.join(tmp, "api");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"),
      '[core]\n\tbare = false\n[remote "mirror"]\n\turl = https://mirror/x.git\n[remote "origin"]\n\turl = https://bob:s3cret@gitea.corp/team/api.git\n');
    const found = detectRepository(repo, { homeDir: home, useCommands: false });
    assert.equal(found?.url, "https://gitea.corp/team/api.git");
    assert.equal(found?.key, "git:gitea.corp/team/api");
  });

  it("gives a linked worktree the identity of its main repository", () => {
    const repo = path.join(tmp, "api");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://gitea.corp/team/api.git");
    git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(tmp, "api-feature");
    git(repo, "worktree", "add", "-q", worktree);
    for (const useCommands of [true, false]) {
      assert.equal(detectRepository(worktree, { homeDir: home, useCommands })?.key, "git:gitea.corp/team/api");
    }
  });

  it("falls back to SVN and keys every line of development as one project", () => {
    const trunk = path.join(tmp, "proj-trunk");
    fs.mkdirSync(path.join(trunk, "src"), { recursive: true });
    fakeSvnWorkingCopy(trunk, "svn://svn.corp/repo", "proj/trunk");
    const branch = path.join(tmp, "proj-v2");
    fs.mkdirSync(branch);
    fakeSvnWorkingCopy(branch, "svn://svn.corp/repo", "proj/branches/v2");
    const fromTrunk = detectRepository(path.join(trunk, "src"), { homeDir: home, useCommands: false });
    assert.deepEqual(fromTrunk, { kind: "svn", url: "svn://svn.corp/repo/proj/trunk", key: "svn:svn.corp/repo/proj", root: trunk });
    assert.equal(detectRepository(branch, { homeDir: home, useCommands: false })?.key, "svn:svn.corp/repo/proj");
  });

  it("prefers git over svn in the same tree", () => {
    const repo = path.join(tmp, "both");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://gitea.corp/team/both.git\n');
    fakeSvnWorkingCopy(repo, "svn://svn.corp/repo", "both/trunk");
    assert.equal(detectRepository(repo, { homeDir: home, useCommands: false })?.kind, "git");
  });

  it("treats remote-less repositories, plain folders, and the home directory as local-only", () => {
    const local = path.join(tmp, "scratch");
    fs.mkdirSync(local);
    git(local, "init", "-q");
    assert.equal(detectRepository(local, { homeDir: home }), null);
    assert.equal(detectRepository(home, { homeDir: home }), null);
    fs.mkdirSync(path.join(home, ".git"));
    fs.writeFileSync(path.join(home, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/me/dotfiles.git\n');
    fs.mkdirSync(path.join(home, "notes"));
    assert.equal(detectRepository(path.join(home, "notes"), { homeDir: home, useCommands: false }), null);
  });
});

describe("parseGitRemotes", () => {
  it("keeps file order and the first url of each remote", () => {
    assert.deepEqual(
      parseGitRemotes('[remote "b"]\n url = u1\n url = u2\n[branch "main"]\n remote = b\n[remote "a"]\n\turl = "u3"\n'),
      [{ name: "b", url: "u1" }, { name: "a", url: "u3" }],
    );
  });
});
