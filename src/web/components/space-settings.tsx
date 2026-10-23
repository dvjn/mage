// A space's settings: renaming it, the model and reasoning effort its new threads start with, or the
// org's, who is in a shared space, and deleting it when it is not the primary space. Only those who
// manage it (its owners, and a team org's owners) may change them; everyone else sees them. A team
// org's owner who manages a space without being in it reads its threads once they give themselves
// a role in it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";

import type { SpaceSummary } from "@/shared/spaces.ts";
import { useMissingModel } from "@/web/components/model-picker";
import { NotFound } from "@/web/components/page-states";
import { SpaceMembers } from "@/web/components/space-members";
import {
  EFFORT_LABELS,
  EffortField,
  modelName,
  ModelField,
} from "@/web/components/settings/default-fields";
import { SettingsCard, SettingsPage } from "@/web/components/settings/layout";
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
  const owner = space.manage;

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
    <SettingsCard
      title="General"
      description={owner ? undefined : "Only the space's owner can change its settings."}
    >
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
              disabled={!owner}
              autoComplete="off"
            />
          </Field>
          <FieldError>{error}</FieldError>
          {owner && name.trim() !== space.name && (
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
  const owner = space.manage;
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
      description={
        owner
          ? "New threads in this space start with this model and effort. Threads already started keep theirs."
          : "Only the space's owner can change what its new threads start with."
      }
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
            disabled={!owner}
          />
          <EffortField
            value={fallingBack ? null : space.defaultEffort}
            onChange={(effort) => void change({ effort })}
            defaultLabel={`Default · ${orgEffortName}`}
            disabled={!owner}
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

export function SpaceSettings() {
  const { spaceId } = spaceSettingsRoute.useParams();
  const spaces = useQuery(spacesQuery);
  const space = spaces.data?.find((s) => s.id === spaceId);

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  if (spaces.isSuccess && !space) return <NotFound what="space" id={spaceId} />;

  return (
    <SettingsPage
      crumbs={[
        { label: space?.name ?? "", link: { to: "/s/$spaceId", params: { spaceId } } },
        { label: "Settings" },
      ]}
      title="Space settings"
      description={space ? `Settings for ${space.name} and the threads in it.` : undefined}
    >
      {space && (
        <>
          <SpaceName key={space.id} space={space} />
          <SpaceModel space={space} />
          {space.kind === "shared" && <SpaceMembers space={space} />}
          {space.manage && !space.primary && <DeleteSpace space={space} />}
        </>
      )}
    </SettingsPage>
  );
}
