// A space's settings, in pages: General (renaming it, unless it is a person's own space named for
// them, the model and reasoning effort its new threads start with, or the org's, and deleting it
// when it is not the primary space), Members for a shared space, and the agent's Tools there. They
// are there only for those who manage it (its owners, and a team org's owners). A team org's owner
// who manages a space without being in it reads its threads once they give themselves a role in
// it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, Navigate, Outlet, useNavigate } from "@tanstack/react-router";
import { Settings2Icon, UsersIcon, WrenchIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";

import { namedForPerson, type SpaceSummary } from "@/shared/spaces.ts";
import { useMissingModel } from "@/web/components/model-picker";
import { NotFound } from "@/web/components/page-states";
import { SpaceMembers } from "@/web/components/space-members";
import {
  EFFORT_LABELS,
  EffortField,
  modelName,
  ModelField,
} from "@/web/components/settings/default-fields";
import { SettingsCard, SettingsTitle } from "@/web/components/settings/layout";
import { SettingsShell, settingsNavLink } from "@/web/components/settings/settings-nav";
import { SpaceToolsList } from "@/web/components/settings/tools-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/web/components/ui/alert-dialog";
import { Button } from "@/web/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import {
  defaultEffortQuery,
  defaultModelQuery,
  modelsQuery,
  spaceThreadsQuery,
  spacesQuery,
} from "@/web/lib/queries";
import type { Effort } from "@/shared/threads.ts";

const spaceSettingsRoute = getRouteApi("/_app/s/$spaceId/settings");

function SpaceName({ space }: { space: SpaceSummary }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState(space.name);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].$patch({
      param: { id: space.id },
      json: { name },
    });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
  }

  return (
    <SettingsCard title="Name">
      <form onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={id}>Space name</FieldLabel>
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoComplete="off"
            />
          </Field>
          <FieldError>{error}</FieldError>
          {name.trim() !== space.name && (
            <div>
              <Button type="submit" disabled={pending || !name.trim()}>
                Save
              </Button>
            </div>
          )}
        </FieldGroup>
      </form>
    </SettingsCard>
  );
}

// The model and effort the space's new threads start with, or the org's.
function SpaceModel({ space }: { space: SpaceSummary }) {
  const queryClient = useQueryClient();
  const models = useQuery(modelsQuery);
  const orgModel = useQuery(defaultModelQuery);
  const orgEffort = useQuery(defaultEffortQuery);
  const [error, setError] = useState<string>();
  const list = models.data?.models ?? [];

  async function change(json: { model?: string | null; effort?: Effort | null }) {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].defaults.$patch({ param: { id: space.id }, json });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
  }

  const orgModelName = modelName(list, orgModel.data?.ref ?? null) ?? "none picked";
  // While the space's model is turned off or gone, its threads take the org's model and effort.
  const fallingBack = !!useMissingModel(list, space.defaultModel, models.isPending);
  const orgEffortName = orgEffort.data?.effort ? EFFORT_LABELS[orgEffort.data.effort] : "Medium";
  return (
    <SettingsCard
      title="Models"
      description="New threads in this space start with this model and effort. Threads already started keep theirs."
      state={{
        isPending: models.isPending || orgModel.isPending || orgEffort.isPending,
        error: models.error ?? orgModel.error ?? orgEffort.error,
      }}
    >
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <ModelField
            label="Default model"
            models={list}
            value={space.defaultModel}
            onChange={(model) => void change({ model })}
            inherit={{ label: `Default · ${orgModelName}`, ref: orgModel.data?.ref ?? null }}
            fallback={orgModelName}
          />
          <EffortField
            value={fallingBack ? null : space.defaultEffort}
            onChange={(effort) => void change({ effort })}
            defaultLabel={`Default · ${orgEffortName}`}
          />
        </div>
        <FieldError>{error}</FieldError>
      </FieldGroup>
    </SettingsCard>
  );
}

function DeleteSpace({ space }: { space: SpaceSummary }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const threads = useQuery({ ...spaceThreadsQuery(space.id), enabled: space.role !== null });
  const [error, setError] = useState<string>();
  const count = threads.data?.length ?? 0;

  async function remove() {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].$delete({ param: { id: space.id } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await navigate({ to: "/" });
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
  }

  return (
    <SettingsCard
      title="Delete space"
      description={
        count > 0
          ? `It has ${count} ${count === 1 ? "thread" : "threads"}; only a space without threads can be deleted.`
          : "Only a space without threads can be deleted."
      }
      footer={
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" disabled={count > 0} />}>
            Delete space
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {space.name}?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    >
      {error && <FieldError>{error}</FieldError>}
    </SettingsCard>
  );
}

// The space whose settings are open, once the spaces are read.
function useSettingsSpace() {
  const { spaceId } = spaceSettingsRoute.useParams();
  const spaces = useQuery(spacesQuery);
  return { spaceId, spaces, space: spaces.data?.find((s) => s.id === spaceId) };
}

// The space's settings pages, with the list of them beside the one open. Only those who manage
// the space have them; for anyone else they are not there.
export function SpaceSettingsShell() {
  const { spaceId, spaces, space } = useSettingsSpace();

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  if (spaces.isSuccess && !space) return <NotFound what="space" id={spaceId} />;
  if (space && !space.manage) return <NotFound what="space" />;

  const params = { spaceId };
  return (
    <SettingsShell
      crumbs={[
        { label: space?.name ?? "", link: { to: "/s/$spaceId", params } },
        { label: "Settings" },
      ]}
      label="Space settings"
      links={
        <>
          <li className="shrink-0">
            <Link
              to="/s/$spaceId/settings"
              params={params}
              activeOptions={{ exact: true }}
              className={settingsNavLink}
            >
              <Settings2Icon className="size-4" />
              General
            </Link>
          </li>
          {space?.kind === "shared" && (
            <li className="shrink-0">
              <Link to="/s/$spaceId/settings/members" params={params} className={settingsNavLink}>
                <UsersIcon className="size-4" />
                Members
              </Link>
            </li>
          )}
          <li className="shrink-0">
            <Link to="/s/$spaceId/settings/tools" params={params} className={settingsNavLink}>
              <WrenchIcon className="size-4" />
              Tools
            </Link>
          </li>
        </>
      }
    >
      {space && <Outlet />}
    </SettingsShell>
  );
}

// Its name, unless it is a person's own space named for them, the model and effort its new
// threads start with, and deleting it when it is not the primary space.
export function SpaceGeneral() {
  const { space } = useSettingsSpace();
  if (!space) return null;
  return (
    <>
      <SettingsTitle
        title="General"
        description={`Settings for ${space.name} and the threads in it.`}
      />
      {!namedForPerson(space) && <SpaceName key={space.id} space={space} />}
      <SpaceModel space={space} />
      {!space.primary && <DeleteSpace space={space} />}
    </>
  );
}

// Who is in a shared space; a personal space has no members to set, so it opens General.
export function SpaceMembersPage() {
  const { spaceId, space } = useSettingsSpace();
  if (!space) return null;
  if (space.kind !== "shared") return <Navigate to="/s/$spaceId/settings" params={{ spaceId }} />;
  return (
    <>
      <SettingsTitle title="Members" description={`Who is in ${space.name}.`} />
      <SpaceMembers space={space} />
    </>
  );
}

// The agent's tools in the space's threads.
export function SpaceTools() {
  const { space } = useSettingsSpace();
  if (!space) return null;
  return (
    <>
      <SettingsTitle
        title="Tools"
        description="The tools the agent can use in this space, and whether each runs, asks first, or is off. The organization sets the loosest each can be."
      />
      <SpaceToolsList spaceId={space.id} />
    </>
  );
}
