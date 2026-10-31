// Long lists read from the server, searched and narrowed there: page after page for the org's
// members, a member's groups, its groups and a group's members, and the directory's people and
// groups; by page number for the tables of the org's people, groups and invites, its spaces, a
// space's members, a space's threads and the threads shared with you; and one member or group at a
// glance. Every list keeps showing its last rows while the next page, search or filter is read.

import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
} from "@tanstack/react-query";

import { sharedThreadSchema } from "@/shared/guests.ts";
import {
  directoryGroupPageSchema,
  directoryPersonPageSchema,
  groupMemberPageSchema,
  groupPageSchema,
  groupSchema,
  orgMemberPageSchema,
  orgMemberSchema,
  type OrgRole,
  orgPersonPageSchema,
} from "@/shared/orgs.ts";
import { type Page, pageSchema } from "@/shared/paging.ts";
import { orgSpacePageSchema, spaceMembersSchema } from "@/shared/spaces.ts";
import { threadListItemSchema } from "@/shared/threads/list.ts";
import { apiClient } from "@/web/api/api-client";
import { pageQueryOf } from "@/web/lib/data-table";

// The query string of a page: the text, filters set, the limit and the cursor.
function queryOf(
  filters: Record<string, string | undefined>,
  cursor: string | null,
  limit?: number,
) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) if (value) query[key] = value;
  if (cursor) query.cursor = cursor;
  if (limit) query.limit = String(limit);
  return query;
}

// A list read page by page; `limit` is for small lists, such as a glance.
function pages<T extends { nextCursor: string | null }>(
  key: readonly unknown[],
  read: (query: Record<string, string>) => Promise<T>,
  filters: Record<string, string | undefined>,
  limit?: number,
) {
  return infiniteQueryOptions({
    queryKey: [...key, filters, limit ?? null],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => read(queryOf(filters, pageParam, limit)),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

async function json<T>(res: Response, parse: (body: unknown) => T, what: string) {
  if (!res.ok) throw new Error(`could not read ${what}`);
  return parse(await res.json());
}

export function membersPages(filters: { q?: string; role?: OrgRole }, limit?: number) {
  return pages(
    ["org-members"],
    async (query) =>
      json(
        await apiClient.v1.org.members.$get({ query }),
        (body) => orgMemberPageSchema.parse(body),
        "the members",
      ),
    filters,
    limit,
  );
}

export function memberQuery(userId: string) {
  return queryOptions({
    queryKey: ["org-members", "one", userId],
    queryFn: async () =>
      json(
        await apiClient.v1.org.members[":userId"].$get({ param: { userId } }),
        (body) => orgMemberSchema.parse(body),
        "the member",
      ),
  });
}

export function memberGroupsPages(userId: string, filters: { q?: string }, limit?: number) {
  return pages(
    ["org-groups", "of", userId],
    async (query) =>
      json(
        await apiClient.v1.org.members[":userId"].groups.$get({ param: { userId }, query }),
        (body) => groupPageSchema.parse(body),
        "their groups",
      ),
    filters,
    limit,
  );
}

// A table's page, read again while it shows the last one read.
function tablePage<T>(
  key: readonly unknown[],
  read: (query: Record<string, string>) => Promise<T>,
) {
  return (search: Record<string, string | number | undefined>) =>
    queryOptions({
      queryKey: [...key, "page", search],
      queryFn: () => read(pageQueryOf(search)),
      placeholderData: keepPreviousData,
    });
}

// The org's people: for its owners, the invites not yet used first, then its linked groups and its
// members.
export const peoplePage = tablePage(["org-people"], async (query) =>
  json(
    await apiClient.v1.org.people.$get({ query }),
    (body) => orgPersonPageSchema.parse(body),
    "the people",
  ),
);

export function groupsPages(filters: { q?: string }, limit?: number) {
  return pages(
    ["org-groups"],
    async (query) =>
      json(
        await apiClient.v1.org.groups.$get({ query }),
        (body) => groupPageSchema.parse(body),
        "the groups",
      ),
    filters,
    limit,
  );
}

export function groupQuery(groupId: string) {
  return queryOptions({
    queryKey: ["org-groups", "one", groupId],
    queryFn: async () =>
      json(
        await apiClient.v1.org.groups[":id"].$get({ param: { id: groupId } }),
        (body) => groupSchema.parse(body),
        "the group",
      ),
  });
}

export function groupMembersPages(groupId: string, filters: { q?: string }, limit?: number) {
  return pages(
    ["org-groups", "members", groupId],
    async (query) =>
      json(
        await apiClient.v1.org.groups[":id"].members.$get({ param: { id: groupId }, query }),
        (body) => groupMemberPageSchema.parse(body),
        "the group's members",
      ),
    filters,
    limit,
  );
}

// The directory's people, with their role in the org, for its owners to add.
export function directoryPeoplePages(filters: { q?: string }, limit?: number) {
  return pages(
    ["directory", "people"],
    async (query) =>
      json(
        await apiClient.v1.directory.people.$get({ query }),
        (body) => directoryPersonPageSchema.parse(body),
        "the directory's people",
      ),
    filters,
    limit,
  );
}

// The directory's groups, with the role each is linked to the org with, for its owners to link.
export function directoryGroupsPages(filters: { q?: string }, limit?: number) {
  return pages(
    ["directory", "groups"],
    async (query) =>
      json(
        await apiClient.v1.directory.groups.$get({ query }),
        (body) => directoryGroupPageSchema.parse(body),
        "the directory's groups",
      ),
    filters,
    limit,
  );
}

export const orgSpacesPage = tablePage(["org-spaces"], async (query) =>
  json(
    await apiClient.v1.org.spaces.$get({ query }),
    (body) => orgSpacePageSchema.parse(body),
    "the organization's spaces",
  ),
);

// The space's members; each page also says who everyone is and what they get.
export function spaceMembersPage(spaceId: string) {
  return tablePage(["space-members", spaceId], async (query) =>
    json(
      await apiClient.v1.spaces[":id"].members.$get({ param: { id: spaceId }, query }),
      (body) => spaceMembersSchema.parse(body),
      "who is in the space",
    ),
  );
}

const threadPageSchema = pageSchema(threadListItemSchema);
const sharedThreadPageSchema = pageSchema(sharedThreadSchema);

// The space's threads, most recently active first.
export function spaceThreadsPage(spaceId: string) {
  return tablePage(["thread-pages", spaceId], async (query) =>
    json(
      await apiClient.v1.spaces[":id"].threads.page.$get({ param: { id: spaceId }, query }),
      (body) => threadPageSchema.parse(body),
      "the space's threads",
    ),
  );
}

// The threads shared with the signed-in person, most recently active first.
export const sharedThreadsPage = tablePage(["thread-pages", "shared"], async (query) =>
  json(
    await apiClient.v1["shared-threads"].page.$get({ query }),
    (body) => sharedThreadPageSchema.parse(body),
    "the threads shared with you",
  ),
);

export type PagesOptions<T> = ReturnType<typeof pages<Page<T>>>;

// A list's rows so far, how many match in all, and reading the next page.
export function usePages<T>(options: PagesOptions<T>) {
  const list = useInfiniteQuery(options);
  return {
    items: list.data?.pages.flatMap((page) => page.items) ?? [],
    total: list.data?.pages[0]?.total,
    pending: list.isPending,
    error: list.error,
    more: !!list.hasNextPage,
    loading: list.isFetchingNextPage,
    loadMore: () => void list.fetchNextPage(),
  };
}
