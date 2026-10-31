// Writing in a thread while the agent works: the composer, the line saying what the agent is doing,
// and the tray of messages waiting for it. Enter sends, or steers the reply under way; Alt/⌥+Enter
// queues for the next reply; the split button also interrupts the reply and sends at once, and the
// stop button stops it. Everyone sees the tray; each author can edit their own waiting messages,
// switch them between steering and queueing, or remove them. While the agent waits for a decision
// on a tool call, the composer says so. Viewers only read, and a line where the composer would be
// says so. Offline, nothing sends or stops until the app is back online.

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, EyeIcon, SquareIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import { anyThreadEventSchema, type Delivery, QUIET_PREFIX } from "@/shared/threads.ts";
import type { PendingMessage } from "@/shared/transcript.ts";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/web/components/ai-elements/prompt-input";
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
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { useOnline } from "@/web/lib/online";
import { mergeEvents } from "@/web/lib/thread-events";

export function Composer({
  running,
  waiting,
  readOnly,
  sending,
  stopping,
  onSend,
  onStop,
  tools,
}: {
  running: boolean;
  // What the agent waits for from people, if anything.
  waiting?: "answer" | "decision" | null;
  readOnly?: boolean;
  sending: boolean;
  stopping: boolean;
  // Throws when the message is not posted, so the composer keeps the text.
  onSend: (text: string, mode: Delivery) => Promise<void>;
  onStop: () => void;
  tools?: ReactNode;
}) {
  const mode = useRef<Delivery>("steer");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const online = useOnline();

  function submitAs(next: Delivery) {
    mode.current = next;
    textarea.current?.form?.requestSubmit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !event.altKey || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitAs("queue");
  }

  if (readOnly) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <EyeIcon className="size-4 shrink-0" aria-hidden />
        You can view this thread
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <PromptInput
        onSubmit={(message) => {
          const chosen = mode.current;
          mode.current = "steer";
          return onSend(message.text, chosen);
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            ref={textarea}
            aria-label="Message"
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
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function act(request: () => Promise<Response>) {
    setBusy(true);
    const res = await request();
    setBusy(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return false;
    }
    setError(undefined);
    const event = anyThreadEventSchema.safeParse(await res.json());
    if (event.success) mergeEvents(queryClient, threadId, [event.data]);
    return true;
  }

  const param = { id: threadId, messageId: message.id };
  const change = (json: { text?: string; mode?: "steer" | "queue" }) =>
    act(() => apiClient.v1.threads[":id"].messages[":messageId"].$patch({ param, json }));
  const remove = () =>
    act(() => apiClient.v1.threads[":id"].messages[":messageId"].$delete({ param }));

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
      <FieldError>{error}</FieldError>
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
