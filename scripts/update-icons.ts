// Writes the marks of the makers and hosts Mage knows from a pinned Lobe Icons release: each one's
// monochrome mark, and its colour mark where it has one, as the inside of an SVG with its view box
// where it is not the usual 24-unit square, into a module the web client imports. Checks the release against its published digest, and records it
// in the licence beside the marks.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { HOST_IDS, hostOf } from "../src/shared/hosts.ts";
import { MAKER_IDS, MAKERS } from "../src/shared/makers.ts";

// The release, its commit, and the digest npm publishes for its tarball.
const VERSION = "1.95.1";
const COMMIT = "49a2130df7bfa5eb1b088261bff20a37e2967789";
const INTEGRITY =
  "sha512-Hw7EPPgVnC4NZLXBfTNJG6hyQgqECfUPC11VVXodPSr1aebKcFxDZlSpxhWwYNdCc6bhxps/x5TtXoPmfKH2ag==";
const TARBALL = `https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-${VERSION}.tgz`;
const MODULE = path.join(import.meta.dirname, "../src/web/icons/marks.ts");
const LICENSE = path.join(import.meta.dirname, "../src/web/icons/LICENSE");

export interface Mark {
  viewBox?: string;
  mono: string;
  color?: string;
}

const SQUARE = "0 0 24 24";

// The files of a tar archive by path; only regular files.
export function untar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (type === "0" || type === "\0") {
      files.set(prefix ? `${prefix}/${name}` : name, archive.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

// The inside of an icon's SVG, without its title, in a group with the fill its root gave, and its
// view box.
export function innerSvg(svg: string): { viewBox: string; inner: string } {
  const open = /^<svg\b[^>]*>/.exec(svg.trim());
  const viewBox = open && /viewBox="([\d. -]+)"/.exec(open[0])?.[1];
  if (!open || !viewBox) throw new Error("The icon is not an SVG with a view box");
  const inner = svg
    .trim()
    .slice(open[0].length)
    .replace(/<\/svg>$/, "")
    .replace(/<title>[^<]*<\/title>/, "")
    .trim();
  const fills = [...open[0].matchAll(/ (fill|fill-rule)="([^"]*)"/g)].map((match) => match[0]);
  return { viewBox, inner: fills.length > 0 ? `<g${fills.join("")}>${inner}</g>` : inner };
}

// Every mark the makers and hosts name, each once.
export function markNames(): string[] {
  const names = [
    ...MAKER_IDS.map((maker) => MAKERS[maker].mark),
    ...HOST_IDS.map((host) => hostOf(host).mark),
  ].filter((name): name is string => !!name);
  return [...new Set(names)].toSorted();
}

// The marks named, from the release's files.
export function marksFrom(files: Map<string, Buffer>, names: string[]): Record<string, Mark> {
  const marks: Record<string, Mark> = {};
  for (const name of names) {
    const mono = files.get(`package/icons/${name}.svg`);
    if (!mono) throw new Error(`The release has no mark called ${name}`);
    const color = files.get(`package/icons/${name}-color.svg`);
    const { viewBox, inner } = innerSvg(mono.toString("utf8"));
    const colored = color && innerSvg(color.toString("utf8"));
    if (colored && colored.viewBox !== viewBox) {
      throw new Error(`The ${name} marks are drawn on different view boxes`);
    }
    marks[name] = {
      ...(viewBox !== SQUARE && { viewBox }),
      mono: inner,
      ...(colored && { color: colored.inner }),
    };
  }
  return marks;
}

// The module the web client imports, laid out as the formatter would.
export function marksModule(marks: Record<string, Mark>): string {
  const key = (name: string) => (/^[a-z_$][\w$]*$/i.test(name) ? name : JSON.stringify(name));
  const entries = Object.keys(marks)
    .toSorted()
    .map((name) => {
      const { viewBox, mono, color } = marks[name]!;
      const lines = [`    mono: ${JSON.stringify(mono)},`];
      if (viewBox) lines.unshift(`    viewBox: ${JSON.stringify(viewBox)},`);
      if (color) lines.push(`    color: ${JSON.stringify(color)},`);
      return `  ${key(name)}: {\n${lines.join("\n")}\n  },`;
    });
  return [
    "// The marks of the makers and hosts Mage knows, from Lobe Icons (see the licence beside it):",
    "// each one's monochrome mark, drawn in the current colour, and its colour mark where it has one,",
    "// as the inside of an SVG, with its view box where it is not the usual 24-unit square. Written by",
    "// the icon update task; not edited by hand.",
    "",
    "export const MARKS: Record<string, { viewBox?: string; mono: string; color?: string }> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

// The licence with the release's version, commit, digest and the day it was read.
export function stampLicense(license: string, sha256: string, retrieved: string) {
  return license
    .replace(/^Upstream version: .*$/m, `Upstream version: ${VERSION}`)
    .replace(/^Upstream commit:  .*$/m, `Upstream commit:  ${COMMIT}`)
    .replace(/^Upstream sha256:  .*$/m, `Upstream sha256:  ${sha256}`)
    .replace(/^Retrieved:        .*$/m, `Retrieved:        ${retrieved}`);
}

async function main() {
  const res = await fetch(TARBALL);
  if (!res.ok) throw new Error(`Downloading the icons failed: ${res.status}`);
  const tarball = Buffer.from(await res.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== INTEGRITY) throw new Error("The icons do not match their published digest");
  const marks = marksFrom(untar(gunzipSync(tarball)), markNames());
  writeFileSync(MODULE, marksModule(marks));
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(LICENSE, stampLicense(readFileSync(LICENSE, "utf8"), sha256, today));
  console.log(`Marks: ${Object.keys(marks).length}`);
}

if (import.meta.main) await main();
