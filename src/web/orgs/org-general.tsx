// The organization's general settings: its name, which a team org's owners change, a team org's
// first steps until it has a model provider, the models its threads start with and that name them,
// the agent's instructions in every space, and deleting a team org.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BlocksIcon, UsersIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { OrgInstructions } from "@/web/instructions/instructions";
import { SettingsCard, SettingsTitle } from "@/web/settings/layout";
import { ModelsCard } from "@/web/models/models-card";
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
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { switchOrg } from "@/web/lib/org-tab";
import { meQuery } from "@/web/auth/queries";
import { connectionsQuery } from "@/web/models/queries";
import { orgsQuery } from "@/web/orgs/queries";

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
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const res = await apiClient.v1.org.$patch({ json: { name: draft } });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: orgsQuery.queryKey }),
    ]);
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
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
        <FieldError>{error}</FieldError>
        {canManage && draft.trim() !== name && (
          <div>
            <Button type="submit" disabled={pending || !draft.trim()}>
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
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function remove() {
    setPending(true);
    setError(undefined);
    const res = await apiClient.v1.org.$delete();
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const personal = orgs.data?.orgs.find((org) => org.kind === "personal");
    if (personal) switchOrg(personal.id, "/");
    else window.location.assign("/");
  }

  return (
    <SettingsCard
      title="Delete organization"
      description="Deletes the organization and everything in it, for everyone. This cannot be undone."
      footer={
        <AlertDialog
          onOpenChange={(open) => {
            if (open) return;
            setTyped("");
            setError(undefined);
          }}
        >
          <AlertDialogTrigger render={<Button variant="destructive" />}>
            Delete organization
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes, for everyone and for good: all its spaces and threads, its model
                providers and their keys, its groups and invites, and guests&apos; access to its
                threads. Its members keep their accounts.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field>
              <FieldLabel htmlFor={id}>Type {name} to confirm</FieldLabel>
              <Input
                id={id}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <FieldError>{error}</FieldError>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={typed !== name || pending}
                onClick={() => void remove()}
              >
                Delete organization
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}

export function OrgGeneral() {
  const me = useQuery(meQuery);
  const role = me.data?.role;
  const personal = me.data?.org.kind === "personal";
  const team = me.data?.org.kind === "team";
  const owner = team && role === "owner";
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
      <ModelsCard canManage={role === "owner"} />
      <OrgInstructions />
      {owner && me.data && <DeleteOrg name={me.data.org.name} />}
    </>
  );
}
