// Scans the web client's source for the UI rules that class names and copy can break, which lint
// cannot see. The rules that imports can express are lint rules (vite.config.ts); what only a
// rendered page shows is checked by e2e/ui-rules.spec.ts. Each rule names itself when it fails.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

const webDir = path.join(import.meta.dirname, "../src/web");

interface Source {
  file: string;
  text: string;
}
interface Tag {
  file: string;
  line: number;
  name: string;
  // The opening tag's source, attributes included.
  source: string;
  // The file's text before and after the tag.
  before: string;
  after: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// Every web source file but the primitives under components/ui, which are where the patterns the
// rules forbid in call sites live.
const sources: Source[] = walk(webDir)
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => ({ file: path.relative(webDir, file), text: readFileSync(file, "utf8") }))
  .filter(({ file }) => !file.startsWith("components/ui/") && !file.startsWith("icons/"));

// The opening tags of the given components, read through nested braces and strings, so an arrow
// function's ">" in an attribute does not end one early.
function tagsNamed(names: RegExp): Tag[] {
  const found: Tag[] = [];
  for (const { file, text } of sources) {
    const start = new RegExp(`<(${names.source})(?=[\\s/>])`, "g");
    for (let match = start.exec(text); match; match = start.exec(text)) {
      let depth = 0;
      let quote = "";
      let end = match.index;
      for (; end < text.length; end++) {
        const char = text[end]!;
        if (quote) {
          if (char === quote && text[end - 1] !== "\\") quote = "";
        } else if (depth === 0 && (char === '"' || char === "'")) quote = char;
        else if (char === "`") quote = char;
        else if (char === "{") depth++;
        else if (char === "}") depth--;
        else if (char === ">" && depth === 0) break;
      }
      found.push({
        file,
        line: text.slice(0, match.index).split("\n").length,
        name: match[1]!,
        source: text.slice(match.index, end + 1),
        before: text.slice(0, match.index),
        after: text.slice(end + 1),
      });
    }
  }
  return found;
}

// Fails on a hit that is not allowed, and on an allowed entry that no longer matches anything, so
// the allow-list holds only real exceptions, each with its reason.
function report(rule: string, hits: string[], allowed: Record<string, string> = {}) {
  const remaining = hits.filter((hit) => !Object.keys(allowed).some((key) => hit.startsWith(key)));
  expect(remaining, `${rule}\n${remaining.join("\n")}`).toEqual([]);
  const stale = Object.keys(allowed).filter((key) => !hits.some((hit) => hit.startsWith(key)));
  expect(stale, `${rule}\nAllowed but no longer found:\n${stale.join("\n")}`).toEqual([]);
}
const at = (tag: Pick<Tag, "file" | "line">) => `${tag.file}:${tag.line}`;
const classOf = (tag: Tag) => /className=(?:"([^"]*)"|\{([\s\S]*)\})/.exec(tag.source)?.[0] ?? "";

const MENU_ITEMS = /DropdownMenuItem|DropdownMenuSubTrigger|ComboboxItem|CommandItem|Item/;

describe("the UI rules", () => {
  it("Layout: highlights never bleed past their container (no negative horizontal margins)", () => {
    const hits = sources.flatMap(({ file, text }) =>
      text
        .split("\n")
        .flatMap((line, index) =>
          /(?<![\w-])-m[xlr]-(?:\d|\[|px)/.test(line)
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    report("Layout: padding goes inside rows; highlights never bleed past their container.", hits, {
      "shell/page-header.tsx":
        "The sidebar trigger's glyph, not its padding, lines up with the page's edge.",
    });
  });

  it("Structure: no padding patches on menu or list items in call sites", () => {
    const hits = tagsNamed(MENU_ITEMS)
      .filter((tag) => /(?<![\w:-])p[xytblr]?-\d/.test(classOf(tag)))
      .map((tag) => `${at(tag)}: ${tag.name} ${classOf(tag)}`);
    report("Structure: one shared component per job; no padding patches in call sites.", hits, {
      "models/host-grid.tsx": "A bordered tile in a grid of cards, not a row in a list.",
    });
  });

  it("Layout: controls in a row share one height (no size=sm on selects, inputs or filters)", () => {
    const hits = tagsNamed(
      /SelectTrigger|Input|InputGroup|InputGroupInput|ComboboxInput|FilterInput/,
    )
      .filter((tag) => /size="sm"/.test(tag.source))
      .map((tag) => `${at(tag)}: ${tag.name}`);
    report("Layout: controls in a row share one height (h-8); no sm beside default.", hits, {
      "components/data-table/data-table-pagination.tsx":
        "The footer row is small throughout: its select and icon buttons share one height.",
    });
  });

  it("Antipattern: no w-fit triggers", () => {
    const hits = tagsNamed(
      /SelectTrigger|ComboboxTrigger|DropdownMenuTrigger|PopoverTrigger|DialogTrigger/,
    )
      .filter((tag) => /(?<![\w-])w-fit/.test(classOf(tag)))
      .map((tag) => `${at(tag)}: ${tag.name}`);
    report("Antipattern: w-fit triggers; give the trigger a fixed width or let it fill.", hits, {});
  });

  it("Antipattern: no muted text on an enabled menu item", () => {
    const hits = tagsNamed(MENU_ITEMS)
      .filter((tag) => /text-muted-foreground/.test(classOf(tag)) && !/disabled/.test(tag.source))
      .map((tag) => `${at(tag)}: ${tag.name}`);
    report("Antipattern: muted text on an enabled item.", hits, {});
  });

  it("Content: no trailing ellipsis on actions, labels or placeholders", () => {
    const ellipsis = /(?:…|\.\.\.)$/;
    const attributes = sources.flatMap(({ file, text }) =>
      text
        .split("\n")
        .flatMap((line, index) =>
          /(?:placeholder|aria-label|label|title)="[^"]*(?:…|\.\.\.)"/.test(line)
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    // Static text opening a button or an item; a status shown while working ("Saving…") is a
    // different thing and keeps its ellipsis.
    const children = tagsNamed(/Button|DropdownMenuItem|DropdownMenuSubTrigger|DropdownMenuLabel/)
      .filter((tag) => ellipsis.test(/^[^<{]*/.exec(tag.after)?.[0].trim() ?? ""))
      .map((tag) => `${at(tag)}: ${tag.name} text ends in an ellipsis`);
    report('Content: terse copy; no "…" on actions, labels or placeholders.', [
      ...attributes,
      ...children,
    ]);
  });

  it("Controls: icon-only buttons are named and carry a tooltip", () => {
    const iconOnly = tagsNamed(/Button/).filter((tag) => /size="icon/.test(tag.source));
    const unnamed = iconOnly
      .filter((tag) => !/aria-label=|\{\.\.\./.test(tag.source))
      .map((tag) => `${at(tag)}: no aria-label`);
    const untipped = iconOnly
      .filter((tag) => {
        const opened = (tag.before.match(/<(WithTooltip|Tooltip)\b/g) ?? []).length;
        const closed = (tag.before.match(/<\/(WithTooltip|Tooltip)>/g) ?? []).length;
        return opened - closed <= 0;
      })
      .map((tag) => `${at(tag)}: not in a tooltip`);
    report(
      "Controls: secondary actions are icon buttons with tooltips.",
      [...unnamed, ...untipped],
      {},
    );
  });

  it("Structure: a copy field is CopyField, a read-only input beside a copy button", () => {
    const hits = tagsNamed(/Input|InputGroupInput/)
      .filter((tag) => /\sreadOnly(?=[\s=/>])/.test(tag.source))
      .map((tag) => `${at(tag)}: read-only ${tag.name}`);
    report("Structure: one shared component per job; use CopyField for a copyable value.", hits, {
      "components/copy-button.tsx": "CopyField is the shared component.",
    });
  });

  it("Structure: a role or access choice is AccessLevel, not a select", () => {
    const hits = tagsNamed(/Select/)
      .filter((tag) => /\brole/i.test(tag.source))
      .map((tag) => `${at(tag)}: ${tag.source.replace(/\s+/g, " ")}`);
    report("Structure: role and access choices go through AccessLevel (a toggle group).", hits, {});
  });

  it("Structure: a list's filter is FilterInput, not an input of its own", () => {
    const hits = tagsNamed(/Input|InputGroupInput/)
      .filter((tag) => /placeholder=\{?"(?:Search|Filter|Find)\b/.test(tag.source))
      .map((tag) => `${at(tag)}: ${tag.name}`);
    report("Structure: one shared component per job; filter lists with FilterInput.", hits);
  });
});
