// How policies show: a dot of a policy's colour, a rule's tags, and how many tools use each policy.

import { cn } from "cn";

import { type PolicyColor, TOOL_OFF } from "@/shared/tools.ts";
import { Badge } from "@/web/components/ui/badge";
import { type Shown, type Tone, tagsOf } from "@/web/agent/policies/model";
import { usePolicies } from "@/web/agent/policies/provider";

export const COLORS: Record<PolicyColor, string> = {
  green: "bg-green-600 dark:bg-green-400",
  emerald: "bg-emerald-600 dark:bg-emerald-400",
  teal: "bg-teal-600 dark:bg-teal-400",
  cyan: "bg-cyan-600 dark:bg-cyan-400",
  sky: "bg-sky-600 dark:bg-sky-400",
  blue: "bg-blue-600 dark:bg-blue-400",
  indigo: "bg-indigo-600 dark:bg-indigo-400",
  violet: "bg-violet-600 dark:bg-violet-400",
  purple: "bg-purple-600 dark:bg-purple-400",
  fuchsia: "bg-fuchsia-600 dark:bg-fuchsia-400",
  pink: "bg-pink-600 dark:bg-pink-400",
  orange: "bg-orange-600 dark:bg-orange-400",
  amber: "bg-amber-600 dark:bg-amber-400",
  yellow: "bg-yellow-600 dark:bg-yellow-400",
  lime: "bg-lime-600 dark:bg-lime-400",
  gray: "bg-zinc-500 dark:bg-zinc-400",
};

// A policy's colour, or how off and nothing set show.
export function PolicyDot({ color, kind }: { color?: PolicyColor; kind?: "off" | "unset" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        kind === "off" && "border-2 border-destructive",
        kind === "unset" && "border border-dashed border-muted-foreground",
        !kind && COLORS[color ?? "gray"],
      )}
    />
  );
}

const TONES: Record<Tone, string> = {
  open: "bg-green-500/10 text-green-700 dark:text-green-400",
  team: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  need: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  independent: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  off: "bg-destructive/10 text-destructive",
};

export function PolicyTags({ rule, className }: { rule: Shown; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {tagsOf(rule).map((tag) => (
        <Badge
          key={tag.text}
          variant="secondary"
          className={cn("h-5 max-w-full truncate font-normal", TONES[tag.tone])}
        >
          {tag.text}
        </Badge>
      ))}
    </span>
  );
}

// How many of the tools are set to each policy, and off: a dot and a number for each. In a space,
// a tool's extra rule counts where it has one.
export function PolicyCounts({
  tools,
}: {
  tools: { orgPolicy: string | null; policy: string | null }[];
}) {
  const { byId } = usePolicies();
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const key = tool.policy ?? tool.orgPolicy;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  const nameOf = (key: string) =>
    key === TOOL_OFF ? "Off" : (byId.get(key)?.name ?? "Removed policy");
  return (
    <span className="flex items-center gap-2.5">
      <span className="sr-only">
        {entries.map(([key, count]) => `${count} ${nameOf(key)}`).join(", ")}
      </span>
      {entries.map(([key, count]) => (
        <span key={key} aria-hidden className="flex items-center gap-1 tabular-nums">
          {key === TOOL_OFF ? <PolicyDot kind="off" /> : <PolicyDot color={byId.get(key)?.color} />}
          {count}
        </span>
      ))}
    </span>
  );
}
