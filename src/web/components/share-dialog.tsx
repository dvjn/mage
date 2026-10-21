// Sharing a thread with people outside its space: the Share button in the thread's header opens a
// dialog that makes an invite link with how long the access it gives lasts, shows the link once to
// copy, and lists the thread's people and its links not yet used, with Revoke beside those the
// signed-in person may revoke.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, UserPlusIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  type AccessFor,
  accessForSchema,
  type CreatedInvite,
  createdInviteSchema,
  type PendingInvite,
  type ThreadPerson,
} from "@/shared/guests.ts";
import { Until } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/web/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/web/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/web/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { threadPeopleQuery } from "@/web/lib/queries";
import { fullTime, timeUntil } from "@/web/lib/time";

const ACCESS_LABELS: Record<AccessFor, string> = {
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  never: "No expiry",
};

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <InputGroupButton
      aria-label="Copy link"
      size="icon-xs"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </InputGroupButton>
  );
}

function Row({
  label,
  name,
  children,
  onRevoke,
}: {
  label: string;
  name: string;
  children?: React.ReactNode;
  onRevoke?: () => void;
}) {
  return (
    <li aria-label={label} className="flex min-h-8 items-center gap-2 text-sm">
      <span className="truncate font-medium">{name}</span>
      {children && (
        <span className="flex min-w-0 items-baseline gap-2 truncate text-xs text-muted-foreground *:before:mr-2 *:before:content-['·']">
          {children}
        </span>
      )}
      {onRevoke && (
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onRevoke}>
          Revoke
        </Button>
      )}
    </li>
  );
}

function People({
  people,
  invites,
  onRevoke,
}: {
  people: ThreadPerson[];
  invites: PendingInvite[];
  onRevoke: (path: { guest: string } | { invite: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <section aria-label="People" className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">People</h3>
        <ul className="flex flex-col">
          {people.map((person) => (
            <Row
              key={person.userId}
              label={person.name}
              name={person.name}
              onRevoke={person.canRevoke ? () => onRevoke({ guest: person.userId }) : undefined}
            >
              {person.kind === "guest" ? (
                <>
                  <span>guest</span>
                  <Until iso={person.accessUntil} />
                </>
              ) : (
                <span>member</span>
              )}
            </Row>
          ))}
          {people.length === 0 && (
            <li className="text-sm text-muted-foreground">Nobody has written yet.</li>
          )}
        </ul>
      </section>
      {invites.length > 0 && (
        <section aria-label="Unused links" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Unused links</h3>
          <ul className="flex flex-col">
            {invites.map((invite) => (
              <Row
                key={invite.id}
                label="Unused link"
                name={`Link for ${ACCESS_LABELS[invite.accessFor].toLowerCase()}`}
                onRevoke={invite.canRevoke ? () => onRevoke({ invite: invite.id }) : undefined}
              >
                <span title={fullTime(invite.linkExpiresAt)}>
                  expires {timeUntil(invite.linkExpiresAt) ?? "now"}
                </span>
              </Row>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ShareDialog({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const people = useQuery({ ...threadPeopleQuery(threadId), enabled: open });
  const [accessFor, setAccessFor] = useState<AccessFor>("1d");
  const [created, setCreated] = useState<CreatedInvite>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

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

  async function revoke(path: { guest: string } | { invite: string }) {
    setError(undefined);
    const res =
      "guest" in path
        ? await apiClient.v1.threads[":id"].guests[":userId"].$delete({
            param: { id: threadId, userId: path.guest },
          })
        : await apiClient.v1.threads[":id"].invites[":inviteId"].$delete({
            param: { id: threadId, inviteId: path.invite },
          });
    if (!res.ok) setError(await errorOf(res));
    if ("invite" in path && path.invite === created?.id) setCreated(undefined);
    await refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The link is shown once; closing the dialog lets it go.
        if (!next) {
          setCreated(undefined);
          setError(undefined);
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <UserPlusIcon />
        Share
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this thread</DialogTitle>
          <DialogDescription>
            Whoever opens an invite link can read and write in this thread, and nothing else in its
            space. Each link works once, within 7 days.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={id}>Access lasts</FieldLabel>
          <div className="flex gap-2">
            <Select
              value={accessFor}
              onValueChange={(value) => {
                const parsed = accessForSchema.safeParse(value);
                if (parsed.success) setAccessFor(parsed.data);
              }}
            >
              <SelectTrigger id={id} className="flex-1">
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
              Create invite link
            </Button>
          </div>
        </Field>
        {created && (
          <Field>
            <InputGroup>
              <InputGroupInput
                aria-label="Invite link"
                value={created.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <CopyLink url={created.url} />
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              Copy it now: it is shown only once. It gives {ACCESS_LABELS[created.accessFor]}
              {created.accessFor === "never" ? "" : " of access"} from when it is opened.
            </FieldDescription>
          </Field>
        )}
        <FieldError>{error}</FieldError>
        {people.data && (
          <People
            people={people.data.people}
            invites={people.data.invites}
            onRevoke={(path) => void revoke(path)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
