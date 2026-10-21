// Searching thread titles across every space the person can see: a dialog of results grouped by
// space that opens the chosen thread, opened from the sidebar.

import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, use, useCallback, useEffect, useState } from "react";

import { type ThreadSearchResult, threadSearchListSchema } from "@/shared/threads.ts";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { apiClient } from "@/web/lib/api-client";

const DEBOUNCE_MS = 200;

const OpenSearchContext = createContext<(() => void) | null>(null);

// Opens the thread search.
export function useOpenThreadSearch() {
  const open = use(OpenSearchContext);
  if (!open) throw new Error("thread search needs its provider");
  return open;
}

function threadSearchQuery(q: string) {
  return queryOptions({
    queryKey: ["thread-search", q],
    queryFn: async () => {
      const res = await apiClient.v1.threads.search.$get({ query: { q } });
      if (!res.ok) throw new Error("could not search the threads");
      return threadSearchListSchema.parse(await res.json());
    },
  });
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function bySpace(results: ThreadSearchResult[]) {
  const groups = new Map<string, { name: string; threads: ThreadSearchResult[] }>();
  for (const result of results) {
    const group = groups.get(result.spaceId) ?? { name: result.spaceName, threads: [] };
    group.threads.push(result);
    groups.set(result.spaceId, group);
  }
  return [...groups.entries()];
}

function ThreadSearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), DEBOUNCE_MS);
  const results = useQuery({
    ...threadSearchQuery(q),
    enabled: q.length > 0,
    // The last results stay while the next ones load.
    placeholderData: keepPreviousData,
  });
  const shown = text.trim() ? (results.data ?? []) : [];

  function choose(threadId: string) {
    onClose();
    void navigate({ to: "/t/$threadId", params: { threadId } });
  }

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Search threads"
      description="Find a thread by its title in any of your spaces."
    >
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search threads…" value={text} onValueChange={setText} />
        <CommandList>
          <CommandEmpty className="text-muted-foreground">
            {!text.trim()
              ? "Type to search thread titles in all your spaces."
              : results.isFetched
                ? "No thread matches."
                : "Searching…"}
          </CommandEmpty>
          {bySpace(shown).map(([spaceId, group]) => (
            <CommandGroup key={spaceId} heading={group.name}>
              {group.threads.map((thread) => (
                <CommandItem key={thread.id} value={thread.id} onSelect={() => choose(thread.id)}>
                  <span className="truncate">{thread.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// Holds whether the search is open.
export function ThreadSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);

  return (
    <OpenSearchContext value={openSearch}>
      {children}
      {/* Its title and description are in the page even while closed, so it only exists open. */}
      {open && <ThreadSearchDialog onClose={() => setOpen(false)} />}
    </OpenSearchContext>
  );
}
