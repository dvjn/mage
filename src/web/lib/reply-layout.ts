// The layouts the agent may write in its replies, in OpenUI Lang: each component's name, what it is
// for and the arguments it takes in order, without how it looks; whether a finished layout gives
// anything to draw and what in it could not be; and the message a click in one sends.

import {
  type ActionEvent,
  action,
  createLibrary,
  createParser,
  defineComponent,
} from "@openuidev/lang-core";
import * as z from "zod";

const Text = defineComponent({
  name: "Text",
  description: "A paragraph of plain text.",
  props: z.object({ text: z.string() }),
  component: null,
});

const Stat = defineComponent({
  name: "Stat",
  description: "One figure with its label and an optional change, such as +4%.",
  props: z.object({ label: z.string(), value: z.string(), change: z.string().optional() }),
  component: null,
});

const Table = defineComponent({
  name: "Table",
  description: "Column headings, then rows of cells as text.",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  component: null,
});

const List = defineComponent({
  name: "List",
  description: "Short items, bulleted, or numbered when ordered.",
  props: z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
  component: null,
});

const Bars = defineComponent({
  name: "Bars",
  description: "Numbers compared as horizontal bars, each with its label.",
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    unit: z.string().optional(),
  }),
  component: null,
});

const Button = defineComponent({
  name: "Button",
  description:
    'Sends its label, or the message of its action, e.g. @ToAssistant("Show March"), as the person who clicks.',
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(["default", "outline"]).optional(),
  }),
  component: null,
});

const Input = defineComponent({
  name: "Input",
  description: "A line of text to fill in, named by what it asks for.",
  props: z.object({ name: z.string(), placeholder: z.string().optional() }),
  component: null,
});

const Select = defineComponent({
  name: "Select",
  description: "One of a few options to pick, named by what it asks for.",
  props: z.object({ name: z.string(), options: z.array(z.string()) }),
  component: null,
});

const Form = defineComponent({
  name: "Form",
  description: "Fields to fill in, and buttons that send their message with the values.",
  props: z.object({
    name: z.string(),
    fields: z.array(z.union([Input.ref, Select.ref])),
    buttons: z.array(Button.ref),
  }),
  component: null,
});

const Row = defineComponent({
  name: "Row",
  description: "Figures, buttons or text side by side, wrapping on narrow screens.",
  props: z.object({ children: z.array(z.union([Stat.ref, Button.ref, Text.ref])) }),
  component: null,
});

const INSIDE = [Text, Stat, Row, Table, List, Bars, Button, Form];

const Card = defineComponent({
  name: "Card",
  description: "A titled card holding other components in a column.",
  props: z.object({
    title: z.string(),
    children: z.array(z.union(INSIDE.map((component) => component.ref))),
  }),
  component: null,
});

const Stack = defineComponent({
  name: "Stack",
  description: "The root: components in a column.",
  props: z.object({
    children: z.array(z.union([Card.ref, ...INSIDE.map((component) => component.ref)])),
  }),
  component: null,
});

export const LAYOUT_COMPONENTS = [
  Stack,
  Card,
  Row,
  Text,
  Stat,
  Table,
  List,
  Bars,
  Button,
  Form,
  Input,
  Select,
];

export const LAYOUT_ROOT = "Stack";

const library = createLibrary({ components: LAYOUT_COMPONENTS, root: LAYOUT_ROOT });

const parser = createParser(library.toJSONSchema(), LAYOUT_ROOT);

// What a finished layout comes to: whether it gives anything to draw, and what in it cannot be.
export function outcomeOf(source: string): { drawn: boolean; problems: string[] } {
  const result = parser.parse(source);
  const problems = [
    ...result.meta.errors.map((error) => error.message),
    ...result.meta.unresolved.map((name) => `${name} is not defined`),
  ];
  return { drawn: result.root !== null, problems };
}

// The message a click sends: the button's words, then the form's values quoted under them as a
// list; none for a link or anything else.
export function messageOf(
  event: Pick<ActionEvent, "type" | "humanFriendlyMessage" | "formState" | "formName">,
) {
  if (event.type !== "continue_conversation") return null;
  const said = event.humanFriendlyMessage.trim();
  const state = event.formState ?? {};
  const form = (event.formName && state[event.formName]) ?? state;
  const values = Object.entries(form as Record<string, unknown>).flatMap(([name, field]) => {
    if (name.startsWith("$")) return [];
    const value: unknown =
      field && typeof field === "object" && "value" in field ? field.value : field;
    const shown = (Array.isArray(value) ? value : [value])
      .filter((item) => ["string", "number", "boolean"].includes(typeof item))
      .map((item) => String(item as string).trim())
      .filter(Boolean)
      .join(", ");
    return shown ? [`> - ${name}: ${shown}`] : [];
  });
  const text = [said, ...values].filter(Boolean).join("\n");
  return text || null;
}
