// The layouts the agent writes in its replies, drawn with Mage's own components through OpenUI
// Lang's renderer: a column of cards, rows, text, figures, tables, lists, bars, buttons and forms.
// A layout renders as it streams. Once written, one that gives nothing to draw shows its source
// instead, and one with parts that could not be drawn offers its source under what could. A
// button, in a form or not, posts a message as the person who clicks; nothing rendered calls a
// tool, the API or a link. Loaded only once a reply has a layout.

import {
  type ComponentRenderer,
  createLibrary,
  defineComponent,
  FormNameContext,
  Renderer,
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
  useTriggerAction,
} from "@openuidev/react-lang";
import { cn } from "cn";
import { useContext, useMemo } from "react";
import type * as z from "zod";

import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import { ReplyActions } from "@/web/replies/reply-actions";
import { LAYOUT_COMPONENTS, LAYOUT_ROOT, messageOf, outcomeOf } from "@/web/replies/reply-layout";

// A component's props as the parser gives them: possibly partial while the layout streams.
type Props<T> = Parameters<ComponentRenderer<Partial<T>>>[0];

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? "")) : [];
}

// A button that sends its message, with its form's values, as whoever clicks; off for anyone who
// may not post, and while the layout is still being written.
function ActionButton({
  label,
  run,
  variant,
}: {
  label: string;
  run?: unknown;
  variant?: "default" | "outline";
}) {
  const { send } = useContext(ReplyActions);
  const trigger = useTriggerAction();
  const formName = useFormName();
  const streaming = useIsStreaming();
  return (
    <Button
      type="button"
      size="sm"
      variant={variant ?? "outline"}
      disabled={!send || streaming}
      onClick={() => void trigger(label, formName, run as never)}
    >
      {label}
    </Button>
  );
}

function FieldInput({ name, placeholder }: { name: string; placeholder?: string }) {
  const formName = useFormName();
  const get = useGetFieldValue();
  const set = useSetFieldValue();
  const value = get(formName, name) as string | undefined;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{name}</span>
      <Input
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(event) => set(formName, "Input", name, event.target.value, false)}
      />
    </label>
  );
}

function FieldSelect({ name, options }: { name: string; options: string[] }) {
  const formName = useFormName();
  const get = useGetFieldValue();
  const set = useSetFieldValue();
  const value = (get(formName, name) as string | undefined) ?? null;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{name}</span>
      <Select value={value} onValueChange={(next) => set(formName, "Select", name, next, false)}>
        <SelectTrigger aria-label={name} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Values as horizontal bars from a shared zero, each labelled with its figure.
function BarList({ labels, values, unit }: { labels: string[]; values: number[]; unit?: string }) {
  const most = Math.max(0, ...values.filter(Number.isFinite));
  const shown = (value: number) => `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
  return (
    <dl className="grid grid-cols-[minmax(4rem,max-content)_1fr_max-content] items-center gap-x-3 gap-y-1.5 text-sm">
      {labels.map((label, index) => {
        const value = values[index];
        if (value === undefined || !Number.isFinite(value)) return null;
        return (
          <div key={index} className="contents" title={`${label}: ${shown(value)}`}>
            <dt className="truncate text-muted-foreground">{label}</dt>
            <dd className="h-2.5">
              <div
                aria-hidden
                className="h-full rounded-r-[4px] bg-primary"
                style={{ width: most > 0 ? `${Math.max(0, (value / most) * 100)}%` : 0 }}
              />
            </dd>
            <dd className="text-right tabular-nums">{shown(value)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// Each component's look, by name.
const RENDERERS: Record<string, ComponentRenderer<any>> = {
  Stack: ({ props, renderNode }: Props<{ children: unknown[] }>) => (
    <div className="flex flex-col gap-3">{renderNode(props.children)}</div>
  ),
  Card: ({ props, renderNode }: Props<{ title: string; children: unknown[] }>) => (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{renderNode(props.children)}</CardContent>
    </Card>
  ),
  Row: ({ props, renderNode }: Props<{ children: unknown[] }>) => (
    <div className="flex flex-wrap items-start gap-3">{renderNode(props.children)}</div>
  ),
  Text: ({ props }: Props<{ text: string }>) => <p className="text-sm">{props.text}</p>,
  Stat: ({ props }: Props<{ label: string; value: string; change: string }>) => (
    <div className="flex min-w-28 flex-1 flex-col">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className="text-xl font-semibold tabular-nums">{props.value}</span>
      {props.change && (
        <span className="text-xs text-muted-foreground tabular-nums">{props.change}</span>
      )}
    </div>
  ),
  Table: ({ props }: Props<{ columns: string[]; rows: string[][] }>) => (
    <Table>
      <TableHeader>
        <TableRow>
          {texts(props.columns).map((column, index) => (
            <TableHead key={index}>{column}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {(Array.isArray(props.rows) ? props.rows : []).map((row, index) => (
          <TableRow key={index}>
            {texts(row).map((cell, at) => (
              <TableCell key={at}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
  List: ({ props }: Props<{ items: string[]; ordered: boolean }>) => {
    const Tag = props.ordered ? "ol" : "ul";
    return (
      <Tag
        className={cn(
          "flex flex-col gap-1 pl-5 text-sm",
          props.ordered ? "list-decimal" : "list-disc",
        )}
      >
        {texts(props.items).map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </Tag>
    );
  },
  Bars: ({ props }: Props<{ labels: string[]; values: number[]; unit: string }>) => (
    <BarList
      labels={texts(props.labels)}
      values={(Array.isArray(props.values) ? props.values : []).map(Number)}
      unit={props.unit}
    />
  ),
  Button: ({
    props,
  }: Props<{ label: string; action: unknown; variant: "default" | "outline" }>) => (
    <ActionButton label={props.label ?? ""} run={props.action} variant={props.variant} />
  ),
  Form: ({ props, renderNode }: Props<{ name: string; fields: unknown[]; buttons: unknown[] }>) => (
    <FormNameContext.Provider value={props.name}>
      <form
        aria-label={props.name}
        className="flex flex-col gap-3"
        onSubmit={(event) => event.preventDefault()}
      >
        {renderNode(props.fields)}
        <div className="flex flex-wrap gap-2">{renderNode(props.buttons)}</div>
      </form>
    </FormNameContext.Provider>
  ),
  Input: ({ props }: Props<{ name: string; placeholder: string }>) => (
    <FieldInput name={props.name ?? ""} placeholder={props.placeholder} />
  ),
  Select: ({ props }: Props<{ name: string; options: string[] }>) => (
    <FieldSelect name={props.name ?? ""} options={texts(props.options)} />
  ),
};

const library = createLibrary({
  components: LAYOUT_COMPONENTS.map((component) =>
    defineComponent({
      name: component.name,
      description: component.description,
      props: component.props as z.ZodObject,
      component: RENDERERS[component.name]!,
    }),
  ),
  root: LAYOUT_ROOT,
});

// The layout's source as written, for one that cannot be drawn.
function Source({ source }: { source: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
      {source}
    </pre>
  );
}

export default function ReplyUi({ source, streaming }: { source: string; streaming: boolean }) {
  const { send } = useContext(ReplyActions);
  const outcome = useMemo(() => (streaming ? null : outcomeOf(source)), [source, streaming]);
  if (outcome && !outcome.drawn) {
    return (
      <div data-slot="reply-ui" data-drawn="false">
        <Source source={source} />
      </div>
    );
  }
  return (
    <div data-slot="reply-ui" data-drawn="true" className="flex flex-col gap-2">
      <Renderer
        response={source}
        library={library}
        isStreaming={streaming}
        publishObservability={false}
        onAction={(event) => {
          const text = messageOf(event);
          if (text && send) send(text);
        }}
      />
      {outcome && outcome.problems.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Source</summary>
          <div className="mt-1">
            <Source source={source} />
          </div>
        </details>
      )}
    </div>
  );
}
