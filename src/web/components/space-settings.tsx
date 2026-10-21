// A space's settings: renaming it, and deleting it when it is not the primary space. Only its owner
// may change them; everyone else sees its name.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";

import type { SpaceSummary } from "@/shared/spaces.ts";
import { PageHeader, pageWidth } from "@/web/components/app-shell";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import { spacesQuery } from "@/web/lib/queries";

const spaceSettingsRoute = getRouteApi("/_app/s/$spaceId/settings");

function SpaceName({ space }: { space: SpaceSummary }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState(space.name);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const owner = space.role === "owner";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].$patch({
      param: { id: space.id },
      json: { name },
    });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Name</CardTitle>
        <CardDescription>
          {owner
            ? "Shown in the sidebar and the space switcher."
            : "Only the space's owner can rename it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={id}>Name</FieldLabel>
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                disabled={!owner}
                autoComplete="off"
              />
            </Field>
            <FieldError>{error}</FieldError>
            {owner && (
              <Field>
                <Button
                  type="submit"
                  className="w-fit"
                  disabled={pending || !name.trim() || name.trim() === space.name}
                >
                  Rename
                </Button>
              </Field>
            )}
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function DeleteSpace({ space }: { space: SpaceSummary }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();

  async function remove() {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].$delete({ param: { id: space.id } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await navigate({ to: "/" });
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete space</CardTitle>
        <CardDescription>Only a space without threads can be deleted.</CardDescription>
      </CardHeader>
      {error && (
        <CardContent>
          <FieldError>{error}</FieldError>
        </CardContent>
      )}
      <CardFooter>
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" />}>
            Delete space
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {space.name}?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}

export function SpaceSettings() {
  const { spaceId } = spaceSettingsRoute.useParams();
  const spaces = useQuery(spacesQuery);
  const space = spaces.data?.find((s) => s.id === spaceId);

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  if (spaces.isSuccess && !space) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Not found" }]} />
        <p className="p-4 text-muted-foreground">This space does not exist or is not yours.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={[
          { label: space?.name ?? "", link: { to: "/s/$spaceId", params: { spaceId } } },
          { label: "Settings" },
        ]}
      />
      {space && (
        <div className={cn(pageWidth, "flex flex-col gap-6 p-4")}>
          <SpaceName key={space.id} space={space} />
          {space.role === "owner" && !space.primary && <DeleteSpace space={space} />}
        </div>
      )}
    </>
  );
}
