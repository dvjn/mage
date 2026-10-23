// Searching thread titles across every space the person can see and the threads shared with them:
// a dialog whose scope tabs (all, the active space, the shared threads; Tab cycles them) narrow the
// results, grouped by space when all are shown, that opens the chosen thread. It opens from the
// sidebar or with its shortcut, always on all.

import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, use, useCallback, useEffect, useState } from "react";

import { SegmentedControl } from "@/web/components/segmented-control";
import { ThreadTitle } from "@/web/components/thread-title";
import { Button } from "@/web/components/ui/button";
import { useActiveSpace } from "@/web/lib/active-space";

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
import { sharedThreadsQuery } from "@/web/lib/queries";
import { useShortcut } from "@/web/lib/shortcuts";

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

// Results by space, the shared ones last, together, each with its host space named.
type Scope = "all" | "space" | "shared";

// Results grouped for All: the active space first, then the others, then the shared ones.
function groupsOf(results: ThreadSearchResult[], spaceId: string | undefined) {
  const groups = new Map<string, { name: string; threads: ThreadSearchResult[] }>();
  if (spaceId) groups.set(spaceId, { name: "", threads: [] });
  const shared: ThreadSearchResult[] = [];
  for (const result of results) {
    if (result.shared) {
      shared.push(result);
      continue;
    }
    const group = groups.get(result.spaceId) ?? { name: result.spaceName, threads: [] };
    group.name = result.spaceName;
    group.threads.push(result);
    groups.set(result.spaceId, group);
  }
  if (shared.length > 0) groups.set("shared", { name: "Shared with you", threads: shared });
  return [...groups.entries()].filter(([, group]) => group.threads.length > 0);
}

function ThreadSearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const space = useActiveSpace();
  const sharedThreads = useQuery(sharedThreadsQuery);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const q = useDebounced(text.trim(), DEBOUNCE_MS);
  const results = useQuery({
    ...threadSearchQuery(q),
    enabled: q.length > 0,
    // The last results stay while the next ones load.
    placeholderData: keepPreviousData,
  });
  const all = text.trim() ? (results.data ?? []) : [];
  const inScope = (result: ThreadSearchResult, which: Scope) =>
    which === "all" || (which === "shared" ? result.shared : result.spaceId === space?.id);
  const shown = all.filter((result) => inScope(result, scope));

  // The scopes there are: All, the active space unless in the shared threads, and the shared
  // threads when there are any.
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

  const label = scopes.find((s) => s.scope === scope)?.label ?? "All";
  const empty = !text.trim()
    ? scope === "all"
      ? "Type to search thread titles in all your spaces and threads shared with you."
      : `Type to search thread titles in ${label}.`
    : !results.isFetched
      ? "Searching…"
      : `No thread in ${scope === "all" ? "any of your spaces" : label} matches.`;

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
            if (event.key !== "Tab" || scopes.length < 2) return;
            event.preventDefault();
            cycle(event.shiftKey ? -1 : 1);
          }}
        />
        {scopes.length > 1 && (
          <div className="border-b px-2 py-1.5">
            <SegmentedControl
              label="Where to search"
              options={scopes.map((option) => ({ value: option.scope, label: option.label }))}
              value={scope}
              onChange={setScope}
            />
          </div>
        )}
        <CommandList>
          <CommandEmpty className="flex flex-col items-center gap-2 text-muted-foreground">
            {empty}
            {scope !== "all" && shown.length === 0 && all.length > 0 && (
              <Button size="xs" variant="outline" onClick={() => setScope("all")}>
                Search all spaces
              </Button>
            )}
          </CommandEmpty>
          {scope === "all"
            ? groupsOf(shown, space?.id).map(([key, group]) => (
                <CommandGroup key={key} heading={group.name}>
                  {group.threads.map((thread) => (
                    <CommandItem
                      key={thread.id}
                      value={thread.id}
                      onSelect={() => choose(thread.id)}
                    >
                      <ThreadTitle thread={thread} className="truncate" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))
            : shown.length > 0 && (
                <CommandGroup>
                  {shown.map((thread) => (
                    <CommandItem
                      key={thread.id}
                      value={thread.id}
                      onSelect={() => choose(thread.id)}
                    >
                      <ThreadTitle thread={thread} className="truncate" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
        </CommandList>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {scopes.length > 1 && "Tab to change scope · "}↑↓ to move · ↵ to open
        </div>
      </Command>
    </CommandDialog>
  );
}

// Holds whether the search is open, and opens it with ⌘K.
export function ThreadSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);

  useShortcut("search", openSearch);

  return (
    <OpenSearchContext value={openSearch}>
      {children}
      {/* Its title and description are in the page even while closed, so it only exists open. */}
      {open && <ThreadSearchDialog onClose={() => setOpen(false)} />}
    </OpenSearchContext>
  );
}
