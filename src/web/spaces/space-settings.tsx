// A space's settings, in pages: General (renaming it, unless it is a person's own space named for
// them, the model and reasoning effort its new threads start with, or the org's, and deleting it
// when it is not the primary space, or with its threads when it is a team member's own, and the
// agent's instructions there), Members for a shared space,
// the agent's Tools and MCPs there, with one table of MCP servers, the org's that the space may
// turn off for itself beside its own, and a page for each of its own, and its Skills. They are
// there only for those who manage it (its owners, and a team org's owners). A team org's owner who manages a space without being in it reads its threads once
// they give themselves a role in it.

import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, Navigate, Outlet, useNavigate } from "@tanstack/react-router";
import { Settings2Icon, FileTextIcon, UsersIcon, WrenchIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";

import { namedForPerson, type SpaceSummary } from "@/shared/spaces.ts";
import { useMissingModel } from "@/web/models/model-picker";
import { SpaceMembers } from "@/web/spaces/space-members";
import { EFFORT_LABELS, EffortField, modelName, ModelField } from "@/web/models/default-fields";
import { SpaceInstructions } from "@/web/instructions/instructions";
import { SpaceSkills } from "@/web/skills/pages";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { SettingsShell, settingsNavLink } from "@/web/shell/settings-shell";
import { McpServerPage } from "@/web/mcp/servers/page";
import { McpServersCard } from "@/web/mcp/servers/card";
import { SpaceToolsList } from "@/web/agent/tools-list";
import { Button } from "@/web/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { rememberSpace } from "@/web/spaces/last-space";
import { defaultEffortQuery, defaultModelQuery, modelsQuery } from "@/web/models/queries";
import { spacesQuery } from "@/web/spaces/queries";
import { spaceThreadsQuery } from "@/web/threads/queries";
import { NotFound } from "@/web/shell/not-found";
import { DeleteCard } from "@/web/shell/delete-card";
import { meQuery } from "@/web/auth/queries";
import { ownSpaceGoes } from "@/web/spaces/delete-own-space";
import { useDeleteSpace, useRenameSpace, useSpaceDefaults } from "@/web/spaces/mutations";

const spaceSettingsRoute = getRouteApi("/_app/s/$spaceId/settings");

function SpaceName({ space }: { space: SpaceSummary }) {
  const id = useId();
  const [name, setName] = useState(space.name);
  const rename = useRenameSpace(space.id);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    rename.mutate(name);
  }

  return (
    <SettingsCard title="Name">
      <form onSubmit={submit}>
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
          <FieldError>{rename.error?.message}</FieldError>
          {name.trim() !== space.name && (
            <div>
              <Button type="submit" disabled={rename.isPending || !name.trim()}>
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
  const models = useQuery(modelsQuery);
  const orgModel = useQuery(defaultModelQuery);
  const orgEffort = useQuery(defaultEffortQuery);
  const defaults = useSpaceDefaults(space.id);
  const list = models.data?.models ?? [];

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
            onChange={(model) => defaults.mutate({ model })}
            inherit={{ label: `Default · ${orgModelName}`, ref: orgModel.data?.ref ?? null }}
            fallback={orgModelName}
          />
          <EffortField
            value={fallingBack ? null : space.defaultEffort}
            onChange={(effort) => defaults.mutate({ effort })}
            defaultLabel={`Default · ${orgEffortName}`}
          />
        </div>
        <FieldError>{defaults.error?.message}</FieldError>
      </FieldGroup>
    </SettingsCard>
  );
}

// A team org member's own space goes to trash with its threads; any other is deleted once it has
// none.
function DeleteSpace({ space, own }: { space: SpaceSummary; own: boolean }) {
  const navigate = useNavigate();
  const threads = useQuery({ ...spaceThreadsQuery(space.id), enabled: space.role !== null });
  const remove = useDeleteSpace(() => navigate({ to: "/" }));
  const count = threads.data?.total ?? 0;

  return (
    <DeleteCard
      title="Delete space"
      description={
        own
          ? "It goes to trash with its threads."
          : count > 0
            ? `It has ${count} ${count === 1 ? "thread" : "threads"}; only a space without threads can be deleted.`
            : "Only a space without threads can be deleted."
      }
      blocked={!own && count > 0}
      confirmTitle={`Delete ${space.name}?`}
      confirmDescription={own ? ownSpaceGoes(count) : "This cannot be undone."}
      action="Delete"
      error={remove.error?.message}
      disabled={remove.isPending}
      onConfirm={() => remove.mutate(space.id)}
    />
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
              Tools and MCPs
            </Link>
          </li>
          <li className="shrink-0">
            <Link to="/s/$spaceId/settings/skills" params={params} className={settingsNavLink}>
              <FileTextIcon className="size-4" />
              Skills
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
// threads start with, and deleting it when it is not the primary space, or with its threads when
// it is a team member's own.
export function SpaceGeneral() {
  const { space } = useSettingsSpace();
  const me = useQuery(meQuery);
  if (!space) return null;
  const own = me.data?.org.kind === "team" && space.kind === "personal";
  return (
    <>
      <SettingsTitle
        title="General"
        description={`Settings for ${space.name} and the threads in it.`}
      />
      {!namedForPerson(space) && <SpaceName key={space.id} space={space} />}
      <SpaceModel space={space} />
      <SpaceInstructions spaceId={space.id} spaceName={space.name} />
      {(own || !space.primary) && <DeleteSpace space={space} own={own} />}
    </>
  );
}

// Who is in a shared space; a personal space has no members to set, so it opens General.
export function SpaceMembersPage() {
  const { spaceId, space } = useSettingsSpace();
  if (!space) return null;
  if (space.kind !== "shared") return <Navigate to="/s/$spaceId/settings" params={{ spaceId }} />;
  return <SpaceMembers space={space} />;
}

// The skills the agent has in the space's threads.
export function SpaceSkillsPage() {
  const { space } = useSettingsSpace();
  if (!space) return null;
  return <SpaceSkills spaceId={space.id} />;
}

// The agent's tools in the space's threads.
export function SpaceTools() {
  const { space } = useSettingsSpace();
  if (!space) return null;
  return (
    <>
      <SettingsTitle
        title="Tools and MCPs"
        description="What the agent can use in this space, and who has to approve it."
      />
      <SpaceToolsList
        spaceId={space.id}
        mcp={(toolsets) => (
          <McpServersCard
            scope={{ kind: "space", spaceId: space.id }}
            toolsets={toolsets}
            canManage
          />
        )}
      />
    </>
  );
}

const spaceServerRoute = getRouteApi("/_app/s/$spaceId/settings/tools/mcp/$serverId");

export function SpaceMcpServer() {
  const { spaceId, serverId } = spaceServerRoute.useParams();
  return <McpServerPage scope={{ kind: "space", spaceId }} serverId={serverId} />;
}
