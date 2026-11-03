// A person's message: an avatar, who wrote it and when, noted when its author was a guest of the
// thread or was removed from its org, then its text as markdown, with a copy button on hover; the
// signed-in person's own rows carry their avatar in the accent colour.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";

import type { HumanRow } from "@/shared/threads/rows.ts";
import { meQuery } from "@/web/auth/queries";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { CopyButton } from "@/web/components/copy-button";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { initialsOf } from "@/web/lib/initials";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";

export function HumanMessage({ row }: { row: HumanRow }) {
  const me = useQuery(meQuery);
  const author = row.author.name;
  const mine = row.author.userId === me.data?.user.id;
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
      actions={<CopyButton label="Copy message" value={row.text} />}
    >
      <div className={cn("flex flex-col gap-2 text-sm", row.quiet && "text-muted-foreground")}>
        <MessageResponse>{row.text}</MessageResponse>
      </div>
    </TranscriptRowFrame>
  );
}
