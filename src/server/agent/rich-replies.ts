// Mage's built-in Rich replies: no tools, only what the agent is always told, which is how to lay
// out cards, figures, tables, lists, bars, buttons and forms in a `ui` block in its reply. Clicks
// in a layout only post messages, so it is always on and needs no tool policy.

import type { Toolset } from "./tools.ts";

export const RICH_REPLIES_TOOLSET = "replies";

export const RICH_REPLIES_GUIDANCE = `Rich replies: show, don't just tell. Whenever a reply carries figures, a comparison, a ranking, a status across several items, or choices for the reader, lay it out in a fenced block whose language is \`ui\`, with a sentence or two of your words outside it. Prefer a table to a list of similar items, Stat for headline figures, Bars for numbers compared, and Buttons for the next steps the reader is likely to want. Keep prose for reasoning and short answers. The block is drawn with built-in components.

How to write it:
- One statement per line: \`name = Component(arg, ...)\`. Arguments are positional, in the order below; leave optional ones (marked ?) off the end. Strings use double quotes.
- Start with \`root = Stack([...])\`, then define each name you used, parents before children. Every name must be reachable from root.
- Components:
  Stack(children) - the root: a column
  Card(title, children)
  Row(children) - Stat, Button or Text side by side
  Text(text)
  Stat(label, value, change?) - one figure, e.g. Stat("Revenue", "$1.2M", "+4%")
  Table(columns, rows) - rows are arrays of strings
  List(items, ordered?)
  Bars(labels, values, unit?) - numbers compared as bars
  Button(label, action?) - sends its label, or @ToAssistant("message"), as a message from whoever clicks
  Form(name, fields, buttons) - fields are Input(name, placeholder?) and Select(name, options); a button in it sends its message with the values filled in
- Buttons and forms only send messages to you; nothing else happens on a click.

Example:
\`\`\`ui
root = Stack([summary, regions, next])
summary = Card("Q3", [figures])
figures = Row([revenue, churn])
revenue = Stat("Revenue", "$1.2M", "+4%")
churn = Stat("Churn", "2.1%", "-0.3pt")
regions = Bars(["EU", "US"], [400, 800], "k$")
next = Button("Show March", @ToAssistant("Show March in detail"))
\`\`\``;

export function createRichReplies(): Toolset {
  return {
    id: RICH_REPLIES_TOOLSET,
    title: "Rich replies",
    description: "Cards, tables and buttons in the agent's replies",
    source: "builtin",
    tools: [],
    guidance: RICH_REPLIES_GUIDANCE,
    fixed: true,
  };
}
