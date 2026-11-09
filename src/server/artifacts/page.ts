// An artifact's page as it is served: the document shell Mage wraps it in, the name its title gives
// it, find-and-replace edits on it, the files it may carry, and the policy its origin serves it
// under.

import type { ArtifactTheme } from "@/shared/artifacts.ts";

// How much of the page is read for its title.
const TITLE_SCAN = 8 * 1024;
export const TITLE_MAX = 200;
export const UNTITLED = "Untitled";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decoded(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : +name.slice(1);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// The page's name: its first `<title>` near its start, or Untitled.
export function titleOf(html: string) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, TITLE_SCAN));
  const title = decoded(match?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return title.slice(0, TITLE_MAX) || UNTITLED;
}

export interface Edit {
  old: string;
  new: string;
}

// The page with each edit applied in turn, or what stopped one: each old text must occur exactly
// once in the page as the edits before it left it.
export function applyEdits(
  html: string,
  edits: readonly Edit[],
): { ok: true; html: string } | { ok: false; error: string } {
  let page = html;
  for (const [index, edit] of edits.entries()) {
    const at = page.indexOf(edit.old);
    const which = `Edit ${index + 1} of ${edits.length}`;
    if (edit.old === "" || at < 0) {
      return { ok: false, error: `${which}: its old text is not in the page. No edit was made.` };
    }
    if (page.indexOf(edit.old, at + 1) >= 0) {
      return {
        ok: false,
        error: `${which}: its old text occurs more than once; give more of the text around it. No edit was made.`,
      };
    }
    page = page.slice(0, at) + edit.new + page.slice(at + edit.old.length);
  }
  return { ok: true, html: page };
}

// The reset every page starts from.
const RESET = [
  ":root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}",
  "body{margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
  "img{max-width:100%}",
  "[hidden]{display:none!important}",
].join("");

// The page in Mage's shell: doctype, charset, viewport and the reset, with the theme on its root.
// A page written as a whole document has its doctype dropped; the parser folds its own html,
// head and body tags into the shell's.
export function shellOf(html: string, theme: ArtifactTheme | null) {
  const page = html.replace(/^\s*<!doctype[^>]*>/i, "");
  const root = theme ? `<html lang="en" data-theme="${theme}">` : `<html lang="en">`;
  return (
    `<!doctype html>${root}<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<style>${RESET}</style></head><body>${page}</body></html>`
  );
}

// Where a page may load scripts, styles and fonts from; everything else it loads is its own.
export const SCRIPT_SOURCES = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net/npm/",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
];
export const STYLE_SOURCES = ["https://fonts.googleapis.com"];
export const FONT_SOURCES = ["https://fonts.gstatic.com"];

// The policy a page and its files are served under. No service worker may be registered from its
// origin. Scripts and styles may be inline. It may be
// framed only by the app. As a sandbox it may run scripts and open links in new windows, but not
// show dialogs, print, download or navigate the window that frames it.
export function contentPolicy(appOrigin: string) {
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${SCRIPT_SOURCES.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${STYLE_SOURCES.join(" ")}`,
    `font-src 'self' data: ${FONT_SOURCES.join(" ")}`,
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src blob:",
    "manifest-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${appOrigin}`,
    "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
  ].join("; ");
}

// The files a page may carry, by the type they are served as, and the most each may weigh.
export const ASSET_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "application/pdf",
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "application/json",
  "text/csv",
] as const;

export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PAGE_MAX_BYTES = 1024 * 1024;
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const ASSETS_MAX_BYTES = 20 * 1024 * 1024;
export const ASSETS_MAX = 50;
