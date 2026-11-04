// Writing in a thread while the agent works: the composer, the line saying what the agent is doing,
// and the tray of messages waiting for it. Enter sends, or steers the reply under way; Alt/⌥+Enter
// queues for the next reply; the split button also interrupts the reply and sends at once, and the
// stop button stops it. Everyone sees the tray; each author can edit their own waiting messages,
// switch them between steering and queueing, or remove them. While the agent waits for a decision
// on a tool call, the composer says so. A message starting with a slash opens the menu of the
// commands the reader may send, and one whose first word names one of them is sent as it; one that
// needs the reader's own connection to an MCP server offers to connect first. Viewers only read, as
// does everyone in an archived space, and a line where the composer would be says so. Offline,
// nothing sends or stops until the app is back online.

import { ChevronDownIcon, EyeIcon, SquareIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import { type CommandInput, commandOf, type ThreadCommand } from "@/shared/threads/commands.ts";
import { type Delivery, QUIET_PREFIX } from "@/shared/threads/events.ts";
import type { PendingMessage } from "@/shared/threads/rows.ts";
import {
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/web/components/prompt-input/parts";
import { PromptInput } from "@/web/components/prompt-input/prompt-input";
import { Button } from "@/web/components/ui/button";
import { ButtonGroup } from "@/web/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { InputGroupButton } from "@/web/components/ui/input-group";
import { Spinner } from "@/web/components/ui/spinner";
import { Textarea } from "@/web/components/ui/textarea";
import { useOnline } from "@/web/lib/online";
import { useConnectFlow } from "@/web/mcp/connect";
import {
  COMMAND_MENU,
  CommandMenu,
  commandOptionId,
  matchingCommands,
} from "@/web/threads/command-menu";
import { useWaitingMessage } from "@/web/threads/mutations";

export function Composer({
  running,
  waiting,
  readOnly,
  notice = "You can view this thread",
  sending,
  stopping,
  onSend,
  onStop,
  tools,
  commands = [],
  onConnected,
}: {
  running: boolean;
  // What the agent waits for from people, if anything.
  waiting?: "answer" | "decision" | null;
  readOnly?: boolean;
  // What the line in its place says while it is read-only.
  notice?: string;
  sending: boolean;
  stopping: boolean;
  // Throws when the message is not posted, so the composer keeps the text.
  onSend: (text: string, mode: Delivery, command?: CommandInput) => Promise<void>;
  onStop: () => void;
  tools?: ReactNode;
  // The commands the reader may send.
  commands?: readonly ThreadCommand[];
  // Called once the reader connected to a server one of the commands needs.
  onConnected?: () => Promise<unknown>;
}) {
  const mode = useRef<Delivery>("steer");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const online = useOnline();
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(0);
  // The text the menu was closed on, which keeps it closed until the text changes.
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const matches = closedOn === draft ? [] : matchingCommands(commands, draft);
  const picking = matches.length > 0;
  const chosen = Math.min(active, matches.length - 1);
  // The command the text names, when the reader must connect to its server before sending it.
  const named = commandOf(draft);
  const needs = commands.find(
    (command) => command.name === named?.name && command.connection?.connected === false,
  )?.connection;
  const connect = useConnectFlow(needs);

  function show(text: string) {
    setDraft(text);
    setActive(0);
  }

  function pick(command: ThreadCommand) {
    const text = `/${command.name} `;
    if (textarea.current) {
      textarea.current.value = text;
      textarea.current.focus();
    }
    show(text);
  }

  function submitAs(next: Delivery) {
    mode.current = next;
    textarea.current?.form?.requestSubmit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (picking && !event.nativeEvent.isComposing) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step) {
        event.preventDefault();
        setActive((chosen + step + matches.length) % matches.length);
        return;
      }
      // Enter on a command typed in full sends it.
      const whole = draft === `/${matches[chosen]!.name}`;
      if (
        (event.key === "Enter" && !event.shiftKey && !event.altKey && !whole) ||
        event.key === "Tab"
      ) {
        event.preventDefault();
        pick(matches[chosen]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setClosedOn(draft);
        return;
      }
    }
    if (event.key !== "Enter" || !event.altKey || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitAs("queue");
  }

  if (readOnly) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <EyeIcon className="size-4 shrink-0" aria-hidden />
        {notice}
      </p>
    );
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      {picking && <CommandMenu commands={matches} active={chosen} onPick={pick} />}
      {needs && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span>Connect to {needs.title} to send this</span>
          <Button
            size="xs"
            variant="outline"
            disabled={connect.busy}
            onClick={() =>
              void connect.start(async () => {
                await onConnected?.();
              }, window.location.pathname)
            }
          >
            Connect
          </Button>
          {connect.dialog}
        </div>
      )}
      <PromptInput
        onSubmit={(message) => {
          const delivery = mode.current;
          mode.current = "steer";
          const command = commandOf(message.text);
          const known = command && commands.some((found) => found.name === command.name);
          // The text leaves the composer once it is posted, unless the reader changed it meanwhile.
          return onSend(message.text, delivery, known ? command : undefined).then(() => {
            if (textarea.current?.value === message.text) show("");
          });
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            ref={textarea}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={picking ? COMMAND_MENU : undefined}
            aria-activedescendant={picking ? commandOptionId(chosen) : undefined}
            onChange={(event) => show(event.currentTarget.value)}
            placeholder={
              !online
                ? "You are offline"
                : waiting === "answer"
                  ? "The agent is waiting for an answer above; you can still steer or queue."
                  : waiting === "decision"
                    ? "The agent is waiting for a decision above; you can still steer or queue."
                    : running
                      ? "Steer the reply, or queue for the next one"
                      : "Write a message"
            }
            onKeyDown={onKeyDown}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>{tools}</PromptInputTools>
          <ButtonGroup>
            {running && (
              <InputGroupButton
                size="icon-sm"
                variant="outline"
                aria-label="Stop"
                title="Stop"
                onClick={onStop}
                disabled={stopping || !online}
              >
                <SquareIcon className="size-3 fill-current" />
              </InputGroupButton>
            )}
            <PromptInputSubmit
              aria-label={running ? "Steer" : "Send"}
              status={sending ? "submitted" : undefined}
              disabled={sending || !online}
            />
            {running && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      variant="default"
                      aria-label="More ways to send"
                      disabled={sending || !online}
                    />
                  }
                >
                  <ChevronDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-fit">
                  <DropdownMenuItem onClick={() => submitAs("queue")}>
                    Queue for the next reply
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => submitAs("interrupt")}>
                    Interrupt &amp; send
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </ButtonGroup>
        </PromptInputFooter>
      </PromptInput>
      {online ? (
        <p className="px-1 text-xs text-muted-foreground">
          {running ? "Enter steers the reply · Alt/⌥+Enter queues it · " : "Enter sends · "}
          Start with <code>{QUIET_PREFIX}</code> to write without waking the agent.
        </p>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">You can send once you are back online.</p>
      )}
    </div>
  );
}

// Says the agent is being stopped, between pressing Stop and the run ending.
export function RunStatus({ stopping }: { stopping: boolean }) {
  if (!stopping) return null;
  return (
    <div
      role="status"
      aria-label="Agent status"
      className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
    >
      <Spinner className="size-3.5" aria-hidden />
      <span>Stopping the agent…</span>
    </div>
  );
}

const MODE_LABELS: Record<Delivery, string> = {
  steer: "steers this reply",
  queue: "queued for the next reply",
  interrupt: "interrupts",
};

function WaitingItem({
  threadId,
  message,
  mine,
}: {
  threadId: string;
  message: PendingMessage;
  mine: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const waiting = useWaitingMessage(threadId, message.id);
  const busy = waiting.isPending;

  // Whether the change was made.
  const act = (change: { text?: string; mode?: "steer" | "queue" } | null) =>
    waiting.mutateAsync(change).then(
      () => true,
      () => false,
    );
  const change = (json: { text?: string; mode?: "steer" | "queue" }) => act(json);
  const remove = () => act(null);

  return (
    <li
      aria-label={`Waiting message from ${message.author.name}`}
      className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
    >
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{message.author.name}</span>
        {message.guest && <span>Guest</span>}
        <span>{MODE_LABELS[message.mode]}</span>
        {mine && !editing && (
          <span className="ml-auto flex gap-1">
            {message.mode !== "interrupt" && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void change({ mode: message.mode === "steer" ? "queue" : "steer" })}
              >
                {message.mode === "steer" ? "Queue instead" : "Steer instead"}
              </Button>
            )}
            {/* A command stands for what it was sent as; it is removed and sent again instead. */}
            {!message.command && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(message.text);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void change({ text: draft }).then((ok) => ok && setEditing(false));
          }}
        >
          <Textarea
            aria-label="Edit waiting message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-10"
          />
          <span className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="xs" type="submit" disabled={busy || !draft.trim()}>
              Save
            </Button>
          </span>
        </form>
      ) : (
        <p className="line-clamp-3 whitespace-pre-wrap">{message.text}</p>
      )}
      <FieldError>{waiting.error?.message}</FieldError>
    </li>
  );
}

// The messages waiting for the agent, oldest first.
export function PendingTray({
  threadId,
  pending,
  me,
}: {
  threadId: string;
  pending: PendingMessage[];
  me: string | undefined;
}) {
  if (pending.length === 0) return null;
  return (
    <ul aria-label="Waiting messages" className="flex flex-col gap-1.5">
      {pending.map((message) => (
        <WaitingItem
          key={message.id}
          threadId={threadId}
          message={message}
          mine={message.author.userId === me}
        />
      ))}
    </ul>
  );
}
