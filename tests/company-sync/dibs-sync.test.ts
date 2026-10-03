import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DibsMemorySync, createEndpointProvider, entryText } from "../../src/company-sync/dibs-sync.js";

const REPO = "git:gitea.corp/team/api";
type Entry = { id: number; scope: "project" | "user"; target: string; content: string; status: string; owner: string; createdAt: string };

/** An in-memory dibs speaking the /api/agent/memory contract. */
function fakeDibs(options: { linked?: boolean; me?: string } = {}) {
  const me = options.me ?? "pi-test";
  const entries: Entry[] = [];
  const calls: string[] = [];
  let nextId = 1;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer dibs_test");
    if (method === "GET") {
      const repoKey = url.searchParams.get("repoKey");
      const project = repoKey === REPO && options.linked !== false ? { id: 7, name: "api" } : null;
      const visible = entries.filter((e) => e.status !== "deleted" && (e.scope === "user" ? e.owner === me : Boolean(project)));
      return json({ project, entries: visible, deletedIds: [] });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.content.includes("sk-SECRET")) return json({ error: "secret", errorCode: "SECRET_DETECTED" }, 422);
      if (body.scope === "project" && (body.repoKey !== REPO || options.linked === false)) {
        return json({ error: "not linked", errorCode: "PROJECT_NOT_LINKED" }, 404);
      }
      const entry: Entry = { id: nextId++, scope: body.scope, target: body.target, content: body.content, status: "active", owner: me, createdAt: "2026-10-01T00:00:00Z" };
      entries.push(entry);
      return json(entry, 201);
    }
    if (method === "DELETE") {
      const entry = entries.find((e) => e.id === Number(url.pathname.split("/").pop()));
      if (!entry) return json({ error: "gone", errorCode: "NOT_FOUND" }, 404);
      if (entry.owner !== me) return json({ error: "forbidden", errorCode: "FORBIDDEN" }, 403);
      entry.status = "deleted";
      return json({ ok: true });
    }
    return json({}, 405);
  }) as typeof fetch;
  const add = (partial: Partial<Entry> & Pick<Entry, "content">) => {
    const entry: Entry = { id: nextId++, scope: "project", target: "memory", status: "active", owner: "someone-else", createdAt: "2026-09-30T00:00:00Z", ...partial };
    entries.push(entry);
    return entry;
  };
  return { fetchImpl, entries, calls, add };
}

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n§\n").map((e) => entryText(e)).filter(Boolean) : []);
const write = (file: string, texts: string[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, texts.join("\n§\n"));
};

describe("DibsMemorySync", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-sync-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sync = (dibs: ReturnType<typeof fakeDibs>) =>
    new DibsMemorySync({ endpoint: () => ({ baseUrl: "http://dibs.test", token: "dibs_test" }), fetchImpl: dibs.fetchImpl, now: () => new Date("2026-10-03T00:00:00Z") });

  it("pulls team entries, pushes local ones once, and stays quiet when nothing changed", async () => {
    const dibs = fakeDibs();
    dibs.add({ content: "Use pnpm, not npm." });
    dibs.add({ content: "Tests need a running redis.", target: "failure" });
    write(path.join(dir, "MEMORY.md"), ["Deploy with conduit."]);

    await sync(dibs).reconcile(dir, "project", REPO);
    assert.deepEqual(read(path.join(dir, "MEMORY.md")).sort(), ["Deploy with conduit.", "Use pnpm, not npm."]);
    assert.deepEqual(read(path.join(dir, "failures.md")), ["Tests need a running redis."]);
    assert.ok(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8").includes("<!-- created=2026-09-30, last=2026-09-30 -->"));
    assert.equal(dibs.entries.filter((e) => e.content === "Deploy with conduit.").length, 1);

    const before = dibs.calls.length;
    await sync(dibs).reconcile(dir, "project", REPO);
    assert.deepEqual(dibs.calls.slice(before), ["GET /api/agent/memory"], "a second run only reads");
  });

  it("drops entries deleted or flagged on dibs", async () => {
    const dibs = fakeDibs();
    const keep = dibs.add({ content: "keep" });
    const gone = dibs.add({ content: "deleted later" });
    const wrong = dibs.add({ content: "flagged later" });
    await sync(dibs).reconcile(dir, "project", REPO);
    gone.status = "deleted";
    wrong.status = "flagged";
    await sync(dibs).reconcile(dir, "project", REPO);
    assert.deepEqual(read(path.join(dir, "MEMORY.md")), [keep.content]);
  });

  it("deletes the user's own entry on dibs, and restores someone else's", async () => {
    const dibs = fakeDibs();
    const theirs = dibs.add({ content: "their entry" });
    write(path.join(dir, "MEMORY.md"), ["my entry"]);
    await sync(dibs).reconcile(dir, "project", REPO);
    write(path.join(dir, "MEMORY.md"), []);
    await sync(dibs).reconcile(dir, "project", REPO);
    assert.equal(dibs.entries.find((e) => e.content === "my entry")?.status, "deleted");
    assert.equal(theirs.status, "active");
    assert.deepEqual(read(path.join(dir, "MEMORY.md")), ["their entry"], "dibs refused, so the entry comes back");
  });

  it("does nothing for a repository no dibs project lists", async () => {
    const dibs = fakeDibs({ linked: false });
    write(path.join(dir, "MEMORY.md"), ["local only"]);
    await sync(dibs).reconcile(dir, "project", REPO);
    assert.deepEqual(dibs.calls, ["GET /api/agent/memory"]);
    assert.equal(fs.existsSync(path.join(dir, ".dibs-sync.json")), false);
  });

  it("keeps refused text local without re-posting it", async () => {
    const dibs = fakeDibs();
    write(path.join(dir, "MEMORY.md"), ["token is sk-SECRET123"]);
    await sync(dibs).reconcile(dir, "project", REPO);
    await sync(dibs).reconcile(dir, "project", REPO);
    assert.equal(dibs.calls.filter((c) => c.startsWith("POST")).length, 1);
    assert.deepEqual(read(path.join(dir, "MEMORY.md")), ["token is sk-SECRET123"]);
  });

  it("syncs personal memory, including the user profile, as the user scope", async () => {
    const dibs = fakeDibs();
    dibs.add({ scope: "user", target: "user", content: "Prefers Chinese replies.", owner: "pi-test" });
    dibs.add({ scope: "user", target: "user", content: "not mine", owner: "other" });
    write(path.join(dir, "MEMORY.md"), ["global note"]);
    await sync(dibs).reconcile(dir, "user");
    assert.deepEqual(read(path.join(dir, "USER.md")), ["Prefers Chinese replies."]);
    assert.equal(dibs.entries.find((e) => e.content === "global note")?.scope, "user");
  });

  it("debounces pushes after mutations and flushes them on shutdown", async () => {
    const dibs = fakeDibs();
    const s = sync(dibs);
    write(path.join(dir, "MEMORY.md"), ["a"]);
    s.schedule(dir, "project", REPO);
    write(path.join(dir, "MEMORY.md"), ["a", "b"]);
    s.schedule(dir, "project", REPO);
    await s.flush(2000);
    assert.deepEqual(dibs.entries.map((e) => e.content).sort(), ["a", "b"]);
    assert.equal(dibs.calls.filter((c) => c.startsWith("GET")).length, 1, "two schedules, one reconcile");
  });
});

describe("endpoint resolution", () => {
  it("is read per request, and nothing syncs while signed out", async () => {
    const dibs = fakeDibs();
    let endpoint: { baseUrl: string; token: string } | null = null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dibs-sync-late-"));
    try {
      const s = new DibsMemorySync({ endpoint: () => endpoint, fetchImpl: dibs.fetchImpl });
      write(path.join(dir, "MEMORY.md"), ["late"]);
      await s.reconcile(dir, "project", REPO);
      assert.equal(dibs.calls.length, 0);
      endpoint = { baseUrl: "http://dibs.test", token: "dibs_test" };
      await s.reconcile(dir, "project", REPO);
      assert.deepEqual(dibs.entries.map((e) => e.content), ["late"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the environment outside PI-Desktop", async () => {
    const read = await createEndpointProvider({ HERMES_DIBS_URL: "http://dibs.test/", HERMES_DIBS_TOKEN: " dibs_x " });
    assert.deepEqual(read(), { baseUrl: "http://dibs.test", token: "dibs_x" });
    assert.equal((await createEndpointProvider({}))(), null);
  });
});
