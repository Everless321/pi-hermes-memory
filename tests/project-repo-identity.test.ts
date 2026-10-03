import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_ROOT } from "../src/paths.js";
import { detectProject, repositoryProjectName } from "../src/project.js";

function repoWithOrigin(root: string, url: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
}

describe("repository-keyed project identity", () => {
  let tmp: string;
  let storeDir: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-repo-")));
    storeDir = `test-projects-${process.pid}-${Date.now()}`;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(AGENT_ROOT, storeDir), { recursive: true, force: true });
  });

  it("keys same-named checkouts of different repositories apart, and clones of one repository together", () => {
    const a = path.join(tmp, "one", "api");
    const b = path.join(tmp, "two", "api");
    const aClone = path.join(tmp, "elsewhere", "renamed");
    repoWithOrigin(a, "git@gitea.corp:team/api.git");
    repoWithOrigin(b, "git@gitea.corp:other/api.git");
    repoWithOrigin(aClone, "https://gitea.corp/Team/API");

    const pa = detectProject(storeDir, a);
    const pb = detectProject(storeDir, b);
    const pc = detectProject(storeDir, aClone);
    assert.equal(pa.repo?.key, "git:gitea.corp/team/api");
    assert.match(pa.name ?? "", /^api-[0-9a-f]{8}$/);
    assert.notEqual(pa.name, pb.name);
    assert.equal(pc.name, pa.name);
    assert.equal(pc.memoryDir, pa.memoryDir);
  });

  it("adopts the store an earlier release wrote under the folder name", () => {
    const repo = path.join(tmp, "api");
    repoWithOrigin(repo, "https://gitea.corp/team/api.git");
    const legacy = path.join(AGENT_ROOT, storeDir, "api");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "MEMORY.md"), "legacy entry");

    const project = detectProject(storeDir, repo);
    assert.equal(project.name, repositoryProjectName(project.repo!));
    assert.equal(fs.readFileSync(path.join(project.memoryDir!, "MEMORY.md"), "utf8"), "legacy entry");
    assert.equal(fs.existsSync(legacy), false);
  });

  it("keeps folder-name identity, without a repo, for directories with no remote", () => {
    const plain = path.join(tmp, "notes");
    fs.mkdirSync(plain);
    const project = detectProject(storeDir, plain);
    assert.equal(project.name, "notes");
    assert.equal(project.repo, null);
  });
});
