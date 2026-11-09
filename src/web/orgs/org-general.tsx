// The organization's general settings: its name, which a team org's owners change, the name its
// agent goes by, which its owners change, a team org's first steps until it has a model provider, the models its threads start with and that name them,
// the agent's instructions in every space, and deleting a team org.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BlocksIcon, UsersIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { AllowPublicArtifacts } from "@/web/artifacts/public-setting";
import { OrgInstructions } from "@/web/instructions/instructions";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { ModelsCard } from "@/web/models/models-card";
import { Button } from "@/web/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { switchOrg } from "@/web/lib/org-tab";
import { meQuery } from "@/web/auth/queries";
import { connectionsQuery } from "@/web/models/queries";
import { agentNameQuery, orgsQuery } from "@/web/orgs/queries";
import { DeleteCard } from "@/web/shell/delete-card";
import { useAgentName, useDeleteOrg, useRenameOrg } from "@/web/orgs/mutations";

// Until a team org can reply, where to start: a model provider, then its people.
function FirstSteps() {
  const connections = useQuery(connectionsQuery);
  if (!connections.data || connections.data.length > 0) return null;
  return (
    <SettingsCard
      title="Get your organization started"
      description="Threads need a model provider to reply, and spaces need people to share them with."
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button render={<Link to="/org/providers" />} nativeButton={false}>
          <BlocksIcon />
          Add a model provider
        </Button>
        <Button variant="outline" render={<Link to="/org/people" />} nativeButton={false}>
          <UsersIcon />
          Invite members
        </Button>
      </div>
    </SettingsCard>
  );
}

// The org's name; a team org's owners rename it.
function OrgName({ name, canManage }: { name: string; canManage: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState(name);
  const rename = useRenameOrg();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    rename.mutate(draft);
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>Organization name</FieldLabel>
          <Input
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={80}
            required
            disabled={!canManage}
            autoComplete="off"
          />
        </Field>
        <FieldError>{rename.error?.message}</FieldError>
        {canManage && draft.trim() !== name && (
          <div>
            <Button type="submit" disabled={rename.isPending || !draft.trim()}>
              Save
            </Button>
          </div>
        )}
      </FieldGroup>
    </form>
  );
}

// The name the agent goes by in the org's threads; its owners change it.
function AgentName({ name, canManage }: { name: string; canManage: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState(name);
  const save = useAgentName();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(draft.trim());
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>Agent name</FieldLabel>
          <Input
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={40}
            required
            disabled={!canManage}
            autoComplete="off"
          />
        </Field>
        <FieldError>{save.error?.message}</FieldError>
        {canManage && draft.trim() !== name && (
          <div>
            <Button type="submit" disabled={save.isPending || !draft.trim()}>
              Save
            </Button>
          </div>
        )}
      </FieldGroup>
    </form>
  );
}

// Deletes a team org once its owner types its name; the tab then opens their personal org.
function DeleteOrg({ name }: { name: string }) {
  const id = useId();
  const orgs = useQuery(orgsQuery);
  const [typed, setTyped] = useState("");
  const deleteOrg = useDeleteOrg();

  function remove() {
    deleteOrg.mutate(undefined, {
      onSuccess: () => {
        const personal = orgs.data?.orgs.find((org) => org.kind === "personal");
        if (personal) switchOrg(personal.id, "/");
        else window.location.assign("/");
      },
    });
  }

  return (
    <DeleteCard
      title="Delete organization"
      description="Deletes the organization and everything in it, for everyone. This cannot be undone."
      confirmTitle={`Delete ${name}?`}
      confirmDescription="This deletes, for everyone and for good: all its spaces and threads, its model providers and their keys, its groups and invites, and guests' access to its threads. Its members keep their accounts."
      action="Delete organization"
      error={deleteOrg.error?.message}
      disabled={typed !== name || deleteOrg.isPending}
      onOpenChange={(open) => {
        if (open) return;
        setTyped("");
        deleteOrg.reset();
      }}
      onConfirm={remove}
    >
      <Field>
        <FieldLabel htmlFor={id}>Type {name} to confirm</FieldLabel>
        <Input
          id={id}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
        />
      </Field>
    </DeleteCard>
  );
}

export function OrgGeneral() {
  const me = useQuery(meQuery);
  const role = me.data?.role;
  const personal = me.data?.org.kind === "personal";
  const team = me.data?.org.kind === "team";
  const owner = team && role === "owner";
  const agentName = useQuery(agentNameQuery);
  return (
    <>
      <SettingsTitle
        title="General"
        description={me.data ? `Settings for everyone in ${me.data.org.name}.` : undefined}
      />
      {team && <FirstSteps />}
      <SettingsCard
        title="Organization"
        description={
          personal
            ? "Your personal organization is named after you and only has you."
            : owner
              ? undefined
              : "Only the organization's owners can rename it."
        }
        state={me}
      >
        {me.data && <OrgName key={me.data.org.name} name={me.data.org.name} canManage={!!owner} />}
      </SettingsCard>
      <SettingsCard
        title="Agent"
        description="Shown in threads. Spaces can choose their own."
        state={agentName}
      >
        {agentName.data && (
          <AgentName
            key={agentName.data.name}
            name={agentName.data.name}
            canManage={role === "owner"}
          />
        )}
      </SettingsCard>
      <ModelsCard canManage={role === "owner"} />
      <OrgInstructions />
      <AllowPublicArtifacts />
      {owner && me.data && <DeleteOrg name={me.data.org.name} />}
    </>
  );
}
