// Adds or changes the token a private skills repository is read with.

import { useId, useState } from "react";

import { type SkillSourceSummary } from "@/shared/skills.ts";
import { useToast } from "@/web/shell/toaster";
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
import { Input } from "@/web/components/ui/input";
import { apiClient } from "@/web/api/api-client";
import { useChange } from "@/web/skills/mutations";

export function TokenDialog({
  source,
  onClose,
}: {
  source: SkillSourceSummary;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const [token, setToken] = useState("");
  const { error, pending, run } = useChange();

  async function save(next: string | null) {
    const res = await run(() =>
      apiClient.v1["skill-sources"][":id"].token.$put({
        param: { id: source.id },
        json: { token: next },
      }),
    );
    if (!res) return;
    toast(next ? "Token saved" : "Token removed", "info");
    onClose();
  }

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{source.hasToken ? "Change token" : "Add a token"}</DialogTitle>
          <DialogDescription>Never shown again.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(token.trim());
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>Personal access token</FieldLabel>
            <Input
              id={id}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={source.hasToken ? "New token" : "Read access"}
              autoComplete="off"
              autoFocus
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter className="mt-4">
            {source.hasToken && (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                disabled={pending}
                onClick={() => void save(null)}
              >
                Remove token
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending || !token.trim()}>
              Save and fetch
            </Button>
          </DialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
