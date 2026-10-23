// A team org's spaces, for its owners: who may make spaces and whether members get a private one,
// then every space in the org. Shared spaces open their settings, where owners change their
// members and defaults, and are deleted while they have no threads; members' private spaces are
// listed with their person, and stay theirs. Reading a space's threads still takes a role in it.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon, LockIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import type { TeamSettings } from "@/shared/orgs.ts";
import type { OrgSpace } from "@/shared/spaces.ts";
import { EmptyState, ListSkeleton, LoadError } from "@/web/components/page-states";
import {
  ActionsCell,
  ContextCell,
  LoadMore,
  PeopleRow,
  PeopleTable,
  SubjectCell,
} from "@/web/components/people-table";
import { SettingsCard, SettingsTitle } from "@/web/components/settings/layout";
import { TableToolbar, useSearchText } from "@/web/components/table-toolbar";
import { Time } from "@/web/components/time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/web/components/ui/alert-dialog";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Switch } from "@/web/components/ui/switch";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { orgSpacesPages } from "@/web/lib/list-queries";
import { meQuery, spacesQuery, teamSettingsQuery } from "@/web/lib/queries";

export interface OrgSpacesSearch {
  q?: string;
  kind?: "shared" | "personal";
  everyone?: "none" | "viewer" | "messager";
}

const orgSpacesRoute = getRouteApi("/_app/org/spaces");

const KIND_FILTER = [
  { value: "shared", label: "Shared" },
  { value: "personal", label: "Private" },
];

const EVERYONE_FILTER = [
  { value: "none", label: "None" },
  { value: "viewer", label: "Viewer" },
  { value: "messager", label: "Messager" },
];

const CREATION_LABELS: Record<TeamSettings["spaceCreation"], string> = {
  members: "Every member",
  owners: "Owners only",
};

const EVERYONE_LABELS = { messager: "Messager", viewer: "Viewer" } as const;

function SpaceSettingsCard() {
  const queryClient = useQueryClient();
  const creationId = useId();
  const switchId = useId();
  const settings = useQuery(teamSettingsQuery);
  const [error, setError] = useState<string>();

  async function change(json: Partial<TeamSettings>) {
    setError(undefined);
    const res = await apiClient.v1.org.settings.$patch({ json });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(teamSettingsQuery.queryKey, (await res.json()) as TeamSettings);
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
  }

  return (
    <SettingsCard title="Settings" state={settings}>
      {settings.data && (
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={creationId}>Who can create spaces</FieldLabel>
              <FieldDescription>Members who can start new shared spaces.</FieldDescription>
            </FieldContent>
            <Select
              value={settings.data.spaceCreation}
              onValueChange={(next) =>
                next && void change({ spaceCreation: next as TeamSettings["spaceCreation"] })
              }
            >
              <SelectTrigger id={creationId} className="w-36 shrink-0">
                <SelectValue>
                  {(value: TeamSettings["spaceCreation"]) => CREATION_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {(Object.keys(CREATION_LABELS) as TeamSettings["spaceCreation"][]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {CREATION_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={switchId}>Private member spaces</FieldLabel>
              <FieldDescription>
                Each member gets a space of their own on joining, which only they can see. Turning
                this off keeps the ones already made.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={switchId}
              checked={settings.data.memberSpaces}
              onCheckedChange={(memberSpaces) => void change({ memberSpaces })}
            />
          </Field>
          <FieldError>{error}</FieldError>
        </FieldGroup>
      )}
    </SettingsCard>
  );
}

function SpacesTable({
  spaces,
  onDelete,
  filtered,
}: {
  spaces: OrgSpace[];
  onDelete: (space: OrgSpace) => void;
  filtered?: { onClear: () => void };
}) {
  const navigate = useNavigate();
  return (
    <PeopleTable
      label="Spaces"
      name="Space"
      columns={[{ label: "Members" }, { label: "Everyone" }, { label: "Created" }]}
      count={spaces.length}
      empty={{ icon: <LayoutGridIcon />, title: "No spaces yet" }}
      {...(filtered && { filtered })}
    >
      {spaces.map((space) => {
        const shared = space.kind === "shared";
        const settings = () =>
          void navigate({ to: "/s/$spaceId/settings", params: { spaceId: space.id } });
        const everyone = shared
          ? space.everyoneRole
            ? EVERYONE_LABELS[space.everyoneRole]
            : "None"
          : "—";
        const memberCount = `${space.memberCount} ${space.memberCount === 1 ? "member" : "members"}`;
        return (
          <PeopleRow key={space.id} label={space.name} {...(shared && { onOpen: settings })}>
            <SubjectCell
              avatar={{ initials: space.name }}
              name={space.name}
              detail={
                shared ? (
                  `Shared${space.ownerName ? ` · made by ${space.ownerName}` : ""}`
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <LockIcon className="size-3" />
                    {space.ownerName && space.name !== `${space.ownerName}'s Space`
                      ? `Private · ${space.ownerName}`
                      : "Private"}
                  </span>
                )
              }
              folded={shared ? `${memberCount} · Everyone: ${everyone}` : undefined}
            />
            <ContextCell className="whitespace-nowrap">{shared ? memberCount : "—"}</ContextCell>
            <ContextCell className="whitespace-nowrap">{everyone}</ContextCell>
            <ContextCell className="whitespace-nowrap">
              <Time iso={space.createdAt} />
            </ContextCell>
            {shared ? (
              <ActionsCell
                label={space.name}
                destructive={
                  space.hasThreads ? (
                    <WithTooltip label="Only a space without threads can be deleted">
                      <div>
                        <DropdownMenuItem variant="destructive" disabled>
                          <Trash2Icon />
                          Delete…
                        </DropdownMenuItem>
                      </div>
                    </WithTooltip>
                  ) : (
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(space)}>
                      <Trash2Icon />
                      Delete…
                    </DropdownMenuItem>
                  )
                }
              >
                <DropdownMenuItem onClick={settings}>
                  <Settings2Icon />
                  Space settings
                </DropdownMenuItem>
              </ActionsCell>
            ) : (
              <ActionsCell label={space.name} />
            )}
          </PeopleRow>
        );
      })}
    </PeopleTable>
  );
}

export function OrgSpaces() {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const owner = me.data?.org.kind === "team" && me.data.role === "owner";
  const navigate = useNavigate();
  const search = orgSpacesRoute.useSearch();
  const spaces = useInfiniteQuery({ ...orgSpacesPages(search), enabled: owner });
  const set = (changes: Partial<OrgSpacesSearch>) =>
    void navigate({
      to: "/org/spaces",
      search: (() => {
        const next: OrgSpacesSearch = { ...search, ...changes };
        return {
          ...(next.q && { q: next.q }),
          ...(next.kind && { kind: next.kind }),
          ...(next.everyone && { everyone: next.everyone }),
        };
      })(),
      replace: true,
    });
  const [text, setText] = useSearchText(search.q ?? "", (q) => set({ q }));
  const filtered = !!(search.q || search.kind || search.everyone);
  const clear = () => set({ q: undefined, kind: undefined, everyone: undefined });
  const rows = spaces.data?.pages.flatMap((page) => page.items) ?? [];
  const [deleting, setDeleting] = useState<OrgSpace | null>(null);
  const [error, setError] = useState<string>();

  async function remove() {
    if (!deleting) return;
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].$delete({ param: { id: deleting.id } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setDeleting(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["org-spaces"] }),
      queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
    ]);
  }

  return (
    <>
      <SettingsTitle
        title="Spaces"
        description="Every space in the organization. Opening a space's settings lets you change its members, including yourself, to read its threads."
      />
      {me.data && !owner ? (
        <EmptyState
          icon={<LayoutGridIcon />}
          title="For the organization's owners"
          description="Only the organization's owners manage all its spaces."
        />
      ) : (
        <>
          <SpaceSettingsCard />
          <TableToolbar
            search={{ label: "Search spaces", value: text, onChange: setText }}
            filters={[
              {
                label: "Kind",
                value: search.kind,
                options: KIND_FILTER,
                onChange: (kind) => set({ kind: kind as OrgSpacesSearch["kind"] }),
              },
              {
                label: "Everyone",
                value: search.everyone,
                options: EVERYONE_FILTER,
                onChange: (everyone) => set({ everyone: everyone as OrgSpacesSearch["everyone"] }),
              },
            ]}
            total={spaces.data?.pages[0]?.total}
            onReset={clear}
          />
          {spaces.error ? (
            <LoadError />
          ) : !spaces.data ? (
            <ListSkeleton />
          ) : (
            <SpacesTable
              spaces={rows}
              onDelete={setDeleting}
              {...(filtered && { filtered: { onClear: clear } })}
            />
          )}
          <LoadMore
            more={!!spaces.hasNextPage}
            loading={spaces.isFetchingNextPage}
            onLoad={() => void spaces.fetchNextPage()}
          />
        </>
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (open) return;
          setDeleting(null);
          setError(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            <FieldError>{error}</FieldError>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
