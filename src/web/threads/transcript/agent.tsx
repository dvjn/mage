// What the agent's rows share: who the thread's agent is, the caret it writes
// behind, and the name of the model a turn was written with. A subagent goes by its label
// everywhere, including its own thread.

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import { modelsQuery } from "@/web/models/queries";
import { parseModelRef } from "@/shared/model-ref.ts";

// An agent as rows name it: the thread's agent, or a subagent by its label.
export interface AgentName {
  name: string;
  subagent: boolean;
}

// Who writes the thread's agent rows, and what the agent that starts subagents goes by: the name
// its space or org gave it, or the usual one.
export interface ThreadAgent {
  self: AgentName;
  agentName: string;
}

export const ThreadAgentContext = createContext<ThreadAgent>({
  self: { name: DEFAULT_AGENT_NAME, subagent: false },
  agentName: DEFAULT_AGENT_NAME,
});

export function useThreadAgent() {
  return useContext(ThreadAgentContext);
}

// The blinking cursor the agent writes behind.
export const caret = (
  <span aria-hidden className="inline-block h-4 w-2 animate-pulse bg-foreground/70" />
);

// The model's name from the org's list, or the id its ref ends with.
export function useModelNamer() {
  const models = useQuery(modelsQuery);
  const listed = [...(models.data?.models ?? []), ...(models.data?.turnedOff ?? [])];
  return (ref: string | null) => {
    if (!ref) return null;
    return listed.find((model) => model.ref === ref)?.name ?? (parseModelRef(ref).modelId || null);
  };
}

export function useModelName(ref: string | null) {
  return useModelNamer()(ref);
}
