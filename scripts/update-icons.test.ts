import { gzipSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { innerSvg, markNames, marksFrom, marksModule, untar } from "./update-icons.ts";
import { HOST_IDS, hostOf } from "@/shared/hosts.ts";
import { MAKER_IDS, MAKERS } from "@/shared/makers.ts";

// A tar archive of the files given, as npm packs them.
function tar(files: Record<string, string>) {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const mono =
  '<svg fill="currentColor" fill-rule="evenodd" height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Groq</title><path d="M1 1h2"></path></svg>';
const color =
  '<svg height="1em" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Groq</title><path d="M1 1h2" fill="#F55036"></path></svg>';

describe("the vendored marks", () => {
  it("reads the files of the release's tarball", () => {
    const files = untar(
      gunzipSync(gzipSync(tar({ "package/icons/groq.svg": mono, "package/a": "" }))),
    );
    expect([...files.keys()]).toEqual(["package/icons/groq.svg", "package/a"]);
    expect(files.get("package/icons/groq.svg")?.toString()).toBe(mono);
  });

  it("keeps an icon's inside and its root's fill, without its title", () => {
    expect(innerSvg(mono)).toEqual({
      viewBox: "0 0 24 24",
      inner: '<g fill="currentColor" fill-rule="evenodd"><path d="M1 1h2"></path></g>',
    });
    expect(innerSvg(color).inner).toBe('<path d="M1 1h2" fill="#F55036"></path>');
    expect(() => innerSvg("<g></g>")).toThrow();
  });

  it("takes each mark's monochrome and colour icons, and a view box only when unusual", () => {
    const files = new Map([
      ["package/icons/groq.svg", Buffer.from(mono)],
      ["package/icons/nova.svg", Buffer.from(mono.replace("0 0 24 24", "0 0 33 32"))],
      ["package/icons/nova-color.svg", Buffer.from(color.replace("0 0 24 24", "0 0 33 32"))],
    ]);
    const marks = marksFrom(files, ["groq", "nova"]);
    expect(marks.groq).toEqual({ mono: expect.stringContaining("M1 1h2") });
    expect(marks.nova).toMatchObject({ viewBox: "0 0 33 32", color: expect.any(String) });
    expect(() => marksFrom(files, ["missing"])).toThrow(/missing/);
    expect(marksModule(marks)).toContain('  groq: {\n    mono: "<g fill=\\"currentColor\\"');
  });

  it("names every mark the makers and hosts use", () => {
    const names = markNames();
    for (const maker of MAKER_IDS) expect(names).toContain(MAKERS[maker].mark);
    for (const host of HOST_IDS) {
      const { mark } = hostOf(host);
      if (mark) expect(names).toContain(mark);
    }
  });
});
