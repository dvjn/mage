// Reads git repositories over HTTP(S): the commit a branch or tag points to, and a shallow clone's
// text files at it, kept in a temporary folder only while they are read. Downloads, entries and
// files are capped, and files that are not text are left out. A token goes as basic
// authorization, as GitHub and GitLab take one.

import { mkdtemp, rm } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clone,
  currentBranch,
  Errors,
  type GitAuth,
  type HttpClient,
  listServerRefs,
  resolveRef,
  TREE,
  walk,
} from "isomorphic-git";

import { GitError, type GitReader, type GitTarget } from "@/ports/skills.ts";

import { textOf } from "./text.ts";

export interface GitReaderOptions {
  fetch?: typeof fetch;
  // The most a clone downloads, the most entries its tree may have, the largest file kept and
  // the most files kept.
  maxBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

const MB = 1024 * 1024;
const TOO_LARGE = "This repository is too large";
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);

async function collect(body: AsyncIterableIterator<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// An HTTP client for the git library over `fetch` for one read, failing once what it received
// passes the cap, and noting so, as the library reports its own error in place of ours.
function httpClient(send: typeof fetch, maxBytes: number) {
  const state = { tooLarge: false };
  let received = 0;
  const client: HttpClient = {
    async request({ url, method = "GET", headers = {}, body }) {
      const payload = body ? await collect(body) : undefined;
      const res = await send(url, { method, headers, body: payload, redirect: "follow" });
      async function* chunks() {
        if (!res.body) return;
        for await (const chunk of res.body) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            state.tooLarge = true;
            throw new GitError("too_large", TOO_LARGE);
          }
          yield chunk;
        }
      }
      return {
        url: res.url || url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: Object.fromEntries(res.headers),
        body: chunks(),
      };
    },
  };
  return { client, state };
}

function authOf(token: string | null) {
  return (): GitAuth =>
    token ? { username: "x-access-token", password: token } : { cancel: true };
}

// What went wrong reading a repository, in words people can act on.
function failureOf(err: unknown, target: GitTarget, tooLarge: boolean): GitError {
  if (tooLarge) return new GitError("too_large", TOO_LARGE);
  if (err instanceof GitError) return err;
  if (err instanceof Errors.UserCanceledError) {
    return new GitError("auth", "This repository needs a token");
  }
  if (err instanceof Errors.HttpError) {
    const status = err.data.statusCode;
    if (status === 401 || status === 403) {
      return new GitError(
        "auth",
        target.token ? "The token can't read this repository" : "This repository needs a token",
      );
    }
    if (status === 404) {
      return new GitError(
        "not_found",
        target.token
          ? "Couldn't find this repository"
          : "Couldn't find this repository. If it's private, add a token.",
      );
    }
    return new GitError("unreachable", `The server answered ${status}`);
  }
  if (err instanceof Errors.NotFoundError) {
    return new GitError("not_found", `No branch or tag named ${target.ref ?? "HEAD"}`);
  }
  if (err instanceof Errors.SmartHttpError) {
    return new GitError("unreachable", "This address didn't answer as a git repository");
  }
  return new GitError("unreachable", "Couldn't reach this repository");
}

export function createGitReader(options: GitReaderOptions = {}): GitReader {
  const send = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 50 * MB;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  const maxFiles = options.maxFiles ?? 2000;

  return {
    async head(target) {
      const { client: http, state } = httpClient(send, maxBytes);
      try {
        const refs = await listServerRefs({
          http,
          url: target.url,
          onAuth: authOf(target.token),
          symrefs: true,
          peelTags: true,
        });
        const wanted = target.ref
          ? [`refs/heads/${target.ref}`, `refs/tags/${target.ref}`]
          : ["HEAD"];
        for (const name of wanted) {
          const ref = refs.find((candidate) => candidate.ref === name);
          if (ref) return ref.peeled ?? ref.oid;
        }
        throw new GitError("not_found", `No branch or tag named ${target.ref ?? "HEAD"}`);
      } catch (err) {
        throw failureOf(err, target, state.tooLarge);
      }
    },

    async snapshot(target, subpath) {
      const { client: http, state } = httpClient(send, maxBytes);
      const dir = await mkdtemp(join(tmpdir(), "mage-git-"));
      try {
        await clone({
          fs,
          http,
          dir,
          url: target.url,
          ...(target.ref && { ref: target.ref }),
          singleBranch: true,
          depth: 1,
          noCheckout: true,
          noTags: true,
          onAuth: authOf(target.token),
        });
        const commit = await resolveRef({ fs, dir, ref: "HEAD" });
        const ref = (await currentBranch({ fs, dir })) ?? target.ref;
        const base = subpath ? `${subpath.replace(/^\/+|\/+$/g, "")}/` : "";
        let entries = 0;
        const files: { path: string; text: string }[] = [];
        await walk({
          fs,
          dir,
          trees: [TREE({ ref: commit })],
          map: async (path, [entry]) => {
            if (path === "." || !entry) return true;
            entries += 1;
            if (entries > maxEntries) throw new GitError("too_large", TOO_LARGE);
            const name = path.slice(path.lastIndexOf("/") + 1);
            const type = await entry.type();
            if (type === "tree") {
              if (SKIPPED_FOLDERS.has(name)) return null;
              // Only the folders on the way to the subpath, and those in it.
              const inside = `${path}/`.startsWith(base) || base.startsWith(`${path}/`);
              return inside ? true : null;
            }
            if (type !== "blob" || !`${path}`.startsWith(base)) return undefined;
            if ((await entry.mode()) === 0o120000) return undefined;
            const bytes = await entry.content();
            if (!bytes || bytes.byteLength > maxFileBytes) return undefined;
            const text = textOf(bytes);
            if (text === null) return undefined;
            files.push({ path: path.slice(base.length), text });
            if (files.length > maxFiles)
              throw new GitError("too_large", "This repository has too many files");
            return undefined;
          },
        });
        if (base && !files.length) {
          throw new GitError("not_found", `No folder named ${subpath} in this repository`);
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { commit, ref, files };
      } catch (err) {
        throw failureOf(err, target, state.tooLarge);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
