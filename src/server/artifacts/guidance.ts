// What the agent is told about artifacts while their toolset is on: when to make one, and the
// contract every page is served under.

import { FONT_SOURCES, SCRIPT_SOURCES, STYLE_SOURCES } from "./page.ts";

export const ARTIFACT_GUIDANCE = `Publish an artifact when a page will be clearer than a reply, or people will use it rather than read it: an interactive tool, a dashboard, a report to share. Artifacts belong to the space and are shared with its members by default; any thread there may update one, and artifact.list with scope space shows them all. Update one rather than publishing anew; use edits for small changes and pass basedOn. In a thread with guests, only artifacts shared with them can be listed, read or updated; publishing shares the new one with them. End a reply that published or updated a page with its Artifact(id) card in a \`ui\` block, not buttons.

Page contract:
- Write the page's content: the server adds the doctype, charset, viewport (viewport-fit=cover) and a reset (body margin 0, 14px system font, img max-width 100%, [hidden] hides). Start with a <title> of two to four words; it names the artifact. Give a one-sentence description and a one-word generic icon.
- Scripts only from ${SCRIPT_SOURCES.join(", ")}, each at an exact version (react@18.3.1, never react or react@18). Stylesheets only from ${STYLE_SOURCES.join(", ")}, fonts from ${FONT_SOURCES.join(", ")}. Inline scripts and styles are fine. Images, media and fetch reach only the artifact's own files (by relative name), data: and blob:.
- Theme: define colours as custom properties on :root, give body an explicit background, and redefine them for dark under @media (prefers-color-scheme: dark) guarded by :root:not([data-theme="light"]), and again under :root[data-theme="dark"]. The viewer sets data-theme.
- Work at phone width with a 16px side gutter and no horizontal scroll.
- The page runs in a sandboxed frame: no alert, confirm or prompt; no print; no embedded sites or frames; no plain-link downloads; no forms posting elsewhere; clipboard writes only inside a click handler.
- Load the page-design skill before publishing a page, and diagrams or charts too when the page has them.
- Preview after publishing when the tool is offered, and fix what it reports.`;
