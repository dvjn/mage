// Sharing a thread, on the surface its visibility button opens, whose icon says whether it is open
// to the org or has guests. Top to bottom: general access, the space's members alone or the org's
// members too, to view or to message; its people (the space's members who wrote, with their role,
// and its guests, with when their access ends and what they may do) and its links not yet used,
// each with Remove where the signed-in person may remove it, where a person is asked about first;
// a picker to add the org's members outside the space, with how long their access lasts and what
// they may do; and an invite link for anyone else, made for as long as the access it gives should
// last, to view or to message, and shown once to copy.

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Building2Icon, LinkIcon, LockIcon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  type AccessFor,
  type CreatedInvite,
  type PendingInvite,
  type ThreadPerson,
  type ThreadRole,
} from "@/shared/guests.ts";
import { guestCandidatesPages } from "@/web/api/list-queries";
import { CopyField } from "@/web/components/copy-button";
import { Until } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { plural } from "@/web/lib/plural";
import { FieldError, FieldLabel } from "@/web/components/ui/field";
import {
  useAddGuest,
  useCreateInvite,
  useRevoke,
  useSetGuestRole,
  useSetOrgAccess,
} from "@/web/guests/mutations";
import { threadPeopleQuery } from "@/web/guests/queries";
import { timeUntil } from "@/web/lib/time";
import { useDebounced } from "@/web/hooks/use-debounced";
import { AccessLength, ACCESS_LABELS } from "@/web/sharing/access-length";
import { AccessLevel } from "@/web/components/access-level";
import { THREAD_LEVELS } from "@/web/sharing/access-level";
import { AddPeople } from "@/web/sharing/add-people";
import { GeneralAccess } from "@/web/sharing/general-access";
import { PeopleSection, type PersonRow } from "@/web/sharing/people-section";
import { ShareSurface } from "@/web/sharing/share-surface";
import type { SubjectOption } from "@/web/spaces/subject-picker";
import { ROLE_LABELS } from "@/web/spaces/roles";

const DESCRIPTION = "Guests can see this thread, and nothing else in its space.";

type Removal = { guest: string } | { group: string } | { invite: string };

function ShareBody({ threadId }: { threadId: string }) {
  const id = useId();
  const pickerId = useId();
  const people = useQuery(threadPeopleQuery(threadId));
  const [accessFor, setAccessFor] = useState<AccessFor>("1d");
  const [linkRole, setLinkRole] = useState<ThreadRole>("message");
  const [addFor, setAddFor] = useState<AccessFor>("1d");
  const [addRole, setAddRole] = useState<ThreadRole>("message");
  const [text, setText] = useState("");
  const [created, setCreated] = useState<CreatedInvite>();
  const addGuest = useAddGuest(threadId);
  const invite = useCreateInvite(threadId);
  const revocation = useRevoke(threadId);
  const roles = useSetGuestRole(threadId);
  const orgAccess = useSetOrgAccess(threadId);
  const error = (invite.error ?? revocation.error ?? roles.error ?? orgAccess.error)?.message;
  const query = useDebounced(text.trim());
  const found = useInfiniteQuery({
    ...guestCandidatesPages(threadId, { q: query }, 20),
    placeholderData: keepPreviousData,
  });
  const options: SubjectOption[] = (found.data?.pages[0]?.items ?? []).map((one) => ({
    kind: one.kind,
    id: one.id,
    name: one.name,
    detail:
      one.kind === "group"
        ? `${one.email || "Group"} · ${plural(one.memberCount ?? 0, "person", "people")}`
        : one.email,
    ...(one.already && { already: one.already }),
  }));

  function create() {
    revocation.reset();
    invite.mutate({ accessFor, role: linkRole }, { onSuccess: setCreated });
  }

  function revoke(path: Removal) {
    invite.reset();
    revocation.mutate(path);
    if ("invite" in path && path.invite === created?.id) setCreated(undefined);
  }

  const linkName = (link: PendingInvite) => `Link, ${ACCESS_LABELS[link.accessFor].toLowerCase()}`;
  const rows: PersonRow[] = [
    ...(people.data?.people ?? []).map((person: ThreadPerson): PersonRow => ({
      id: person.userId,
      label: person.name,
      avatar: person.kind === "group" ? { icon: <UsersIcon /> } : { initials: person.name },
      name: person.name,
      detail:
        person.kind === "group" ? (
          <>
            Group · {plural(person.memberCount ?? 0, "person", "people")} ·{" "}
            <Until iso={person.accessUntil} />
          </>
        ) : person.kind === "guest" ? (
          <>
            Guest · <Until iso={person.accessUntil} />
          </>
        ) : person.role ? (
          ROLE_LABELS[person.role]
        ) : (
          "Member"
        ),
      ...(person.access && {
        control: (
          <AccessLevel
            levels={THREAD_LEVELS}
            value={person.access}
            label={`Access for ${person.name}`}
            disabled={roles.isPending}
            onChange={(role) =>
              roles.mutate({
                ...(person.kind === "group" ? { group: person.userId } : { guest: person.userId }),
                role,
              })
            }
          />
        ),
      }),
      ...(person.canRevoke && {
        confirm: person.kind === "group" ? ("group" as const) : ("person" as const),
        onRemove: () =>
          revoke(person.kind === "group" ? { group: person.userId } : { guest: person.userId }),
      }),
    })),
    ...(people.data?.invites ?? []).map((link): PersonRow => ({
      id: link.id,
      label: "Unused link",
      avatar: { icon: <LinkIcon /> },
      name: linkName(link),
      detail: `Unused · Expires ${timeUntil(link.linkExpiresAt) ?? "now"}`,
      control: (
        <AccessLevel
          levels={THREAD_LEVELS}
          value={link.role}
          label="Access for the link"
          disabled={roles.isPending}
          onChange={(role) => roles.mutate({ invite: link.id, role })}
        />
      ),
      ...(link.canRevoke && { onRemove: () => revoke({ invite: link.id }) }),
    })),
  ];

  return (
    <div className="flex flex-col gap-5">
      {people.data && (
        <GeneralAccess
          label="Who can open it"
          value={people.data.orgAccess === "none" ? "space" : "org"}
          disabled={orgAccess.isPending}
          onChange={(next) => orgAccess.mutate(next === "space" ? "none" : "view")}
          choices={[
            {
              value: "space",
              label: "Space members",
              reach: "Can open it through its space",
              icon: LockIcon,
            },
            {
              value: "org",
              label: "Organization",
              reach: "Everyone in the organization",
              icon: Building2Icon,
              ...(people.data.orgAccess !== "none" && {
                control: (
                  <AccessLevel
                    levels={THREAD_LEVELS}
                    value={people.data.orgAccess}
                    label="What the organization can do"
                    disabled={orgAccess.isPending}
                    onChange={(level) => orgAccess.mutate(level)}
                  />
                ),
              }),
            },
          ]}
        />
      )}
      {people.data && (
        <PeopleSection
          rows={rows}
          empty="Nobody has written yet."
          add={
            <AddPeople
              id={pickerId}
              text={text}
              onTextChange={setText}
              placeholder="Add people"
              options={options}
              picked={null}
              onPick={(one) => {
                if (one) {
                  addGuest.mutate(
                    {
                      ...(one.kind === "group" ? { groupId: one.id } : { userId: one.id }),
                      accessFor: addFor,
                      role: addRole,
                    },
                    { onSuccess: () => setText("") },
                  );
                }
              }}
              levels={THREAD_LEVELS}
              level={addRole}
              onLevel={setAddRole}
              length={{ value: addFor, onChange: setAddFor }}
              empty={found.isSuccess && options.length === 0 && "No one else to add"}
            />
          }
        />
      )}
      <section aria-label="Invite with a link" className="flex flex-col gap-2">
        <FieldLabel htmlFor={id}>Invite with a link</FieldLabel>
        <div className="flex gap-2">
          <AccessLength
            id={id}
            label="Access lasts"
            value={accessFor}
            onChange={setAccessFor}
            grow
          />
          <AccessLevel
            levels={THREAD_LEVELS}
            value={linkRole}
            label="Access for the link"
            onChange={setLinkRole}
          />
          <Button disabled={invite.isPending} onClick={create}>
            Create link
          </Button>
        </div>
        {created && (
          <>
            <CopyField label="Invite link" value={created.url} once />
            <p className="text-xs text-muted-foreground">
              It works once, within 7 days, and gives{" "}
              {created.accessFor === "never"
                ? "access with no expiry"
                : `${ACCESS_LABELS[created.accessFor]} of access`}{" "}
              from when it is opened.
            </p>
          </>
        )}
        <FieldError>{error ?? addGuest.error?.message}</FieldError>
      </section>
    </div>
  );
}

export function ShareDialog({ threadId }: { threadId: string }) {
  const people = useQuery(threadPeopleQuery(threadId));
  const guests =
    people.data?.people.reduce(
      (count, person) =>
        count +
        (person.kind === "guest" ? 1 : person.kind === "group" ? (person.memberCount ?? 0) : 0),
      0,
    ) ?? 0;
  const org = people.data?.orgAccess !== undefined && people.data.orgAccess !== "none";
  const guestText = `${guests} ${guests === 1 ? "guest" : "guests"}`;
  return (
    <ShareSurface
      title="Share this thread"
      description={DESCRIPTION}
      visibility={
        org
          ? {
              icon: Building2Icon,
              label: guests > 0 ? `Organization and ${guestText}` : "Organization",
            }
          : guests > 0
            ? { icon: UsersIcon, label: `Space members and ${guestText}` }
            : { icon: LockIcon, label: "Space members" }
      }
    >
      <ShareBody threadId={threadId} />
    </ShareSurface>
  );
}
