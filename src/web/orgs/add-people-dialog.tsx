// Adds people to a team org from the directory, or invites them by email with a link shown once,
// and links the directory's groups with a role.

import { useInfiniteQuery } from "@tanstack/react-query";
import { MailIcon } from "lucide-react";
import { useId, useState } from "react";
import * as z from "zod";

import { type CreatedOrgInvite, ORG_ROLE_LABELS, type OrgRole } from "@/shared/orgs.ts";
import { directoryGroupsPages, directoryPeoplePages, membersPages } from "@/web/api/list-queries";
import { CopyButton } from "@/web/components/copy-button";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { FieldError, FieldLabel } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { useDebounced } from "@/web/hooks/use-debounced";
import { plural } from "@/web/lib/plural";
import { useOrgAdd } from "@/web/orgs/mutations";
import { OrgRoleSelect } from "@/web/orgs/role-select";
import { type SubjectOption, Suggestion, SubjectPicker } from "@/web/spaces/subject-picker";

const emailSchema = z.email();

// Adds people to the org. The text searches the directory's groups and people and who is in the
// org already; a group or person picked from the directory is linked or added with a role, and an
// email not among them can be invited with a role, which makes a link shown once. Without a
// directory, everyone is added by inviting their email.
export function AddPeopleDialog({
  open,
  onOpenChange,
  directory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The server is connected to a directory with people or groups in it.
  directory: { people: boolean; groups: boolean };
}) {
  const inputId = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const [role, setRole] = useState<OrgRole>("member");
  const [picked, setPicked] = useState<SubjectOption | null>(null);
  const [created, setCreated] = useState<CreatedOrgInvite>();
  const add = useOrgAdd();
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
  const matches = (found.data?.pages[0]?.items ?? []).filter(
    (member) => !inDirectory.has(member.userId),
  );
  const groupMatches = groups.data?.pages[0]?.items ?? [];
  const email = text.trim().toLowerCase();
  const isEmail = emailSchema.safeParse(email).success;
  const known = [...matches, ...fromDirectory].find(
    (person) => person.email.toLowerCase() === email,
  );
  const inviting = !picked && isEmail && !known;
  const nothing =
    !!q &&
    !isEmail &&
    !!found.data &&
    matches.length === 0 &&
    fromDirectory.length === 0 &&
    groupMatches.length === 0;
  const anyDirectory = directory.people || directory.groups;
  const options: SubjectOption[] = [
    ...groupMatches.map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
      detail: `Directory group · ${plural(group.memberCount, "person", "people")}`,
      ...(group.role && { already: `Linked as ${ORG_ROLE_LABELS[group.role].toLowerCase()}` }),
    })),
    ...fromDirectory.map((person) => ({
      kind: "user" as const,
      id: person.userId,
      name: person.name,
      detail: person.email,
      ...(person.role && { already: "Already a member" }),
    })),
    ...matches.map((person) => ({
      kind: "user" as const,
      id: person.userId,
      name: person.name,
      detail: person.email,
      already: "Already a member",
    })),
  ];

  function change(next: boolean) {
    onOpenChange(next);
    if (next) return;
    setText("");
    setCreated(undefined);
    add.reset();
    setRole("member");
    setPicked(null);
  }

  function submit() {
    add.mutate(picked ? { kind: picked.kind, id: picked.id, role } : { email, role }, {
      onSuccess: (invite) => {
        if (invite) setCreated(invite);
        else change(false);
      },
    });
  }

  const roleSelect = (label: string) => (
    <OrgRoleSelect value={role} onChange={setRole} label={label} />
  );

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite link for {created.email}</DialogTitle>
              <DialogDescription>
                Send it to them yourself. Only an account with this email can use it, once, within 7
                days.
              </DialogDescription>
            </DialogHeader>
            <InputGroup>
              <InputGroupInput
                aria-label="Invite link"
                value={created.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <CopyButton label="Copy link" value={created.url} />
              </InputGroupAddon>
            </InputGroup>
            <p className="text-xs text-muted-foreground">Copy it now: it is shown only once.</p>
            <DialogFooter>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (picked || inviting) submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add people</DialogTitle>
              <DialogDescription>
                {anyDirectory
                  ? `Add ${directory.groups ? "people and groups" : "people"} from your directory, or invite someone by their email. Mage sends no emails; you share the link it makes.`
                  : "Invite someone by their email. Mage sends no emails; you share the link it makes."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-2">
              <FieldLabel htmlFor={inputId}>
                {directory.groups ? "Name, email or group" : "Name or email"}
              </FieldLabel>
              <SubjectPicker
                id={inputId}
                text={text}
                onTextChange={(next) => {
                  setText(next);
                  setPicked(null);
                }}
                placeholder="name@example.com"
                options={options}
                picked={picked}
                onPick={setPicked}
                action={(option) => roleSelect(`Role for ${option.name}`)}
                before={
                  inviting && (
                    <Suggestion
                      avatar={<MailIcon />}
                      name={
                        <>
                          Invite <span className="font-medium">{email}</span> as
                        </>
                      }
                    >
                      {roleSelect("Role to invite as")}
                    </Suggestion>
                  )
                }
                empty={nothing && "Nobody here by that name. Type their email to invite them."}
              />
            </div>
            <FieldError>{add.error?.message}</FieldError>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={!(picked || inviting) || add.isPending}>
                {picked ? (picked.kind === "group" ? "Link group" : "Add") : "Invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
