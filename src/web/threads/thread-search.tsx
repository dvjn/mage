// Searching thread titles across every space the person can see and the threads shared with them,
// or in one folder of the active space: a dialog that lists every thread in its scope until text
// is typed, grouped as the sidebar groups them (those that need the person, working, unread, then
// by when they were last active), one line each, and opens the chosen thread. A folder scope shows
// as a token in the box, which × or Backspace in an empty box clears. Beside the threads, a tab
// lists the active space's folders, and choosing one makes it the scope; Tab switches between
// them. Without a folder, the threads narrow to all, the active space or the shared threads. It
// opens with its shortcut on all the threads, and from the sidebar on a folder, the shared
// threads or the folders.

import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { FolderIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, use, useCallback, useEffect, useState } from "react";

import { statusOf } from "@/shared/thread-status.ts";
import { type ThreadSearchResult, threadSearchListSchema } from "@/shared/threads/search.ts";
import { apiClient } from "@/web/api/api-client";
import { meQuery } from "@/web/auth/queries";
import { SegmentedControl } from "@/web/components/segmented-control";
import { ShortTime } from "@/web/components/time";
import { Badge } from "@/web/components/ui/badge";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { useFolderActivity } from "@/web/folders/folder-activity";
import { sharedThreadsQuery } from "@/web/guests/queries";
import { useShortcut } from "@/web/lib/shortcuts";
import { useActiveSpace } from "@/web/spaces/active-space";
import { groupOf, grouped } from "@/web/threads/thread-groups";
import { RowLead, rowTitle } from "@/web/threads/thread-row";
import { NeedsYouDot, useThreadStatus } from "@/web/threads/thread-status";
import { ThreadTitle } from "@/web/threads/thread-title";

const DEBOUNCE_MS = 200;

type Tab = "threads" | "folders";

type Scope = "all" | "space" | "shared";

// Where the search starts: in a folder of the active space or a scope, and on which tab.
export interface SearchStart {
  folderId?: string;
  scope?: Scope;
  tab?: Tab;
}

const OpenSearchContext = createContext<((start?: SearchStart) => void) | null>(null);

// Opens the thread search, on all the threads unless told where.
export function useOpenThreadSearch() {
  const open = use(OpenSearchContext);
  if (!open) throw new Error("thread search needs its provider");
  return open;
}

function threadSearchQuery(q: string, folder: string | null) {
  return queryOptions({
    queryKey: ["thread-search", q, folder],
    queryFn: async () => {
      const res = await apiClient.v1.threads.search.$get({
        query: { q, ...(folder && { folder }) },
      });
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
  const status = useThreadStatus(thread.activity);
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
  const me = useQuery(meQuery);
  const sharedThreads = useQuery(sharedThreadsQuery);
  const folders = useFolderActivity(space?.role ? space.id : undefined);
  const [text, setText] = useState("");
  const [tab, setTab] = useState<Tab>(start.tab ?? "threads");
  const [folderId, setFolderId] = useState<string | null>(start.folderId ?? null);
  const [scope, setScope] = useState<Scope>(start.scope ?? "all");
  const q = useDebounced(text.trim(), DEBOUNCE_MS);
  const folder = folders.find((f) => f.folder.id === folderId);
  const results = useQuery({
    ...threadSearchQuery(q, folderId),
    // The last results stay while the next ones load.
    placeholderData: keepPreviousData,
  });
  const userId = me.data?.user.id;
  const inScope = (result: ThreadSearchResult) =>
    folderId !== null ||
    scope === "all" ||
    (scope === "shared" ? result.shared : result.spaceId === space?.id);
  const shown = (results.data ?? []).filter(inScope);
  const now = new Date();
  const groups = grouped(shown, (result) =>
    groupOf(userId ? statusOf(result.activity, userId) : "read", result.updatedAt, now),
  );
  const folderNames = new Map(folders.map((f) => [f.folder.id, f.folder.name]));
  const placeOf = (result: ThreadSearchResult) => {
    if (folderId) return undefined;
    if (result.spaceId !== space?.id) return result.spaceName;
    return result.folderId ? folderNames.get(result.folderId) : undefined;
  };
  const needle = text.trim().toLowerCase();
  const folderRows = folders.filter((f) => f.folder.name.toLowerCase().includes(needle));
  // The folders tab is there in a space the person is in.
  const tabs = !!space?.role;

  // The scopes there are without a folder: All, the active space unless in the shared threads, and
  // the shared threads when there are any.
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

  function pickFolder(id: string) {
    setFolderId(id);
    setTab("threads");
    setText("");
  }

  const empty =
    tab === "folders"
      ? needle
        ? "No folder matches."
        : "No folders yet."
      : !results.isFetched
        ? "Searching…"
        : text.trim()
          ? "Nothing matches."
          : "No threads";
  const placeholder =
    tab === "folders"
      ? `Search ${folders.length} folders`
      : folder
        ? `Search ${folder.count} threads`
        : "Search threads";

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
          placeholder={placeholder}
          value={text}
          onValueChange={setText}
          before={
            tab === "threads" &&
            folder && (
              <Badge
                variant="secondary"
                render={<button type="button" onClick={() => setFolderId(null)} />}
                aria-label={`Search all threads, not only ${folder.folder.name}`}
                title={folder.folder.name}
              >
                <span className="max-w-32 truncate">{folder.folder.name}</span>
                <XIcon />
              </Badge>
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Backspace" && text === "" && folderId) {
              event.preventDefault();
              setFolderId(null);
              return;
            }
            if (event.key !== "Tab") return;
            if (tabs) {
              event.preventDefault();
              setTab(tab === "threads" ? "folders" : "threads");
            } else if (scopes.length > 1) {
              event.preventDefault();
              cycle(event.shiftKey ? -1 : 1);
            }
          }}
        />
        {(tabs || (!folder && scopes.length > 1)) && (
          <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5">
            {tabs && (
              <SegmentedControl
                label="Look for"
                options={[
                  { value: "threads", label: `Threads ${folder ? folder.count : shown.length}` },
                  { value: "folders", label: `Folders ${folders.length}` },
                ]}
                value={tab}
                onChange={setTab}
              />
            )}
            {tab === "threads" && !folder && scopes.length > 1 && (
              <SegmentedControl
                label="Where to search"
                options={scopes.map((option) => ({ value: option.scope, label: option.label }))}
                value={scope}
                onChange={setScope}
              />
            )}
          </div>
        )}
        <CommandList>
          <CommandEmpty className="text-muted-foreground">{empty}</CommandEmpty>
          {tab === "threads"
            ? groups.map(([name, list]) => (
                <CommandGroup key={name} heading={name}>
                  {list.map((thread) => (
                    <CommandItem
                      key={thread.id}
                      value={thread.id}
                      onSelect={() => choose(thread.id)}
                    >
                      <ResultRow thread={thread} place={placeOf(thread)} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))
            : folderRows.length > 0 && (
                <CommandGroup>
                  {folderRows.map(({ folder, count, needsYou }) => (
                    <CommandItem
                      key={folder.id}
                      value={`folder:${folder.id}`}
                      onSelect={() => pickFolder(folder.id)}
                    >
                      <FolderIcon className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      {needsYou && <NeedsYouDot />}
                      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
        </CommandList>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {tabs
            ? "Tab to switch threads and folders · "
            : scopes.length > 1 && "Tab to change scope · "}
          ↑↓ to move · ↵ to open
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
