import { rmSync } from "node:fs";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { GitError, createGitReader } from "./git.ts";
import {
  commitTo,
  createFixtures,
  createRepo,
  GIT_TOKEN,
  gitStandIn,
} from "../../../e2e/git-server.ts";

const ORIGIN = "http://git.test";
const root = createFixtures();
const handle = gitStandIn(root);
// Only the stand-in answers; nothing goes over the network.
const local = (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin !== ORIGIN) {
    return Promise.reject(new TypeError("fetch failed"));
  }
  return handle(request);
};
const reader = createGitReader({ fetch: local as typeof fetch });

afterAll(() => rmSync(root, { recursive: true, force: true }));

function target(repo: string, token: string | null = null, ref: string | null = null) {
  return { url: `${ORIGIN}/${repo}.git`, ref, token };
}

async function failure(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(GitError);
  return err as GitError;
}

describe("the git reader", () => {
  it("reads a repository's text files at its default branch, and the commit", async () => {
    const snapshot = await reader.snapshot(target("acme/agent-skills"), null);
    expect(snapshot.ref).toBe("main");
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".claude/skills/haiku/SKILL.md",
      "README.md",
      "skills/code-review/scripts/check.sh",
      "skills/code-review/SKILL.md",
      "skills/release-notes/SKILL.md",
      "skills/release-notes/templates/notes.md",
    ]);
    expect(await reader.head(target("acme/agent-skills"))).toBe(snapshot.commit);
  });

  it("reads only the folder asked for, with paths from it", async () => {
    const snapshot = await reader.snapshot(target("acme/agent-skills"), "skills/release-notes");
    expect(snapshot.files.map((file) => file.path)).toEqual(["SKILL.md", "templates/notes.md"]);
    const missing = await failure(reader.snapshot(target("acme/agent-skills"), "nowhere"));
    expect(missing.kind).toBe("not_found");
  });

  it("follows new commits and reads a branch by name", async () => {
    const before = await reader.head(target("acme/single"));
    const after = commitTo(root, "acme/single", { "NOTES.md": "more\n" });
    expect(after).not.toBe(before);
    expect(await reader.head(target("acme/single"))).toBe(after);
    expect((await reader.snapshot(target("acme/single", null, "main"), null)).commit).toBe(after);
    const branch = await failure(reader.head(target("acme/single", null, "nope")));
    expect(branch.kind).toBe("not_found");
  });

  it("leaves out files that are not text or too large", async () => {
    createRepo(root, "acme/mixed", {
      "SKILL.md": "---\nname: mixed\ndescription: d\n---\n",
      "logo.bin": "\u0000\u0001\u0002",
      "big.md": "x".repeat(2048),
    });
    const small = createGitReader({ fetch: local as typeof fetch, maxFileBytes: 1024 });
    const snapshot = await small.snapshot(target("acme/mixed"), null);
    expect(snapshot.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("refuses a repository larger than its caps", async () => {
    const tiny = createGitReader({ fetch: local as typeof fetch, maxBytes: 200 });
    expect((await failure(tiny.snapshot(target("acme/agent-skills"), null))).kind).toBe(
      "too_large",
    );
    const few = createGitReader({ fetch: local as typeof fetch, maxFiles: 2 });
    expect((await failure(few.snapshot(target("acme/agent-skills"), null))).kind).toBe("too_large");
  });

  it("reads a private repository only with its token", async () => {
    const without = await failure(reader.snapshot(target("private/team-skills"), null));
    expect(without.kind).toBe("auth");
    expect(without.message).toBe("This repository needs a token");
    const wrong = await failure(reader.head(target("private/team-skills", "wrong")));
    expect(wrong.message).toBe("The token can't read this repository");
    const snapshot = await reader.snapshot(target("private/team-skills", GIT_TOKEN), null);
    expect(snapshot.files.map((file) => file.path)).toEqual(["skills/standup/SKILL.md"]);
  });

  it("says when a repository is missing or the host can't be reached", async () => {
    expect((await failure(reader.head(target("acme/missing")))).kind).toBe("not_found");
    const away = await failure(
      reader.head({ url: "http://elsewhere.test/a/b.git", ref: null, token: null }),
    );
    expect(away.kind).toBe("unreachable");
  });
});
