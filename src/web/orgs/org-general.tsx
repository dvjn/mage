// The organization's general settings: its name, which a team org's owners change, the name its
// agent goes by, which its owners change, a team org's first steps until it has a model provider, the models its threads start with and that name them,
// the agent's instructions in every space, and deleting a team org.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BlocksIcon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";

import { AllowPublicArtifacts } from "@/web/artifacts/public-setting";
import { OrgInstructions } from "@/web/instructions/instructions";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { ModelsCard } from "@/web/models/models-card";
import { Button } from "@/web/components/ui/button";
import { Field, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { switchOrg } from "@/web/lib/org-tab";
import { meQuery } from "@/web/auth/queries";
import { connectionsQuery } from "@/web/models/queries";
import { agentNameQuery, orgsQuery } from "@/web/orgs/queries";
import { NameSettingField } from "@/web/shell/name-setting-field";
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
  const rename = useRenameOrg();
  return (
    <NameSettingField
      label="Organization name"
      saved={name}
      onSave={rename.mutate}
      pending={rename.isPending}
      error={rename.error?.message}
      maxLength={80}
      readOnly={!canManage}
    />
  );
}

// The name the agent goes by in the org's threads; its owners change it.
function AgentName({ name, canManage }: { name: string; canManage: boolean }) {
  const save = useAgentName();
  return (
    <NameSettingField
      label="Agent name"
      saved={name}
      onSave={save.mutate}
      pending={save.isPending}
      error={save.error?.message}
      maxLength={40}
      readOnly={!canManage}
    />
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
        title="Name"
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
