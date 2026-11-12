// The thread's task list, as the tray's tasks card holds it: each task's status, title and whom it
// is for, edited in place. Whoever may post cycles a status, renames, reassigns, adds and removes
// tasks; the server says whether they may. Everyone else, and the archived list, reads plain text.

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";

import type { Task, TaskCandidate, TaskList as TaskListData, TaskStatus } from "@/shared/tasks.ts";
import { SegmentedControl } from "@/web/components/segmented-control";
import { Button, buttonVariants } from "@/web/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/web/components/ui/combobox";
import { Input } from "@/web/components/ui/input";
import { WithTooltip } from "@/web/components/with-tooltip";
import { usePager, usePublishPager } from "@/web/threads/pager";
import { useTaskActions } from "@/web/threads/mutations";
import { tasksQuery } from "@/web/threads/queries";

const NEXT: Record<TaskStatus, TaskStatus> = {
  todo: "doing",
  doing: "done",
  done: "todo",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

export const STATUS_ICONS: Record<TaskStatus, typeof CircleIcon> = {
  todo: CircleIcon,
  doing: CircleDotIcon,
  done: CircleCheckIcon,
};

// A status color holds on hover; only the background changes.
export const STATUS_TINTS: Record<TaskStatus, string> = {
  todo: "text-muted-foreground hover:text-muted-foreground",
  doing: "text-info hover:text-info",
  done: "text-success hover:text-success",
};

function assigneeName(task: Task, agentName: string) {
  const { assignee } = task;
  return assignee.kind === "agent" ? agentName : assignee.name;
}

// One thing a task may be given to.
interface Choice {
  key: string;
  name: string;
  assign:
    | { kind: "agent" }
    | { kind: "subagent"; threadId: string }
    | { kind: "person"; userId: string };
}

function choiceOf(candidate: TaskCandidate, agentName: string): Choice {
  if (candidate.kind === "agent") {
    return { key: "agent", name: agentName, assign: { kind: "agent" } };
  }
  if (candidate.kind === "subagent") {
    return {
      key: `subagent:${candidate.threadId}`,
      name: candidate.name,
      assign: { kind: "subagent", threadId: candidate.threadId },
    };
  }
  return {
    key: `person:${candidate.userId}`,
    name: candidate.name,
    assign: { kind: "person", userId: candidate.userId },
  };
}

function keyOf(task: Task) {
  const { assignee } = task;
  if (assignee.kind === "agent") return "agent";
  return assignee.kind === "subagent"
    ? `subagent:${assignee.threadId}`
    : `person:${assignee.userId}`;
}

function StatusButton({
  task,
  actions,
}: {
  task: Task;
  actions: ReturnType<typeof useTaskActions>;
}) {
  const Icon = STATUS_ICONS[task.status];
  const next = NEXT[task.status];
  return (
    <WithTooltip label={STATUS_LABELS[task.status]}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Status: ${task.status}. Set to ${next}`}
        // The glyph alone takes the row's edge, with a hit area as large as the row's other
        // buttons.
        className={cn(
          "relative size-4 shrink-0 p-0 after:absolute after:-inset-2 hover:bg-transparent dark:hover:bg-transparent",
          STATUS_TINTS[task.status],
        )}
        onClick={() => actions.change(task.id, { status: next })}
      >
        <Icon className="size-4" />
      </Button>
    </WithTooltip>
  );
}

// The title as a ghost input: Enter or leaving it saves, Esc takes the edit back.
function TitleInput({ task, actions }: { task: Task; actions: ReturnType<typeof useTaskActions> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const reverting = useRef(false);
  // The saved title arrives with the list, and then it is shown again.
  useEffect(() => setDraft(null), [task.title]);
  function save() {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    const title = (draft ?? task.title).trim();
    if (!title || title === task.title) {
      setDraft(null);
      return;
    }
    actions.change(task.id, { title });
  }
  return (
    <Input
      variant="ghost"
      aria-label="Task title"
      className={cn("flex-1", task.status === "done" && "text-muted-foreground line-through")}
      value={draft ?? task.title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          // Esc closes nothing else while an edit is open.
          event.stopPropagation();
          reverting.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

// The assignee as a ghost combobox over the agent, the live subagents and the people who may post.
function AssigneePicker({
  task,
  list,
  agentName,
  actions,
}: {
  task: Task;
  list: TaskListData;
  agentName: string;
  actions: ReturnType<typeof useTaskActions>;
}) {
  const choices = list.assignees.map((one) => choiceOf(one, agentName));
  const key = keyOf(task);
  // An assignee who can no longer be picked is still shown.
  const current =
    choices.find((choice) => choice.key === key) ??
    ({
      key,
      name: assigneeName(task, agentName),
      assign: { kind: "agent" },
    } satisfies Choice);
  const shown = assigneeName(task, agentName);
  return (
    <Combobox
      items={choices}
      value={current}
      onValueChange={(choice: Choice | null) => {
        if (!choice || choice.key === key) return;
        actions.change(task.id, { assignee: choice.assign });
      }}
      itemToStringLabel={(choice: Choice) => choice.name}
      isItemEqualToValue={(a: Choice, b: Choice) => a.key === b.key}
    >
      <ComboboxTrigger
        aria-label={`Assignee: ${shown}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "max-w-36 min-w-0 justify-between",
        )}
      >
        <span className="truncate">{shown}</span>
      </ComboboxTrigger>
      <ComboboxContent className="w-auto min-w-56">
        <ComboboxInput showTrigger={false} placeholder="Search" aria-label="Search assignees" />
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(choice: Choice) => (
            <ComboboxItem key={choice.key} value={choice}>
              {choice.name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function TaskRow({
  task,
  list,
  agentName,
  actions,
}: {
  task: Task;
  list: TaskListData;
  agentName: string;
  actions: ReturnType<typeof useTaskActions>;
}) {
  const Icon = STATUS_ICONS[task.status];
  const assignee = assigneeName(task, agentName);
  if (!list.canEdit) {
    return (
      <li className="flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-muted/50">
        <Icon className={cn("size-4 shrink-0", STATUS_TINTS[task.status])} aria-hidden />
        <span className="sr-only">{task.status}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate px-1.5",
            task.status === "done" && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </span>
        <span className="text-xs text-muted-foreground">{assignee}</span>
      </li>
    );
  }
  return (
    <li className="flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-muted/50">
      <StatusButton task={task} actions={actions} />
      <TitleInput task={task} actions={actions} />
      <AssigneePicker task={task} list={list} agentName={agentName} actions={actions} />
      <WithTooltip label="Remove">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${task.title}`}
          onClick={() => actions.remove(task.id)}
        >
          <XIcon />
        </Button>
      </WithTooltip>
    </li>
  );
}

function isMine(task: Task, threadId: string) {
  return task.assignee?.kind === "subagent" && task.assignee.threadId === threadId;
}

// The done tasks the reader may archive: in a subagent's thread on its starter's list, its own.
function archivable(list: TaskListData, threadId: string) {
  return list.tasks.filter(
    (task) => task.status === "done" && (!list.shared || isMine(task, threadId)),
  );
}

// The tasks card's header actions: add a task, archive what is done, and switch to the archived
// tasks.
export function TaskActions({
  threadId,
  archived,
  onArchived,
  onAdd,
}: {
  threadId: string;
  archived: boolean;
  onArchived: (archived: boolean) => void;
  onAdd: () => void;
}) {
  const list = useQuery(tasksQuery(threadId)).data;
  const actions = useTaskActions(threadId);
  const done = !archived && list?.canEdit ? archivable(list, threadId).length : 0;
  return (
    <>
      {!archived && list?.canEdit && (
        <WithTooltip label="Add task">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Add task"
            onClick={onAdd}
          >
            <PlusIcon />
          </Button>
        </WithTooltip>
      )}
      {done > 0 && (
        <WithTooltip label="Archive done">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Archive done"
            onClick={() => actions.archiveDone()}
          >
            <ArchiveRestoreIcon />
          </Button>
        </WithTooltip>
      )}
      <WithTooltip label="Archived">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Archived"
          aria-pressed={archived}
          className="aria-pressed:bg-muted"
          onClick={() => onArchived(!archived)}
        >
          <ArchiveIcon />
        </Button>
      </WithTooltip>
    </>
  );
}

// The row that adds tasks, first in the list: Enter adds and stays for the next, Esc or leaving it
// empty closes it.
function AddRow({ onAdd, onClose }: { onAdd: (title: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  return (
    <li className="flex h-8 items-center px-1.5">
      <Input
        variant="ghost"
        autoFocus
        aria-label="New task"
        placeholder="Add task"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!draft.trim()) onClose();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Enter") return;
          const title = draft.trim();
          if (!title) return;
          onAdd(title);
          setDraft("");
        }}
      />
    </li>
  );
}

export function TaskList({
  threadId,
  agentName,
  archived = false,
  adding = false,
  onAddingChange,
}: {
  threadId: string;
  agentName: string;
  archived?: boolean;
  adding?: boolean;
  onAddingChange?: (adding: boolean) => void;
}) {
  const query = useQuery({
    ...tasksQuery(threadId, archived),
    refetchOnMount: "always",
  });
  const actions = useTaskActions(threadId);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const list = query.data;
  const everyone = list?.tasks ?? [];
  const shown =
    list?.shared && scope === "mine" ? everyone.filter((task) => isMine(task, threadId)) : everyone;
  const { items, pager } = usePager(shown);
  usePublishPager(pager);
  if (!list) return null;
  if (!archived && list.tasks.length === 0) return null;
  return (
    <div data-testid="task-list">
      {list.shared && (
        <SegmentedControl
          label="Tasks shown"
          className="pb-2"
          options={[
            { value: "mine", label: "Mine" },
            { value: "all", label: "All" },
          ]}
          value={scope}
          onChange={setScope}
        />
      )}
      <ul style={pager.total > pager.size ? { minHeight: `${pager.size * 2}rem` } : undefined}>
        {adding && list.canEdit && !archived && (
          <AddRow
            onAdd={(title) => {
              // The new task is last: show the page it is on.
              void actions.add(title).then(() => pager.onOffset(Number.MAX_SAFE_INTEGER));
            }}
            onClose={() => onAddingChange?.(false)}
          />
        )}
        {items.map((task) => (
          <TaskRow key={task.id} task={task} list={list} agentName={agentName} actions={actions} />
        ))}
      </ul>
      {archived && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">No archived tasks</p>
      )}
    </div>
  );
}
