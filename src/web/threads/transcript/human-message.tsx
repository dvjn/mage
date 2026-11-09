// A person's message: an avatar, who wrote it and when, noted when its author was a guest of the
// thread or was removed from its org, then its text as markdown, or the command it was sent as and
// what followed it, with what can be done from it below, the reader's side question about it among
// that; the signed-in person's own rows carry their avatar in the accent colour. Their own message can be edited in place and sent again.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { useState } from "react";

import type { HumanRow } from "@/shared/threads/rows.ts";
import { meQuery } from "@/web/auth/queries";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Button } from "@/web/components/ui/button";
import { Textarea } from "@/web/components/ui/textarea";
import { initialsOf } from "@/web/lib/initials";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { RowToolbar } from "@/web/threads/transcript/row-history";

export function HumanMessage({
  row,
  onEdit,
}: {
  row: HumanRow;
  // Sends the message again with the text; resolves once sent.
  onEdit?: (text: string) => Promise<void>;
}) {
  const me = useQuery(meQuery);
  const author = row.author.name;
  const mine = row.author.userId === me.data?.user.id;
  const [editing, setEditing] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  function send() {
    if (!onEdit || editing === null || !editing.trim()) return;
    setSending(true);
    void onEdit(editing.trim())
      .then(() => setEditing(null))
      .finally(() => setSending(false));
  }
  return (
    <TranscriptRowFrame
      avatar={
        <Avatar size="sm">
          <AvatarFallback className={cn(mine && "bg-primary text-primary-foreground")}>
            {initialsOf(author)}
          </AvatarFallback>
        </Avatar>
      }
      author={author}
      at={row.postedAt}
      label={`Message from ${author}`}
      note={
        (row.guest || row.quiet || row.author.former) && (
          <>
            {row.author.former && <span>former member</span>}
            {row.guest && <span>Guest</span>}
            {row.quiet && <span>aside</span>}
          </>
        )
      }
      footer={
        editing === null && (
          <RowToolbar
            rowId={row.id}
            text={row.text}
            can={row.can}
            versions={row.versions}
            onEdit={onEdit && (() => setEditing(row.text))}
          />
        )
      }
    >
      {editing !== null ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Edit message"
            value={editing}
            autoFocus
            className="min-h-16 text-sm"
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={sending || !editing.trim() || editing.trim() === row.text}
              onClick={send}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className={cn("flex flex-col gap-2 text-sm", row.quiet && "text-muted-foreground")}>
          {row.command ? (
            <p className="whitespace-pre-wrap">
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                /{row.command.name}
              </code>
              {row.command.args && ` ${row.command.args}`}
            </p>
          ) : (
            <MessageResponse>{row.text}</MessageResponse>
          )}
        </div>
      )}
    </TranscriptRowFrame>
  );
}
