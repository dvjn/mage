// Adds people, or groups, to the org or to a space, in the one dialog: the add-people row, whose
// access choice sits beside the box, with what is picked below it until Add. Where the surface
// takes invites, an email that is nobody found is offered an invite, which makes a link shown once.
// The two wrappers below read what each offers: the org's members and groups for a space, the
// directory's and the org's own for the org.

import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MailIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import * as z from "zod";

import type { CreatedOrgInvite, OrgRole } from "@/shared/orgs.ts";
import type { SpaceRole } from "@/shared/spaces.ts";
import {
  directoryGroupsPages,
  directoryPeoplePages,
  groupsPages,
  membersPages,
} from "@/web/api/list-queries";
import type { Level } from "@/web/components/access-level";
import { CopyField } from "@/web/components/copy-button";
import { Button } from "@/web/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { ResponsiveDialog, ResponsiveDialogContent } from "@/web/components/responsive-dialog";
import { Field, FieldError, FieldLabel } from "@/web/components/ui/field";
import { useDebounced } from "@/web/hooks/use-debounced";
import { plural } from "@/web/lib/plural";
import { AddPeople } from "@/web/sharing/add-people";
import { ORG_ROLE_LEVELS, SPACE_ROLE_LEVELS } from "@/web/sharing/access-level";
import { type SubjectOption, Suggestion } from "@/web/spaces/subject-picker";

const emailSchema = z.email();

// What adding came to: an error to show, a link to copy, or nothing when done.
export interface AddOutcome {
  error?: string;
  invite?: CreatedOrgInvite;
}

export type Target = { option: SubjectOption } | { email: string };

function AddPeopleDialog<T extends string>({
  open,
  onOpenChange,
  title,
  description,
  label,
  levels,
  initial,
  text,
  onTextChange,
  options,
  settled,
  invite,
  canInvite,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  // What the box is for, in the words of whom it finds.
  label: string;
  // What they get, and what is offered first.
  levels: readonly Level<T>[];
  initial: T;
  // The search; the caller reads the suggestions for it and has it cleared when the dialog closes.
  text: string;
  onTextChange: (text: string) => void;
  options: SubjectOption[];
  // The suggestions are for the text.
  settled: boolean;
  // An email found among no one can be invited.
  invite?: boolean;
  // The viewer may invite people to the org, so an empty list points there.
  canInvite?: boolean;
  onAdd: (target: Target, level: T) => Promise<AddOutcome | undefined>;
}) {
  const pickerId = useId();
  const [picked, setPicked] = useState<SubjectOption | null>(null);
  const [level, setLevel] = useState<T>(initial);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedOrgInvite>();
  const email = text.trim().toLowerCase();
  const inviting =
    !!invite &&
    !picked &&
    emailSchema.safeParse(email).success &&
    !options.some((option) => option.email?.toLowerCase() === email);

  function change(next: boolean) {
    onOpenChange(next);
    if (next) return;
    setPicked(null);
    setLevel(initial);
    setError(undefined);
    setCreated(undefined);
    onTextChange("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!picked && !inviting) return;
    setPending(true);
    const outcome = await onAdd(picked ? { option: picked } : { email }, level);
    setPending(false);
    setError(outcome?.error);
    if (outcome?.invite) setCreated(outcome.invite);
    else if (!outcome?.error) change(false);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={change}>
      <ResponsiveDialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite link for {created.email}</DialogTitle>
              <DialogDescription>
                Send it to them yourself. Only an account with this email can use it, once, within 7
                days.
              </DialogDescription>
            </DialogHeader>
            <CopyField label="Invite link" value={created.url} once />
            <DialogFooter>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={pickerId}>{label}</FieldLabel>
              <AddPeople
                id={pickerId}
                text={text}
                onTextChange={onTextChange}
                placeholder={invite ? "Search or enter an email" : "Search"}
                options={options}
                picked={picked}
                onPick={setPicked}
                levels={levels}
                level={level}
                onLevel={setLevel}
                before={
                  inviting && (
                    <Suggestion
                      avatar={{ icon: <MailIcon /> }}
                      name={
                        <>
                          Invite <span className="font-medium">{email}</span>
                        </>
                      }
                    />
                  )
                }
                empty={
                  settled &&
                  options.length === 0 &&
                  !inviting &&
                  (canInvite ? (
                    <>
                      No one else to add.{" "}
                      <Link to="/org/people" className="underline underline-offset-4">
                        Invite someone to the organization
                      </Link>
                    </>
                  ) : (
                    "No one else to add"
                  ))
                }
              />
            </Field>
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={!(picked || inviting) || pending}>
                {picked ? "Add" : "Invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// The org's members, and its groups once it has any.
export function AddPeopleToSpace({
  open,
  onOpenChange,
  title,
  exclude,
  canInvite,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  // Those already in it, as "user:<id>" or "group:<id>"; they are marked and cannot be picked.
  exclude: Set<string>;
  canInvite?: boolean;
  onAdd: (option: SubjectOption, role: SpaceRole) => Promise<string | undefined>;
}) {
  const [text, setText] = useState("");
  const q = useDebounced(text);
  const people = useInfiniteQuery({ ...membersPages({ q }, 20), enabled: open });
  const groups = useInfiniteQuery({ ...groupsPages({ q }, 20), enabled: open });
  // Groups come from a directory; while the org has none, the picker offers people only.
  const anyGroups = useInfiniteQuery({ ...groupsPages({}, 1), enabled: open });
  const withGroups = (anyGroups.data?.pages[0]?.total ?? 0) > 0;
  const options: SubjectOption[] = [
    ...(people.data?.pages[0]?.items ?? []).map((member) => ({
      kind: "user" as const,
      id: member.userId,
      name: member.name,
      detail: member.email,
      email: member.email,
    })),
    ...(withGroups ? (groups.data?.pages[0]?.items ?? []) : []).map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
      detail: `${group.email ? `${group.email} · ` : ""}${plural(group.memberCount, "person", "people")}`,
      ...(group.email && { email: group.email }),
    })),
  ].map((option) =>
    exclude.has(`${option.kind}:${option.id}`) ? { ...option, already: "Added" } : option,
  );
  return (
    <AddPeopleDialog<SpaceRole>
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      label={withGroups ? "Person or group" : "Person"}
      levels={SPACE_ROLE_LEVELS}
      initial="messager"
      text={text}
      onTextChange={setText}
      options={options}
      settled={people.isSuccess}
      {...(canInvite && { canInvite })}
      onAdd={async (target, role) => {
        if (!("option" in target)) return undefined;
        const error = await onAdd(target.option, role);
        return error ? { error } : undefined;
      }}
    />
  );
}

// The directory's people and groups and the org's own members; an email among them is invited.
export function AddPeopleToOrg({
  open,
  onOpenChange,
  directory,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The server is connected to a directory with people or groups in it.
  directory: { people: boolean; groups: boolean };
  onAdd: (target: Target, role: OrgRole) => Promise<AddOutcome | undefined>;
}) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const found = useInfiniteQuery({ ...membersPages({ q }, 6), enabled: open && !!q });
  const people = useInfiniteQuery({
    ...directoryPeoplePages({ q }, 6),
    enabled: open && !!q && directory.people,
  });
  const groups = useInfiniteQuery({
    ...directoryGroupsPages({ q }, 4),
    enabled: open && !!q && directory.groups,
  });
  const fromDirectory = people.data?.pages[0]?.items ?? [];
  const inDirectory = new Set(fromDirectory.map((person) => person.userId));
  const members = (found.data?.pages[0]?.items ?? []).filter(
    (member) => !inDirectory.has(member.userId),
  );
  const options: SubjectOption[] = [
    ...(groups.data?.pages[0]?.items ?? []).map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
      detail: `${group.email ?? "Directory group"} · ${plural(group.memberCount, "person", "people")}`,
      ...(group.email && { email: group.email }),
      ...(group.role && { already: "Added" }),
    })),
    ...fromDirectory.map((person) => ({
      kind: "user" as const,
      id: person.userId,
      name: person.name,
      detail: person.email,
      email: person.email,
      ...(person.role && { already: "Added" }),
    })),
    ...members.map((person) => ({
      kind: "user" as const,
      id: person.userId,
      name: person.name,
      detail: person.email,
      email: person.email,
      already: "Added",
    })),
  ];
  const anyDirectory = directory.people || directory.groups;
  return (
    <AddPeopleDialog<OrgRole>
      open={open}
      onOpenChange={onOpenChange}
      title="Add people"
      description={
        anyDirectory
          ? `Add ${directory.groups ? "people and groups" : "people"} from your directory, or invite someone by their email. Mage sends no emails; you share the link it makes.`
          : "Invite someone by their email. Mage sends no emails; you share the link it makes."
      }
      label={directory.groups ? "Name, email or group" : "Name or email"}
      levels={ORG_ROLE_LEVELS}
      initial="member"
      text={text}
      onTextChange={setText}
      options={options}
      settled={!!q && !!found.data}
      invite
      onAdd={onAdd}
    />
  );
}
