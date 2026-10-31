// Adds people of the org, or groups, to something: one picker that searches the org on the server,
// leaving out those already in it, and, where they get a role, the role to give. Inviting someone
// new to the org is the invite dialog's.

import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

import { type SubjectOption, SubjectPicker } from "@/web/spaces/subject-picker";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { useDebounced } from "@/web/hooks/use-debounced";
import { groupsPages, membersPages } from "@/web/api/list-queries";

export function AddPeopleDialog<T extends string>({
  open,
  onOpenChange,
  title,
  description,
  kinds,
  exclude,
  roles,
  canInvite,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  // Whom to offer: people, groups or both.
  kinds: SubjectOption["kind"][];
  // Those already in it, as "user:<id>" or "group:<id>".
  exclude: Set<string>;
  // The roles to give and the one offered first; none when they get no role.
  roles?: { options: { value: T; label: string }[]; initial: T };
  // The viewer may invite people to the org, so an empty list points there.
  canInvite?: boolean;
  // Resolves to an error to show, or nothing when done.
  onAdd: (option: SubjectOption, role: T | null) => Promise<string | undefined>;
}) {
  const pickerId = useId();
  const roleId = useId();
  const [picked, setPicked] = useState<SubjectOption | null>(null);
  const [role, setRole] = useState<T | null>(roles?.initial ?? null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");
  const q = useDebounced(text);
  const people = useInfiniteQuery({
    ...membersPages({ q }, 20),
    enabled: open && kinds.includes("user"),
  });
  const groups = useInfiniteQuery({
    ...groupsPages({ q }, 20),
    enabled: open && kinds.includes("group") && !!q,
  });
  const options: SubjectOption[] = [
    ...(people.data?.pages[0]?.items ?? []).map((member) => ({
      kind: "user" as const,
      id: member.userId,
      name: member.name,
      detail: member.email,
    })),
    ...(groups.data?.pages[0]?.items ?? []).map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
      detail: `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`,
    })),
  ].filter((option) => !exclude.has(`${option.kind}:${option.id}`));
  // Groups come from a directory; while the org has none, the picker offers people only.
  const anyGroups = useInfiniteQuery({
    ...groupsPages({}, 1),
    enabled: open && kinds.includes("group"),
  });
  const withGroups = kinds.includes("group") && (anyGroups.data?.pages[0]?.total ?? 0) > 0;

  function change(next: boolean) {
    onOpenChange(next);
    if (next) return;
    setPicked(null);
    setRole(roles?.initial ?? null);
    setError(undefined);
    setText("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!picked) return;
    setPending(true);
    const failed = await onAdd(picked, role);
    setPending(false);
    setError(failed);
    if (!failed) change(false);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={pickerId}>
                {withGroups ? "Person or group" : "Person"}
              </FieldLabel>
              <SubjectPicker
                id={pickerId}
                options={options}
                value={picked}
                onChange={setPicked}
                query={text}
                onQueryChange={setText}
                placeholder={withGroups ? "Pick a person or group" : "Pick a person"}
                empty={
                  canInvite ? (
                    <>
                      Nobody else to add.{" "}
                      <Link to="/org/people" className="underline underline-offset-4">
                        Invite someone to the organization
                      </Link>
                    </>
                  ) : (
                    "Nobody else to add."
                  )
                }
              />
            </Field>
            {roles && role && (
              <Field>
                <FieldLabel htmlFor={roleId}>Role</FieldLabel>
                <Select value={role} onValueChange={(next) => next && setRole(next as T)}>
                  <SelectTrigger id={roleId} className="w-full">
                    <SelectValue>
                      {(value: T) => roles.options.find((option) => option.value === value)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {roles.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldGroup>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!picked || pending}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
