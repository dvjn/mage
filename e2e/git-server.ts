// A stand-in git host for the browser journeys and the tests, as people's skills repositories live
// on one: bare repositories in a folder of its own, served over smart HTTP by git itself. Those
// under private/ answer only with the token below. It starts with a few repositories of skills:
// acme/agent-skills with skills in skills/ and .claude/skills/, acme/single with one at its root,
// acme/no-skills with none, and private/team-skills behind the token.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";

export const GIT_TOKEN = "git-journey-token";

const AUTHOR = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...AUTHOR },
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

function skill(name: string, description: string, body: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

// The repositories it starts with, by path, each a map of files.
export const FIXTURES: Record<string, Record<string, string>> = {
  "acme/agent-skills": {
    "README.md": "# Acme agent skills\n",
    "skills/release-notes/SKILL.md": skill(
      "release-notes",
      "Write release notes from merged changes",
      "# Release notes\n\nGroup the changes by area and lead with what people notice.",
    ),
    "skills/release-notes/templates/notes.md": "## What's new\n\n- \n",
    "skills/code-review/SKILL.md": skill(
      "code-review",
      "Review a change for correctness first, then style",
      "# Code review\n\nRead the whole change before commenting.",
    ),
    "skills/code-review/scripts/check.sh": "#!/bin/sh\necho checking\n",
    ".claude/skills/haiku/SKILL.md": skill(
      "haiku",
      "Answer in a haiku when asked for one",
      "Write three lines of five, seven and five syllables.",
    ),
  },
  "acme/single": {
    "SKILL.md": skill("pirate", "Talk like a pirate", "Arr. Say arr often."),
  },
  "acme/no-skills": { "README.md": "Nothing here\n" },
  "private/team-skills": {
    "skills/standup/SKILL.md": skill(
      "standup",
      "Summarise a standup",
      "Yesterday, today, blockers.",
    ),
  },
};

// Commits the changes to the bare repository: each file written, or removed when null.
export function commitTo(root: string, repo: string, changes: Record<string, string | null>) {
  const work = mkdtempSync(path.join(tmpdir(), "mage-git-work-"));
  try {
    const bare = path.join(root, `${repo}.git`);
    git(work, "clone", "-q", bare, ".");
    for (const [file, text] of Object.entries(changes)) {
      const at = path.join(work, file);
      if (text === null) rmSync(at, { force: true });
      else {
        mkdirSync(path.dirname(at), { recursive: true });
        writeFileSync(at, text);
      }
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Change skills");
    git(work, "push", "-q", "origin", "HEAD");
    return git(work, "rev-parse", "HEAD");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Makes a bare repository with the files on its main branch.
export function createRepo(root: string, repo: string, files: Record<string, string>) {
  const bare = path.join(root, `${repo}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(bare, "config", "http.receivepack", "false");
  const work = mkdtempSync(path.join(tmpdir(), "mage-git-work-"));
  try {
    git(work, "init", "-q", "-b", "main");
    for (const [file, text] of Object.entries(files)) {
      const at = path.join(work, file);
      mkdirSync(path.dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Add skills");
    git(work, "push", "-q", bare, "main");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// A folder of bare repositories made from the fixtures.
export function createFixtures(root = mkdtempSync(path.join(tmpdir(), "mage-git-"))) {
  for (const [repo, files] of Object.entries(FIXTURES)) createRepo(root, repo, files);
  return root;
}

function allowed(req: Request, repoPath: string) {
  if (!repoPath.startsWith("/private/")) return true;
  const header = req.headers.get("authorization") ?? "";
  const [, encoded] = /^Basic (.+)$/.exec(header) ?? [];
  if (!encoded) return false;
  const [, password] = Buffer.from(encoded, "base64").toString().split(":");
  return password === GIT_TOKEN;
}

// Answers git's smart HTTP requests for the repositories in `root`, through git http-backend.
export function gitStandIn(root: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!allowed(req, url.pathname)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="git"' },
      });
    }
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : Buffer.alloc(0);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stdin.end(body);
    await new Promise((resolve) => child.on("close", resolve));
    const all = Buffer.concat(out);
    const split = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, split).toString();
    const headers = new Headers();
    let status = 200;
    for (const line of head.split("\r\n")) {
      const at = line.indexOf(":");
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else if (name) headers.append(name, value);
    }
    return new Response(all.subarray(split + 4), { status, headers });
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? "4790");
  const root = createFixtures();
  // Its repositories go with it.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      rmSync(root, { recursive: true, force: true });
      process.exit(0);
    });
  }
  serve({ fetch: gitStandIn(root), port });
}
