// A space: its threads, most recently active first, starting a new one, and renaming or deleting
// the space.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { useNewThread } from "@/web/components/nav-threads";
import { NameDialog } from "@/web/components/name-dialog";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { Field, FieldError } from "@/web/components/ui/field";
import { Textarea } from "@/web/components/ui/textarea";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import { spaceThreadsQuery, spacesQuery } from "@/web/lib/queries";

const spaceRoute = getRouteApi("/_app/s/$spaceId");

export function SpacePage() {
  const { spaceId } = spaceRoute.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const spaces = useQuery(spacesQuery);
  const threads = useQuery(spaceThreadsQuery(spaceId));
  const newThread = useNewThread();
  const [error, setError] = useState<string>();
  const space = spaces.data?.find((s) => s.id === spaceId);

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("text");
    setError(await newThread(spaceId, typeof text === "string" ? text : ""));
  }

  async function rename(name: string) {
    const res = await apiClient.v1.spaces[":id"].$patch({ param: { id: spaceId }, json: { name } });
    if (!res.ok) return errorOf(res);
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
    return undefined;
  }

  async function remove() {
    const res = await apiClient.v1.spaces[":id"].$delete({ param: { id: spaceId } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
    await navigate({ to: "/" });
  }

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
      <PageHeader crumbs={[{ label: space?.name ?? "" }]}>
        {space && (
          <NameDialog
            title="Rename space"
            action="Rename"
            initialName={space.name}
            onSubmit={rename}
            trigger={
              <Button variant="outline" size="sm">
                Rename
              </Button>
            }
          />
        )}
        {space && !space.primary && (
          <Button variant="outline" size="sm" onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </PageHeader>
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4")}>
        <form onSubmit={(event) => void start(event)}>
          <Field>
            <Textarea
              name="text"
              placeholder="Start a thread…"
              aria-label="First message"
              required
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => void newThread(spaceId)}>
                New thread
              </Button>
              <Button type="submit">Start thread</Button>
            </div>
            <FieldError>{error}</FieldError>
          </Field>
        </form>
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Threads">
          {threads.data?.length === 0 && (
            <li className="p-4 text-sm text-muted-foreground">No threads yet.</li>
          )}
          {threads.data?.map((thread) => (
            <li key={thread.id}>
              <Link
                to="/t/$threadId"
                params={{ threadId: thread.id }}
                className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50"
              >
                <span className="truncate font-medium">{thread.title}</span>
                <Time iso={thread.updatedAt} className="shrink-0 text-xs text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
