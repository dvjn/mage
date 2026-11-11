// Who may open an artifact, on the surface its visibility button opens, whose icon and tooltip say
// who can open it now. Top to bottom: the general access levels to pick from, each saying who it
// reaches, the organization's with what its members may do (one the server does not offer the
// reader is left out, and for one who may not share at all they are all shown closed, with the
// reason said once); for one who may change it, the threads that used it with guests, each with a
// switch for its guests, and the people given access, each to view or to edit, with a picker to
// add more; and the link to copy: the public one while it is public, else the artifact's page in
// the app.

import { Building2Icon, GlobeIcon, LockIcon, UsersIcon } from "lucide-react";
import type * as React from "react";
import { useId, useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { ArtifactDetail, ArtifactRole, ArtifactSharing } from "@/shared/artifacts.ts";
import { artifactSharingSchema } from "@/shared/artifacts.ts";
import {
  useSetSharing,
  useShareGroup,
  useSharePerson,
  useShareWithGuests,
} from "@/web/artifacts/mutations";
import { artifactCandidatesQuery } from "@/web/artifacts/queries";
import { CopyField } from "@/web/components/copy-button";
import { FieldError, FieldLabel } from "@/web/components/ui/field";
import { Switch } from "@/web/components/ui/switch";
import { useDebounced } from "@/web/hooks/use-debounced";
import { plural } from "@/web/lib/plural";
import { AccessLevel } from "@/web/components/access-level";
import { ARTIFACT_LEVELS } from "@/web/sharing/access-level";
import { AddPeople } from "@/web/sharing/add-people";
import { GeneralAccess } from "@/web/sharing/general-access";
import { PeopleSection, type PersonRow } from "@/web/sharing/people-section";
import { ShareSurface } from "@/web/sharing/share-surface";
import type { SubjectOption } from "@/web/spaces/subject-picker";

export const SHARING_LEVELS: Record<
  ArtifactSharing,
  {
    label: string;
    reach: string;
    visible: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  space: {
    label: "Space",
    reach: "Members of the space",
    visible: "Space members",
    icon: LockIcon,
  },
  org: {
    label: "Organization",
    reach: "Everyone in the organization",
    visible: "Everyone in the organization",
    icon: Building2Icon,
  },
  public: {
    label: "Public",
    reach: "Anyone with the link",
    visible: "Anyone with the link",
    icon: GlobeIcon,
  },
};

// Who can open an artifact, as a row says it: the level's icon and its name.
export function SharingIndicator({ sharing }: { sharing: ArtifactSharing }) {
  const { icon: Icon, label } = SHARING_LEVELS[sharing];
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function People({ artifact }: { artifact: ArtifactDetail }) {
  const pickerId = useId();
  const [text, setText] = useState("");
  const share = useSharePerson(artifact.id);
  const shareGroup = useShareGroup(artifact.id);
  const [role, setRole] = useState<ArtifactRole>("view");
  const query = useDebounced(text.trim());
  const found = useQuery({
    ...artifactCandidatesQuery(artifact.id, query),
    placeholderData: keepPreviousData,
  });
  // A group or someone already holding more than the others is marked; one who may be given more
  // says what they have.
  const options: SubjectOption[] = (found.data ?? []).map((one) => {
    const detail =
      one.kind === "group"
        ? `${one.email || "Group"} · ${plural(one.memberCount ?? 0, "person", "people")}`
        : one.guest
          ? `${one.email} · Guest`
          : one.email;
    return {
      kind: one.kind,
      id: one.id,
      name: one.name,
      detail: one.current ? `${detail} · ${one.current}` : detail,
      ...(one.already && { already: one.already }),
    };
  });
  const rows: PersonRow[] = [
    ...artifact.groups.map((group): PersonRow => ({
      id: `group:${group.groupId}`,
      label: group.name,
      avatar: { icon: <UsersIcon /> },
      name: group.name,
      detail: `Group · ${plural(group.memberCount, "person", "people")}`,
      control: (
        <AccessLevel
          levels={ARTIFACT_LEVELS}
          value={group.role}
          label={`Access for ${group.name}`}
          disabled={shareGroup.isPending}
          onChange={(next) =>
            shareGroup.mutate({ groupId: group.groupId, shared: true, role: next })
          }
        />
      ),
      confirm: "group",
      disabled: shareGroup.isPending,
      onRemove: () => shareGroup.mutate({ groupId: group.groupId, shared: false }),
    })),
    ...artifact.people.map((person): PersonRow => ({
      id: person.userId,
      label: person.name,
      avatar: { initials: person.name },
      name: person.name,
      detail: person.former ? "Former" : person.guest ? "Guest" : person.email,
      control: (
        <AccessLevel
          levels={ARTIFACT_LEVELS}
          value={person.role}
          label={`Access for ${person.name}`}
          disabled={share.isPending || person.guest}
          onChange={(next) => share.mutate({ userId: person.userId, shared: true, role: next })}
        />
      ),
      confirm: "person",
      disabled: share.isPending,
      onRemove: () => share.mutate({ userId: person.userId, shared: false }),
    })),
  ];
  return (
    <PeopleSection
      rows={rows}
      add={
        <>
          <AddPeople
            id={pickerId}
            text={text}
            onTextChange={setText}
            placeholder="Add people"
            options={options}
            picked={null}
            onPick={(one) => {
              if (!one) return;
              if (one.kind === "group") {
                shareGroup.mutate(
                  { groupId: one.id, shared: true, role },
                  { onSuccess: () => setText("") },
                );
                return;
              }
              // A guest of a thread only views.
              const guest = found.data?.find(
                (candidate) => candidate.kind === "user" && candidate.id === one.id,
              )?.guest;
              share.mutate(
                { userId: one.id, shared: true, role: guest ? "view" : role },
                { onSuccess: () => setText("") },
              );
            }}
            levels={ARTIFACT_LEVELS}
            level={role}
            onLevel={setRole}
            empty={found.isSuccess && options.length === 0 && "No one else to add"}
          />
          <FieldError>{(share.error ?? shareGroup.error)?.message}</FieldError>
        </>
      }
    />
  );
}

function ShareBody({ artifact }: { artifact: ArtifactDetail }) {
  const id = useId();
  const setSharing = useSetSharing(artifact.id);
  const shareWithGuests = useShareWithGuests(artifact.id);
  const blocked = new Map(artifact.sharingBlocked.map((one) => [one.level, one.reason]));
  const reason = [...blocked.values()][0];
  const levels = artifactSharingSchema.options.filter(
    (level) => blocked.has(level) || artifact.sharingLevels.includes(level),
  );
  const link = artifact.publicUrl ?? `${window.location.origin}/artifacts/${artifact.id}`;
  return (
    <div className="flex flex-col gap-5">
      {reason && <p className="text-sm text-muted-foreground">{reason}.</p>}
      <GeneralAccess
        label="Who can open it"
        value={artifact.sharing}
        disabled={setSharing.isPending}
        onChange={(sharing) => setSharing.mutate({ sharing })}
        choices={levels.map((level) => ({
          value: level,
          label: SHARING_LEVELS[level].label,
          reach: SHARING_LEVELS[level].reach,
          icon: SHARING_LEVELS[level].icon,
          closed: blocked.has(level),
          ...(level === "org" &&
            artifact.canShare && {
              control: (
                <AccessLevel
                  levels={ARTIFACT_LEVELS}
                  value={artifact.orgRole}
                  label="What the organization can do"
                  disabled={setSharing.isPending}
                  onChange={(orgRole) => setSharing.mutate({ sharing: artifact.sharing, orgRole })}
                />
              ),
            }),
        }))}
      />
      <FieldError>{setSharing.error?.message}</FieldError>
      {artifact.guestThreads.length > 0 && (
        <div className="flex flex-col gap-2">
          <FieldLabel>Thread guests</FieldLabel>
          <ul className="overflow-hidden rounded-lg border">
            {artifact.guestThreads.map((thread) => {
              const title = thread.title ?? "Untitled";
              return (
                <li key={thread.id} className="border-b last:border-b-0">
                  <label className="flex items-center gap-3 px-3 py-2.5">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{title}</span>
                      <span className="text-xs text-muted-foreground">
                        {thread.guests === 1 ? "1 guest" : `${thread.guests} guests`}
                      </span>
                    </span>
                    <Switch
                      aria-label={title}
                      checked={thread.shared}
                      disabled={shareWithGuests.isPending}
                      onCheckedChange={(shared) =>
                        shareWithGuests.mutate({ threadId: thread.id, shared })
                      }
                    />
                  </label>
                </li>
              );
            })}
          </ul>
          <FieldError>{shareWithGuests.error?.message}</FieldError>
        </div>
      )}
      {artifact.canShare && <People artifact={artifact} />}
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor={id}>Link</FieldLabel>
        <CopyField id={id} label="Link" value={link} />
      </div>
    </div>
  );
}

export function ShareArtifact({ artifact }: { artifact: ArtifactDetail }) {
  const { visible: label, icon } = SHARING_LEVELS[artifact.sharing];
  const more =
    artifact.guestThreads.reduce((sum, thread) => sum + (thread.shared ? thread.guests : 0), 0) +
    artifact.people.length;
  return (
    <ShareSurface
      title="Share this artifact"
      description="Choose who can open this artifact."
      visibility={{
        icon,
        label: more > 0 ? `${label} and ${more} more` : label,
      }}
    >
      <ShareBody artifact={artifact} />
    </ShareSurface>
  );
}
