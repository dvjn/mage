// A space's memory in its settings: the entries the agent saved, by topic, each with the thread
// it came from where the reader may open it, who approved it and when; owners forget them.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { MemoryEntry } from "@/shared/memory.ts";
import { EmptyState } from "@/web/components/page-states";
import { MoreMenu } from "@/web/components/more-menu";
import { Time } from "@/web/components/time";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { byTopic, MemoryTopics } from "@/web/memory/memory-topics";
import { spaceMemoryQuery, useForgetMemory } from "@/web/memory/queries";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";

function Meta({ entry }: { entry: MemoryEntry }) {
  return (
    <>
      {entry.thread && (
        <>
          <Link
            to="/t/$threadId"
            params={{ threadId: entry.thread.id }}
            className="underline-offset-2 hover:underline"
          >
            {entry.thread.title}
          </Link>
          {" · "}
        </>
      )}
      {entry.approvedBy && `Approved by ${entry.approvedBy} · `}
      <Time iso={entry.savedAt} />
    </>
  );
}

export function SpaceMemory({ spaceId }: { spaceId: string }) {
  const memory = useQuery(spaceMemoryQuery(spaceId));
  const forget = useForgetMemory(spaceId);
  const entries = memory.data?.entries ?? [];
  return (
    <>
      <SettingsTitle
        title="Memory"
        description="What the agent saved for this space's later threads."
      />
      <SettingsCard state={memory}>
        {entries.length === 0 ? (
          <EmptyState compact title="Nothing saved" />
        ) : (
          <MemoryTopics
            topics={byTopic(entries)}
            meta={(entry) => <Meta entry={entry} />}
            action={(entry) => (
              <MoreMenu
                row
                name={entry.text}
                empty={!memory.data?.canForget}
                destructive={
                  <DropdownMenuItem variant="destructive" onClick={() => forget.mutate(entry.id)}>
                    Forget
                  </DropdownMenuItem>
                }
              />
            )}
          />
        )}
        <FieldError>{forget.error?.message}</FieldError>
      </SettingsCard>
    </>
  );
}
