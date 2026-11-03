// A tool call's input and output as they show in a thread: the input as labelled fields, and the
// output by its shape, as a table, a tree, Markdown, MCP's content parts or why the call failed.
// Long lists, tables and texts show their start until opened, and what is folded away renders
// only once it opens.

import { cn } from "cn";
import { BracesIcon, ChevronRightIcon, LinkIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { JsonSchema } from "@/shared/tools.ts";
import {
  type Column,
  countOf,
  type Entry,
  entriesOf,
  isObject,
  layoutOf,
  type OutputLayout,
  outputLayoutOf,
  type PartLayout,
  type Scalar,
  type ValueLayout,
} from "@/web/agent/tool-layout";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { WithTooltip } from "@/web/components/with-tooltip";
import { Alert, AlertDescription } from "@/web/components/ui/alert";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";

// How many rows, entries or chips show before the rest are asked for.
const TABLE_ROWS = 10;
const TREE_ENTRIES = 50;
const CHIPS = 20;
// Text longer than this is cut to a few lines until opened.
const LONG_TEXT = 240;
// Markdown longer than this, in characters or lines, is cut to its start until opened.
const LONG_MARKDOWN = 400;
const MARKDOWN_LINES = 8;

// The first `cap` of a list, or all of it once asked, with the button that asks.
function useCapped<T>(items: T[], cap: number, more: (n: number) => string, less: string) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, cap);
  const toggle =
    items.length > cap ? (
      <Button size="xs" variant="link" className="h-auto p-0" onClick={() => setAll(!all)}>
        {all ? less : more(items.length)}
      </Button>
    ) : null;
  return [shown, toggle] as const;
}

function scalarText(value: Scalar) {
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function None() {
  return <span className="text-muted-foreground italic">none</span>;
}

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LONG_TEXT) {
    return <span className="break-words whitespace-pre-wrap text-foreground">{text}</span>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span
        className={cn("break-words whitespace-pre-wrap text-foreground", !open && "line-clamp-3")}
      >
        {text}
      </span>
      <Button size="xs" variant="link" className="h-auto p-0" onClick={() => setOpen(!open)}>
        {open ? "Show less" : "Show more"}
      </Button>
    </span>
  );
}

function Markdown({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_MARKDOWN || text.split("\n").length > MARKDOWN_LINES;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 self-stretch">
      <div
        className={cn(
          "w-full min-w-0 text-sm break-words text-foreground",
          long && !open && "max-h-40 overflow-hidden",
        )}
      >
        <MessageResponse>{text}</MessageResponse>
      </div>
      {long && (
        <Button size="xs" variant="link" className="h-auto p-0" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

function Chips({ items }: { items: Scalar[] }) {
  const [shown, toggle] = useCapped(items, CHIPS, (n) => `Show all ${n}`, "Show less");
  if (items.length === 0) return <None />;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((item, index) => (
        <Badge key={index} variant="outline" className="font-normal text-foreground">
          {scalarText(item)}
        </Badge>
      ))}
      {toggle}
    </span>
  );
}

// A nested value in a table's cell: how big it is, opening on the value itself.
function Nested({
  value,
  schema,
}: {
  value: unknown[] | Record<string, unknown>;
  schema?: Column["schema"];
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="xs" variant="link" className="h-auto p-0 font-normal" />}
      >
        {countOf(value)}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-80 w-auto max-w-[min(32rem,calc(100vw-2rem))] min-w-48 overflow-auto text-xs text-muted-foreground"
      >
        <Value layout={layoutOf(value, schema)} />
      </PopoverContent>
    </Popover>
  );
}

function Cell({ value, schema }: { value: unknown; schema?: Column["schema"] }) {
  if (value === null || value === undefined) return <None />;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "string") return <span title={value}>{value}</span>;
  return <Nested value={value as unknown[] | Record<string, unknown>} schema={schema} />;
}

function ObjectTable({ columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] }) {
  const [shown, toggle] = useCapped(rows, TABLE_ROWS, (n) => `Show all ${n}`, "Show less");
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-1">
      <div className="w-full min-w-0 rounded-md border bg-background/60">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.key} className="h-7 px-2 text-xs">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row, index) => (
              <TableRow key={index}>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className="max-w-64 truncate px-2 py-1 text-foreground"
                  >
                    <Cell value={row[column.key]} schema={column.schema} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {toggle}
    </div>
  );
}

// Whether a value shows on its label's line rather than folded under it.
function inline(layout: ValueLayout) {
  return layout.kind !== "table" && layout.kind !== "tree";
}

// An entry of a tree: a value on its label's line, or one that opens under it. Beside entries that
// open, a value on its line keeps its label in line with theirs, past their chevron.
function TreeEntry({ entry, depth, aligned }: { entry: Entry; depth: number; aligned: boolean }) {
  const layout = layoutOf(entry.value, entry.schema);
  if (inline(layout)) {
    return (
      <li className={cn("flex min-w-0 gap-2", aligned && "pl-4")}>
        <span className="shrink-0 font-medium">{entry.label}</span>
        <span className="min-w-0">
          <Value layout={layout} depth={depth + 1} />
        </span>
      </li>
    );
  }
  const value = entry.value as unknown[] | Record<string, unknown>;
  return (
    <li className="min-w-0">
      <Collapsible defaultOpen={depth === 0}>
        <CollapsibleTrigger className="group/node flex items-center gap-1 font-medium hover:text-foreground">
          <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[panel-open]/node:rotate-90" />
          {entry.label}
          <span className="font-normal text-muted-foreground">{countOf(value)}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 ml-1.5 min-w-0">
          <Value layout={layout} depth={depth + 1} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function Tree({ entries, depth }: { entries: Entry[]; depth: number }) {
  const [shown, toggle] = useCapped(entries, TREE_ENTRIES, (n) => `Show all ${n}`, "Show less");
  if (entries.length === 0) return <None />;
  const aligned = shown.some((entry) => !inline(layoutOf(entry.value, entry.schema)));
  return (
    <div
      className={cn("flex min-w-0 flex-col items-start gap-1", depth === 0 && "overflow-x-auto")}
    >
      <ul className={cn("flex w-full min-w-0 flex-col gap-1", depth > 0 && "border-l pl-2")}>
        {shown.map((entry) => (
          <TreeEntry key={entry.key} entry={entry} depth={depth} aligned={aligned} />
        ))}
      </ul>
      {toggle}
    </div>
  );
}

function Value({ layout, depth = 0 }: { layout: ValueLayout; depth?: number }) {
  switch (layout.kind) {
    case "text":
      return <LongText text={layout.text} />;
    case "number":
      return <span className="text-foreground tabular-nums">{layout.value}</span>;
    case "boolean":
      return <span className="text-foreground">{layout.value ? "Yes" : "No"}</span>;
    case "none":
      return <None />;
    case "chips":
      return <Chips items={layout.items} />;
    case "table":
      return <ObjectTable columns={layout.columns} rows={layout.rows} />;
    case "tree":
      return <Tree entries={layout.entries} depth={depth} />;
  }
}

function Part({ part }: { part: PartLayout }) {
  switch (part.kind) {
    case "text":
      return <Output layout={part.layout} />;
    case "image":
      return <img alt="" src={part.src} className="max-h-64 max-w-full rounded-md border" />;
    case "link": {
      const chip =
        "flex max-w-full items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-foreground";
      const content = (
        <>
          <LinkIcon className="size-3.5 shrink-0" />
          <span className="truncate">{part.label}</span>
        </>
      );
      return part.href ? (
        <a
          href={part.href}
          target="_blank"
          rel="noreferrer"
          className={cn(chip, "hover:underline")}
        >
          {content}
        </a>
      ) : (
        <span className={chip}>{content}</span>
      );
    }
    case "other":
      return <span className="text-muted-foreground italic">{part.label}</span>;
  }
}

function Output({ layout }: { layout: OutputLayout }) {
  switch (layout.kind) {
    case "error":
      return (
        <Alert variant="destructive" role={undefined} className="text-xs">
          <XIcon />
          <AlertDescription className="break-words whitespace-pre-wrap">
            {layout.text}
          </AlertDescription>
        </Alert>
      );
    case "markdown":
      return <Markdown text={layout.text} />;
    case "parts":
      return (
        <div className="flex min-w-0 flex-col items-start gap-2">
          {layout.parts.map((part, index) => (
            <Part key={index} part={part} />
          ))}
        </div>
      );
    case "value":
      return <Value layout={layout.layout} />;
  }
}

// A titled block with its laid-out view.
// The value as it was sent or given back, for reading or copying as it is.
function rawText(value: unknown) {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

// The text as a Markdown code block in the language given, fenced past any backticks it holds.
function fenced(text: string, language: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

// An input or output under its title, laid out, or as it is while its raw toggle is pressed.
function Block({ title, value, children }: { title: string; value: unknown; children: ReactNode }) {
  const [raw, setRaw] = useState(false);
  const text = raw ? rawText(value) : "";
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <WithTooltip label={raw ? "Show pretty" : "Show raw"}>
          <button
            type="button"
            aria-label={`Raw ${title.toLowerCase()}`}
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
            className="rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:text-foreground"
          >
            <BracesIcon className="size-3.5" />
          </button>
        </WithTooltip>
      </div>
      {!raw ? (
        children
      ) : (
        <div className="max-h-80 overflow-auto">
          <MessageResponse>
            {fenced(text, typeof value === "string" ? "text" : "json")}
          </MessageResponse>
        </div>
      )}
    </section>
  );
}

export function ToolInput({ value, schema }: { value: unknown; schema?: JsonSchema }) {
  if (!isObject(value)) {
    return (
      <Block title="Input" value={value}>
        <Value layout={layoutOf(value, schema)} />
      </Block>
    );
  }
  const entries = entriesOf(value, schema);
  return (
    <Block title="Input" value={value}>
      {entries.length === 0 ? (
        <None />
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {entries.map((entry) => (
            <div key={entry.key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="break-words">{entry.label}</dt>
              <dd className="min-w-0">
                <Value layout={layoutOf(entry.value, entry.schema)} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Block>
  );
}

export function ToolOutput({
  output,
  schema,
}: {
  output: { ok: true; value: unknown } | { ok: false; error: string };
  schema?: JsonSchema;
}) {
  return (
    <Block title={output.ok ? "Output" : "Error"} value={output.ok ? output.value : output.error}>
      <Output layout={outputLayoutOf(output, schema)} />
    </Block>
  );
}
