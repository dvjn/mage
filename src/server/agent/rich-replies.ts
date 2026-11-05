// Mage's built-in Rich replies: no tools, only what the agent is always told, which is how to lay
// out cards, figures, tables, lists, bars, buttons and forms in a `ui` block in its reply. Clicks
// in a layout only post messages, so it is always on and needs no tool policy.

import type { Toolset } from "./tools.ts";

export const RICH_REPLIES_TOOLSET = "replies";

export const RICH_REPLIES_GUIDANCE = `Show, don't just tell. Whenever a reply has figures, a comparison, a ranking, status across several items, or choices for the reader, put them in a fenced \`ui\` block with a sentence or two of prose outside it. Prefer Table for similar items, Stat for headline figures, Bars for compared numbers, Buttons for likely next steps. Keep prose for reasoning and short answers.

Syntax: one \`name = Component(args)\` per line; arguments positional in the order below, optional (?) ones dropped from the end; strings in double quotes. Start with \`root = Stack([...])\`, then define every name used, parents before children, all reachable from root.
Stack(children) - a column
Card(title, children)
Row(children) - Stats, Buttons or Text side by side
Text(text)
Stat(label, value, change?)
Table(columns, rows) - rows are arrays of strings
List(items, ordered?)
Bars(labels, values, unit?)
Button(label, action?) - posts its label, or @ToAssistant("message"), as the clicker's message
Form(name, fields, buttons) - fields are Input(name, placeholder?) and Select(name, options); its buttons post their message with the values
Clicks only post messages to you.

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
