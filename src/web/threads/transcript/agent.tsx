// What the agent's rows share: who the thread's agent is and its avatar, the caret it writes
// behind, and the name of the model a turn was written with. A subagent goes by its label
// everywhere, its own thread among them, and its avatar has a dashed ring.

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { cn } from "cn";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { initialsOf } from "@/web/lib/initials";
import { modelsQuery } from "@/web/models/queries";

// What the agent of a thread that starts subagents goes by where it is named.
export const AGENT_NAME = "Agent";

// An agent as rows name it: the thread's agent, or a subagent by its label.
export interface AgentName {
  name: string;
  subagent: boolean;
}

// Who writes the thread's agent rows, and what the agent that starts subagents goes by.
export interface ThreadAgent {
  self: AgentName;
  agentName: string;
}

export const ThreadAgentContext = createContext<ThreadAgent>({
  self: { name: AGENT_NAME, subagent: false },
  agentName: AGENT_NAME,
});

export function useThreadAgent() {
  return useContext(ThreadAgentContext);
}

export function AgentAvatar({ name, subagent }: AgentName) {
  return (
    <Avatar
      size="sm"
      className={cn(subagent && "after:border-dashed after:border-muted-foreground/70")}
    >
      <AvatarFallback>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}

// The blinking cursor the agent writes behind.
export const caret = (
  <span aria-hidden className="inline-block h-4 w-2 animate-pulse bg-foreground/70" />
);

// The model's name from the org's list, or the id its ref ends with.
export function useModelName(ref: string | null) {
  const models = useQuery(modelsQuery);
  if (!ref) return null;
  const listed = [...(models.data?.models ?? []), ...(models.data?.turnedOff ?? [])];
  return listed.find((model) => model.ref === ref)?.name ?? (ref.split("/").pop() || null);
}
