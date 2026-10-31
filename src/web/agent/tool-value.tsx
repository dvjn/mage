// A tool call's input or result, laid out from the value and the tool's schema: labelled fields,
// plain values inline, lists and nested lists, and the JSON past two levels; a result's text parts
// as text, in the destructive tone when the call failed.

import { cn } from "cn";
import { useState } from "react";

import type { JsonSchema } from "@/shared/tools.ts";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  type CallToolResult,
  layoutOf,
  type Scalar,
  type ValueLayout,
} from "@/web/agent/tool-layout";

// Text longer than this is cut to a few lines until opened.
const LONG_TEXT = 240;

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LONG_TEXT)
    return <span className="break-words whitespace-pre-wrap">{text}</span>;
  return (
    <span className="flex flex-col items-start gap-1">
      <span className={cn("break-words whitespace-pre-wrap", !open && "line-clamp-3")}>{text}</span>
      <Button size="xs" variant="link" className="h-auto p-0" onClick={() => setOpen(!open)}>
        {open ? "Show less" : "Show more"}
      </Button>
    </span>
  );
}

function scalarText(value: Scalar) {
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function Layout({ layout }: { layout: ValueLayout }) {
  switch (layout.kind) {
    case "text":
      return <LongText text={layout.text} />;
    case "number":
      return <span className="tabular-nums">{layout.value}</span>;
    case "boolean":
      return <span>{layout.value ? "Yes" : "No"}</span>;
    case "none":
      return <span className="text-muted-foreground italic">none</span>;
    case "list":
      return layout.items.length === 0 ? (
        <span className="text-muted-foreground italic">none</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {layout.items.map((item, index) => (
            <Badge key={index} variant="outline" className="font-normal">
              {scalarText(item)}
            </Badge>
          ))}
        </span>
      );
    case "items":
      return (
        <ol className="flex flex-col gap-1.5">
          {layout.items.map((item, index) => (
            <li key={index} className="border-l pl-2">
              <Layout layout={item} />
            </li>
          ))}
        </ol>
      );
    case "fields":
      return layout.fields.length === 0 ? (
        <span className="text-muted-foreground italic">none</span>
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {layout.fields.map((field) => (
            <div key={field.key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="font-medium text-foreground">{field.label}</dt>
              <dd className="min-w-0 text-foreground">
                <Layout layout={field.value} />
              </dd>
            </div>
          ))}
        </dl>
      );
    case "json":
      return (
        <pre className="rounded-sm bg-background/60 p-2 font-mono break-words whitespace-pre-wrap">
          {layout.json}
        </pre>
      );
  }
}

// A titled block with its laid-out view.
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <span className="font-medium">{title}</span>
      {children}
    </section>
  );
}

export function ToolInput({ value, schema }: { value: unknown; schema?: JsonSchema }) {
  return (
    <Block title="Input">
      <Layout layout={layoutOf(value, schema)} />
    </Block>
  );
}

export function ToolResult({ result, schema }: { result: CallToolResult; schema?: JsonSchema }) {
  const text = result.content.map((part) => part.text).join("\n");
  return (
    <Block title={result.isError ? "Error" : "Output"}>
      {result.isError ? (
        <span className="break-words whitespace-pre-wrap text-destructive">{text}</span>
      ) : result.structuredContent ? (
        <Layout layout={layoutOf(result.structuredContent, schema)} />
      ) : (
        <LongText text={text} />
      )}
    </Block>
  );
}
