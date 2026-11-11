// The reader's side questions about a message, like private comments: a button among the
// message's actions that starts a new one, and once there are any, one kept in view at the row's
// end that opens them, one at a time with a switcher between them. Each is a small thread of what
// they asked and what was answered, the answer showing as it is written, where they ask more or
// stop an answer. Nobody else sees them, and the thread's agent never reads them.

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleIcon,
  CornerDownLeftIcon,
  SquareIcon,
} from "lucide-react";
import { cn } from "cn";
import { createContext, useContext, useState } from "react";

import { MessageResponse } from "@/web/components/ai-elements/message";
import type { Aside } from "@/shared/threads/history.ts";
import { WithTooltip } from "@/web/components/with-tooltip";
import { Button } from "@/web/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Spinner } from "@/web/components/ui/spinner";
import { Textarea } from "@/web/components/ui/textarea";

export interface Asides {
  // The reader's side questions, by the row each is about, oldest first.
  byRow: ReadonlyMap<string, readonly Aside[]>;
  // The popover open: the row's side questions, or a new one about it.
  open: AsideOpen | null;
  setOpen(open: AsideOpen | null): void;
  // Asks a new side question about the row, or more in the one named; resolves once answered, and
  // fails when it could not be asked.
  ask(rowId: string, text: string, asideId?: string): Promise<void>;
  // The row whose side question is being answered.
  answering: string | null;
  // Stops the answer being written.
  stop(): void;
}

export interface AsideOpen {
  rowId: string;
  fresh: boolean;
}

export const AsidesContext = createContext<Asides | null>(null);

// `fresh` starts a new side question; otherwise the button opens those there are, the newest
// first. `className` places the button.
export function AsideButton({
  rowId,
  fresh,
  className,
}: {
  rowId: string;
  fresh: boolean;
  className?: string;
}) {
  const asides = useContext(AsidesContext);
  const [draft, setDraft] = useState("");
  // Which of the row's side questions shows, from the oldest; the newest when unset.
  const [picked, setPicked] = useState<number | null>(null);
  const list = asides?.byRow.get(rowId) ?? [];
  // A side question just asked shows in place of the one picked before.
  const [seen, setSeen] = useState(list.length);
  if (seen !== list.length) {
    setSeen(list.length);
    setPicked(null);
  }
  if (!asides) return null;
  if (!fresh && list.length === 0) return null;
  const at = Math.min(picked ?? list.length - 1, list.length - 1);
  const aside = fresh ? undefined : list[at];
  const open = asides.open?.rowId === rowId && asides.open.fresh === fresh;
  const answering = asides.answering === rowId;
  // Nothing of the answer has arrived yet.
  const waiting = answering && !!aside && aside.turns.at(-1)?.role !== "answer";
  const label = fresh ? "Ask aside" : list.length > 1 ? "Side questions" : "Side question";
  function send() {
    const text = draft.trim();
    if (!text || !asides || answering) return;
    setDraft("");
    const asked = asides.ask(rowId, text, aside?.id);
    // A new one shows with the others while it is answered.
    if (fresh) asides.setOpen({ rowId, fresh: false });
    asked.catch(() => setDraft((now) => now || text));
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        asides.setOpen(next ? { rowId, fresh } : null);
        if (next) setPicked(null);
      }}
    >
      <WithTooltip label={label}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={label}
              className={cn(
                "gap-0.5",
                fresh ? "text-muted-foreground" : "w-auto px-1 text-foreground",
                className,
              )}
            >
              <MessageCircleIcon />
              {!fresh && <span className="text-xs tabular-nums">{list.length}</span>}
            </Button>
          }
        />
      </WithTooltip>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] gap-3 p-3">
        {!fresh && list.length > 1 && (
          <div
            role="group"
            aria-label="Side questions"
            className="-my-1 flex items-center justify-end text-xs text-muted-foreground tabular-nums"
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Previous side question"
              disabled={at === 0}
              onClick={() => setPicked(at - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span>
              {at + 1}/{list.length}
            </span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Next side question"
              disabled={at === list.length - 1}
              onClick={() => setPicked(at + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        )}
        {!fresh && (
          <div
            role="log"
            aria-label="Side question"
            className="flex max-h-96 flex-col gap-3 overflow-y-auto"
          >
            {aside?.turns.map((turn) => (
              <div key={turn.id} className="flex flex-col gap-0.5 text-sm">
                <span className="text-xs text-muted-foreground">
                  {turn.role === "question" ? "You" : "Answer"}
                </span>
                {turn.role === "question" ? (
                  <p className="whitespace-pre-wrap">{turn.text}</p>
                ) : turn.failure ? (
                  <p className="text-destructive">
                    {turn.failure === "stopped"
                      ? "Stopped"
                      : (turn.error ?? "The model did not answer")}
                  </p>
                ) : (
                  <MessageResponse>{turn.text}</MessageResponse>
                )}
              </div>
            ))}
            {waiting && (
              <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                Answering…
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Textarea
            aria-label="Ask aside"
            placeholder={aside ? "Ask more" : "Ask about this message"}
            value={draft}
            rows={1}
            className="min-h-8 resize-none py-[5px] text-sm md:text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          {answering ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Stop answering"
              className="shrink-0"
              onClick={() => asides.stop()}
            >
              <SquareIcon className="fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              aria-label="Ask"
              className="shrink-0"
              disabled={!draft.trim()}
              onClick={send}
            >
              <CornerDownLeftIcon />
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
