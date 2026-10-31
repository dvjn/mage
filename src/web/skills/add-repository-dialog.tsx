// Adds a skills repository whole, from owner/repo, a git address or a command that adds skills,
// asking for a token when it is private; every skill in it arrives off.

import { type FormEvent, useId, useState } from "react";

import { useToast } from "@/web/shell/toaster";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Spinner } from "@/web/components/ui/spinner";
import type { Scope } from "@/web/shell/scope";
import { plural } from "@/web/lib/plural";
import { AddRepositoryError, useAddRepository } from "@/web/skills/mutations";

// Adds a repository whole, from what people paste; a private one asks for a token and tries again.
export function AddRepositoryDialog({
  scope,
  onClose,
  onAdded,
}: {
  scope: Scope;
  onClose: () => void;
  onAdded: (sourceId: string) => void;
}) {
  const id = useId();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [token, setToken] = useState("");
  const [asksToken, setAsksToken] = useState(false);
  const add = useAddRepository(scope);
  const pending = add.isPending;
  const error = add.error?.message;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    add.mutate(
      { input, ...(token.trim() && { token: token.trim() }) },
      {
        onSuccess: (source) => {
          onAdded(source.id);
          toast(`Added ${plural(source.skills.length, "skill")}, off`, "info");
          onClose();
        },
        onError: (failed) => {
          const reason = failed instanceof AddRepositoryError ? failed.reason : undefined;
          if (reason === "auth" || reason === "not_found") setAsksToken(true);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-input`}>Repository</FieldLabel>
              <Input
                id={`${id}-input`}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="owner/repo or git URL"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono"
              />
            </Field>
            {asksToken && (
              <Field>
                <FieldLabel htmlFor={`${id}-token`}>Token</FieldLabel>
                <Input
                  id={`${id}-token`}
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Read access"
                  autoComplete="off"
                  autoFocus
                />
                <FieldDescription>Never shown again.</FieldDescription>
              </Field>
            )}
            {pending ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Fetching…
              </p>
            ) : (
              <FieldError>{error}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending || !input.trim()}>
              Add repository
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
