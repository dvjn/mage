// Sharing a thread with people outside its space, on one surface opened from the Share button in
// the thread's header: a dialog, or a sheet from the bottom on a phone. At the top, an invite link
// made for as long as the access it gives should last, shown once to copy; below, the thread's
// people (the space's members who wrote, with their role, and its guests, with when their access
// ends) and its links not yet used, each with Remove where the signed-in person may remove it;
// removing a person asks first. A long list scrolls, with a filter above it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LinkIcon, SearchIcon, UserPlusIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import {
  type AccessFor,
  accessForSchema,
  type CreatedInvite,
  createdInviteSchema,
  type PendingInvite,
  type ThreadPerson,
} from "@/shared/guests.ts";
import { CopyButton } from "@/web/components/copy-button";
import { Subject, type SubjectAvatar } from "@/web/components/people-table";
import { Until } from "@/web/components/time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/web/components/ui/alert-dialog";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/web/components/ui/dialog";
import { FieldError, FieldLabel } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/web/components/ui/sheet";
import { useIsMobile } from "@/web/hooks/use-mobile";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { threadPeopleQuery } from "@/web/guests/queries";
import { ROLE_LABELS } from "@/web/spaces/roles";
import { fullTime, timeUntil } from "@/web/lib/time";

const ACCESS_LABELS: Record<AccessFor, string> = {
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  never: "No expiry",
};

const DESCRIPTION =
  "Whoever opens an invite link can read and write in this thread, and nothing else in its space.";

function Row({
  label,
  avatar,
  name,
  detail,
  onRevoke,
}: {
  label: string;
  avatar: SubjectAvatar;
  name: ReactNode;
  detail?: ReactNode;
  onRevoke?: () => void;
}) {
  return (
    <li aria-label={label} className="group flex min-h-10 items-center gap-2 py-1">
      <Subject avatar={avatar} name={name} detail={detail} size="sm" />
      {onRevoke && (
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto focus-visible:opacity-100 group-hover:opacity-100 md:opacity-0"
          onClick={onRevoke}
        >
          Remove
        </Button>
      )}
    </li>
  );
}

// Above this many rows the list gets a filter.
const FILTER_FROM = 8;

function People({
  people,
  invites,
  onRevoke,
}: {
  people: ThreadPerson[];
  invites: PendingInvite[];
  onRevoke: (path: { guest: string } | { invite: string }) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const linkName = (invite: PendingInvite) =>
    `Link, ${ACCESS_LABELS[invite.accessFor].toLowerCase()}`;
  const shownPeople = people.filter((person) => person.name.toLowerCase().includes(needle));
  const shownInvites = invites.filter((invite) => linkName(invite).toLowerCase().includes(needle));
  const filtering = people.length + invites.length > FILTER_FROM;
  return (
    <section aria-label="People" className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">People in this thread</h3>
      {filtering && (
        <InputGroup className="my-1">
          <InputGroupInput
            type="search"
            placeholder="Filter people"
            aria-label="Filter people"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
      )}
      <ul className="flex max-h-80 flex-col overflow-y-auto">
        {shownPeople.map((person) => (
          <Row
            key={person.userId}
            label={person.name}
            avatar={{ initials: person.name }}
            name={person.name}
            detail={
              person.kind === "guest" ? (
                <>
                  Guest · <Until iso={person.accessUntil} />
                </>
              ) : person.role ? (
                ROLE_LABELS[person.role]
              ) : (
                "Member"
              )
            }
            onRevoke={person.canRevoke ? () => onRevoke({ guest: person.userId }) : undefined}
          />
        ))}
        {people.length === 0 && (
          <li className="text-sm text-muted-foreground">Nobody has written yet.</li>
        )}
        {filtering && shownPeople.length + shownInvites.length === 0 && (
          <li className="text-sm text-muted-foreground">Nobody matches.</li>
        )}
        {shownInvites.map((invite) => (
          <Row
            key={invite.id}
            label="Unused link"
            avatar={{ icon: <LinkIcon /> }}
            name={linkName(invite)}
            detail={
              <span title={fullTime(invite.linkExpiresAt)}>
                Unused · Expires {timeUntil(invite.linkExpiresAt) ?? "now"}
              </span>
            }
            onRevoke={invite.canRevoke ? () => onRevoke({ invite: invite.id }) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

// Revokes a guest or an unused link; what went wrong, if anything.
async function revokeIn(threadId: string, path: { guest: string } | { invite: string }) {
  const res =
    "guest" in path
      ? await apiClient.v1.threads[":id"].guests[":userId"].$delete({
          param: { id: threadId, userId: path.guest },
        })
      : await apiClient.v1.threads[":id"].invites[":inviteId"].$delete({
          param: { id: threadId, inviteId: path.invite },
        });
  return res.ok ? undefined : errorOf(res);
}

function ShareBody({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient();
  const id = useId();
  const people = useQuery(threadPeopleQuery(threadId));
  const [accessFor, setAccessFor] = useState<AccessFor>("1d");
  const [created, setCreated] = useState<CreatedInvite>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<ThreadPerson | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: threadPeopleQuery(threadId).queryKey });

  async function create() {
    setPending(true);
    setError(undefined);
    const res = await apiClient.v1.threads[":id"].invites.$post({
      param: { id: threadId },
      json: { accessFor },
    });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setCreated(createdInviteSchema.parse(await res.json()));
    await refresh();
  }

  // Revoking a person asks first; an unused link goes at once.
  function ask(path: { guest: string } | { invite: string }) {
    if ("invite" in path) {
      void revoke(path);
      return;
    }
    setConfirming(people.data?.people.find((person) => person.userId === path.guest) ?? null);
  }

  async function revoke(path: { guest: string } | { invite: string }) {
    setError(undefined);
    const failed = await revokeIn(threadId, path);
    if (failed) setError(failed);
    if ("invite" in path && path.invite === created?.id) setCreated(undefined);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Invite with a link" className="flex flex-col gap-2">
        <FieldLabel htmlFor={id}>Invite with a link</FieldLabel>
        <div className="flex gap-2">
          <Select
            value={accessFor}
            onValueChange={(value) => {
              const parsed = accessForSchema.safeParse(value);
              if (parsed.success) setAccessFor(parsed.data);
            }}
          >
            <SelectTrigger id={id} aria-label="Access lasts" className="flex-1">
              <SelectValue>{(value: AccessFor) => ACCESS_LABELS[value]}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {accessForSchema.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {ACCESS_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={pending} onClick={() => void create()}>
            Create link
          </Button>
        </div>
        {created && (
          <>
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
            <p className="text-xs text-muted-foreground">
              Copy it now: it is shown only once. It works once, within 7 days, and gives{" "}
              {created.accessFor === "never"
                ? "access with no expiry"
                : `${ACCESS_LABELS[created.accessFor]} of access`}{" "}
              from when it is opened.
            </p>
          </>
        )}
        <FieldError>{error}</FieldError>
      </section>
      {people.data && (
        <People people={people.data.people} invites={people.data.invites} onRevoke={ask} />
      )}
      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirming?.name}?</AlertDialogTitle>
            <AlertDialogDescription>They lose access to this thread.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirming) void revoke({ guest: confirming.userId });
                setConfirming(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ShareDialog({ threadId }: { threadId: string }) {
  const mobile = useIsMobile();
  // Each opening starts afresh: the link made last time is not shown again.
  const [opened, setOpened] = useState(0);
  const trigger = (
    <>
      <UserPlusIcon />
      Share
    </>
  );
  if (mobile) {
    return (
      <Sheet onOpenChange={(open) => open && setOpened(opened + 1)}>
        <SheetTrigger render={<Button size="sm" variant="outline" />}>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
          <SheetHeader className="pb-0">
            <SheetTitle>Share this thread</SheetTitle>
            <SheetDescription>{DESCRIPTION}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <ShareBody key={opened} threadId={threadId} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog onOpenChange={(open) => open && setOpened(opened + 1)}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this thread</DialogTitle>
          <DialogDescription>{DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <ShareBody key={opened} threadId={threadId} />
      </DialogContent>
    </Dialog>
  );
}
