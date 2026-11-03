// Searching thread titles across every space the person can see and the threads shared with them:
// a dialog that lists every thread in its scope until text is typed, grouped as the sidebar groups
// them (those that need the person, working, unread, then by when they were last active), one line
// each, and opens the chosen thread. The threads narrow to all, the active space or the shared
// threads; Tab cycles the scopes. It opens with its shortcut on all the threads, and from the
// sidebar on the active space or the shared threads.

import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { createContext, type ReactNode, use, useCallback, useEffect, useState } from "react";

import { type ThreadSearchResult, threadSearchListSchema } from "@/shared/threads/search.ts";
import { apiClient } from "@/web/api/api-client";
import { SegmentedControl } from "@/web/components/segmented-control";
import { ShortTime } from "@/web/components/time";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { sharedThreadsQuery } from "@/web/guests/queries";
import { useShortcut } from "@/web/lib/shortcuts";
import { useActiveSpace } from "@/web/spaces/active-space";
import { groupOf, grouped } from "@/web/threads/thread-groups";
import { RowLead, rowTitle } from "@/web/threads/thread-row";
import { ThreadTitle } from "@/web/threads/thread-title";

const DEBOUNCE_MS = 200;

type Scope = "all" | "space" | "shared";

// Where the search starts: on all the threads, the active space or the shared threads.
export interface SearchStart {
  scope?: Scope;
}

const OpenSearchContext = createContext<((start?: SearchStart) => void) | null>(null);

// Opens the thread search, on all the threads unless told where.
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

// A found thread on one line: its status, its title, where it is, and how long ago it was active.
function ResultRow({ thread, place }: { thread: ThreadSearchResult; place?: string }) {
  const { status } = thread;
  return (
    <>
      <ThreadTitle thread={thread} className={cn(rowTitle, status === "unread" && "font-medium")} />
      {place && (
        <span title={place} className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">
          {place}
        </span>
      )}
      <ShortTime
        iso={thread.updatedAt}
        className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
      />
      <RowLead thread={thread} status={status} />
    </>
  );
}

function ThreadSearchDialog({ start, onClose }: { start: SearchStart; onClose: () => void }) {
  const navigate = useNavigate();
  const space = useActiveSpace();
  const sharedThreads = useQuery(sharedThreadsQuery);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>(start.scope ?? "all");
  const q = useDebounced(text.trim(), DEBOUNCE_MS);
  const results = useQuery({
    ...threadSearchQuery(q),
    // The last results stay while the next ones load.
    placeholderData: keepPreviousData,
  });
  const inScope = (result: ThreadSearchResult) =>
    scope === "all" || (scope === "shared" ? result.shared : result.spaceId === space?.id);
  const shown = (results.data ?? []).filter(inScope);
  const now = new Date();
  const groups = grouped(shown, (result) => groupOf(result.status, result.updatedAt, now));
  // A thread of another space says which.
  const placeOf = (result: ThreadSearchResult) =>
    result.spaceId !== space?.id ? result.spaceName : undefined;

  // The scopes: All, the active space unless in the shared threads, and the shared threads when
  // there are any.
  const scopes: { scope: Scope; label: string }[] = [
    { scope: "all", label: "All" },
    ...(space ? [{ scope: "space" as const, label: space.name }] : []),
    ...((sharedThreads.data?.length ?? 0) > 0
      ? [{ scope: "shared" as const, label: "Shared with you" }]
      : []),
  ];

  function cycle(step: 1 | -1) {
    const index = scopes.findIndex((s) => s.scope === scope);
    setScope(scopes[(index + step + scopes.length) % scopes.length]!.scope);
  }

  function choose(threadId: string) {
    onClose();
    void navigate({ to: "/t/$threadId", params: { threadId } });
  }

  const empty = !results.isFetched ? "Searching…" : text.trim() ? "Nothing matches." : "No threads";

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
        <CommandInput
          placeholder="Search threads"
          value={text}
          onValueChange={setText}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || scopes.length <= 1) return;
            event.preventDefault();
            cycle(event.shiftKey ? -1 : 1);
          }}
        />
        {scopes.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5">
            <SegmentedControl
              label="Where to search"
              options={scopes.map((option) => ({ value: option.scope, label: option.label }))}
              value={scope}
              onChange={setScope}
            />
          </div>
        )}
        <CommandList>
          <CommandEmpty className="text-muted-foreground">{empty}</CommandEmpty>
          {groups.map(([name, list]) => (
            <CommandGroup key={name} heading={name}>
              {list.map((thread) => (
                <CommandItem
                  key={thread.id}
                  value={thread.id}
                  onSelect={() => choose(thread.id)}
                  className="[--lead-bg:var(--popover)] data-selected:[--lead-bg:var(--muted)]"
                >
                  <ResultRow thread={thread} place={placeOf(thread)} />
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {scopes.length > 1 && "Tab to change scope · "}↑↓ to move · ↵ to open
        </div>
      </Command>
    </CommandDialog>
  );
}

// Holds whether the search is open and where it starts, and opens it with ⌘K.
export function ThreadSearchProvider({ children }: { children: ReactNode }) {
  const [start, setStart] = useState<SearchStart | null>(null);
  const openSearch = useCallback((where: SearchStart = {}) => setStart(where), []);

  useShortcut("search", () => openSearch());

  return (
    <OpenSearchContext value={openSearch}>
      {children}
      {/* Its title and description are in the page even while closed, so it only exists open. */}
      {start && <ThreadSearchDialog start={start} onClose={() => setStart(null)} />}
    </OpenSearchContext>
  );
}
