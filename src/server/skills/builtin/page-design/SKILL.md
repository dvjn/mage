---
name: page-design
description: Design guidance for any page published as an artifact, from register and themes to phone layout and copy. Load it before publishing a page.
---

# Designing a page

You publish the body of a page. The server wraps it in the document shell, and the viewer sets `data-theme` to `light`, `dark` or nothing (follow the system). Everything below is about making that body good.

## Read the request first

Decide the register before choosing anything visual.

- Utilitarian: a plan, memo, report, checklist, calculator, internal tool. Be calm and legible. Spend effort on structure and clarity, not decoration.
- Editorial: a landing page, a game, a portfolio, something to keep or show off. Here a point of view is expected.

A polished plain page is always acceptable. Over-design is not: if a styling choice does not help the reader, drop it. If the user names a design system, brand or existing look, follow it and skip the rest of the aesthetic advice. Plain pages use the house style below.

## Ground it in its subject

- Include at least one detail only this subject would have: its real vocabulary, a figure from the user's data, a diagram of how the thing works, a unit it is measured in.
- Use real content. No lorem ipsum, no "Feature One", no invented testimonials. If you lack a fact, ask or leave the section out.
- Structure that encodes nothing is noise. Number steps only if order matters; use small eyebrow labels only if they name a real category.

## House style

The default for plain pages (reports, dashboards, plans, tools, memos) when the user gives no design direction and names no brand. Editorial and branded pages design their own.

```css
:root {
  color-scheme: light;
  --bg: #fbfcfd;
  --surface: #f3f5f8;
  --border: #e1e5eb;
  --fg: #14181f;
  --muted: #5b6472;
  --accent: #0e7c86;
  --good: #1f8a5b;
  --warn: #b7791f;
  --bad: #c2452d;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0f1217;
    --surface: #171b22;
    --border: #262c36;
    --fg: #e8ebf0;
    --muted: #9aa3b0;
    --accent: #4cc3cc;
    --good: #4cc98f;
    --warn: #e8b04b;
    --bad: #f07a62;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1217;
  --surface: #171b22;
  --border: #262c36;
  --fg: #e8ebf0;
  --muted: #9aa3b0;
  --accent: #4cc3cc;
  --good: #4cc98f;
  --warn: #e8b04b;
  --bad: #f07a62;
}
```

Fonts: Geist for headings and body, Geist Mono for figures and code.

```html
<link
  href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap"
  rel="stylesheet"
/>
```

Fall back to `system-ui, sans-serif` and `ui-monospace, monospace`. Chart colours continue from the accent: see the charts skill.

## Plan before you build

For a plain page, the house style is the plan. Otherwise write the token plan first and make it the top of your stylesheet:

1. Four to six colours: background, surface, text, muted text, one accent, plus semantic colours (success, warning, danger) only if the page needs them.
2. At least two type roles: a display face for headings and a body face. Load from Google Fonts and always give a real fallback stack (`Georgia, serif`, `system-ui, sans-serif`).
3. One line describing the layout idea.

Then build only from those tokens. Do not add a colour or size you did not plan.

## Tokens and themes

Every colour is a custom property. This block shows the theme shape with placeholder values; for plain pages use the house style values.

```css
:root {
  color-scheme: light;
  --bg: #f7f6f3;
  --surface: #ffffff;
  --text: #1f2328;
  --muted: #5d6670;
  --accent: #2457c5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #15171a;
    --surface: #1d2024;
    --text: #e8eaed;
    --muted: #9aa3ad;
    --accent: #7ea6ff;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #15171a;
  --surface: #1d2024;
  --text: #e8eaed;
  --muted: #9aa3ad;
  --accent: #7ea6ff;
}
body {
  background: var(--bg);
  color: var(--text);
}
```

- The light values live on bare `:root`; dark is written twice, as above, with the same values.
- Give `body` an explicit background.
- Pick neutrals deliberately with a slight hue bias (warm or cool) rather than pure grey; pick the dark accent by eye, not by inverting.
- Check contrast for text and for the accent as a text colour in both themes.

## Type

- A scale with a clear ratio (for example 14, 16, 20, 25, 32, 40), used consistently.
- Lines of about 65 characters: cap prose with `max-width: 65ch`.
- Headings use `text-wrap: balance`; long body text may use `text-wrap: pretty`.
- Body line height 1.5 to 1.7, headings tighter.

## Layout

- Use flex or grid with `gap`; avoid margin hacks.
- Side gutter of 16px, respecting the notch: `padding-inline: max(16px, env(safe-area-inset-left))` and the right equivalent.
- Stack columns at about 400px. Nothing may be wider than the screen except tables, code and diagrams, each inside its own `overflow-x: auto` wrapper.
- Repeated elements (cards, rows, list items) look identical in spacing, radius and type.
- Cards are for things that are items in a set or that can be acted on. Do not wrap every section in one.
- Charts and diagrams are drawn to scale; never let a decorative shape imply a quantity.

## Complete at rest

- Nothing is hidden until scrolled or hovered; no entrance animations that leave content invisible.
- A hero is sized to its content, not a full-viewport block with one line in it.
- A tool opens with example data, clearly marked as an example, so the page is never empty.

## Avoid the usual tells

On editorial pages, these combinations read as generated. Do not use them by default:

- Cream background, serif headings and a terracotta accent.
- Near-black background with a single acid-green or neon accent.
- A purple-to-blue gradient hero.
- The same sans-serif everywhere, especially one font at every size.
- Emoji as section markers.
- Everything centred.
- Uniform rounded cards with a soft shadow around every block.

## Build cleanly

- Visible keyboard focus on every interactive element (`:focus-visible` with a clear outline).
- Respect `prefers-reduced-motion`: remove or shorten transitions and animation under it.
- Labels tied to inputs, with stable `id`s so state survives edits.
- Buttons are `<button>`, links are `<a>`; targets at least 40px tall on phones.

## Copy

- Write from the reader's side: what they can do or learn, not what the page contains.
- Active voice, plain words. Errors say what went wrong and what to do next.
- The `<title>` is a name of two to four words. Put the explanation in the description, not the title.

## Dashboards and tools

- Summary before detail: the answer first, the breakdown below.
- Show state in form as well as number (a bar, a label, an icon), never colour alone.
- Keep semantic colours (good, bad, warning) separate from the accent colour.

## Process

1. Settle the token plan and write it as the `:root` block.
2. Build the whole page from it.
3. Preview once at most, fix everything found in one pass, then publish.

## When the request is editorial

Take one real aesthetic risk and keep it to one place: an unusual typeface, an oversized number, an asymmetric layout, an unexpected palette. Everything else stays disciplined so the risk reads as intent. Use motion deliberately, for one meaningful moment, not on everything.

## Frame limits to remember

- Scripts only from the allowed CDN list, each at an exact version; styles only from Google Fonts.
- No `alert`, `confirm`, `prompt`; no printing; no embedded sites or frames; no plain-link downloads; no forms posting elsewhere; clipboard writes only inside a click handler; no service workers.
