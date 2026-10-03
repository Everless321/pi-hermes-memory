import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { repoKey, type RepoKind } from "../src/repo-key.js";

const vectors = JSON.parse(
  fs.readFileSync(new URL("./fixtures/repo-keys.json", import.meta.url), "utf8"),
) as Array<{ kind: RepoKind; url: string; key: string | null }>;

describe("repoKey conformance (docs/company/repo-key.md)", () => {
  for (const vector of vectors) {
    it(`${vector.kind} ${JSON.stringify(vector.url)} → ${vector.key}`, () => {
      assert.equal(repoKey(vector.kind, vector.url), vector.key);
    });
  }
});
