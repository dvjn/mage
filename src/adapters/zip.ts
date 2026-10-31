// Reads a zip archive's text files, with the same caps as a repository: how much it unpacks to, how
// many entries it has, the largest file kept and the most files kept. Folders, files that are not
// text, the resource forks macOS adds, and paths that climb out of the archive are left out.

import { unzipSync } from "fflate";

import { ArchiveError, type ArchiveReader } from "@/ports/skills.ts";

import { textOf } from "./text.ts";

export interface ZipReaderOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

const MB = 1024 * 1024;
const TOO_LARGE = "This file is too large";
const SKIPPED = new Set(["__MACOSX", "node_modules", ".git"]);

// Whether the entry is a file worth reading: no folder, no climbing out, nothing skipped.
function readable(name: string) {
  if (name.endsWith("/") || name.startsWith("/") || name.includes("\\")) return false;
  const parts = name.split("/");
  return !parts.some((part) => part === ".." || SKIPPED.has(part)) && parts.at(-1) !== ".DS_Store";
}

export function createZipReader(options: ZipReaderOptions = {}): ArchiveReader {
  const maxBytes = options.maxBytes ?? 50 * MB;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  const maxFiles = options.maxFiles ?? 2000;

  return {
    files(data) {
      let entries = 0;
      let bytes = 0;
      let kept = 0;
      let unpacked: Record<string, Uint8Array>;
      try {
        unpacked = unzipSync(data, {
          filter(file) {
            entries += 1;
            if (entries > maxEntries) throw new ArchiveError("too_large", TOO_LARGE);
            if (!readable(file.name) || file.originalSize > maxFileBytes) return false;
            bytes += file.originalSize;
            kept += 1;
            if (bytes > maxBytes) throw new ArchiveError("too_large", TOO_LARGE);
            if (kept > maxFiles)
              throw new ArchiveError("too_large", "This file has too many files");
            return true;
          },
        });
      } catch (err) {
        if (err instanceof ArchiveError) throw err;
        throw new ArchiveError("invalid", "This file isn't a zip archive");
      }
      return Object.entries(unpacked)
        .map(([path, content]) => ({ path, text: textOf(content) }))
        .filter((file): file is { path: string; text: string } => file.text !== null)
        .sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
