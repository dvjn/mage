// A space: its threads, most recently active first and narrowed by title as you type, and starting
// a new one.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { useNewThread } from "@/web/components/nav-threads";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { Field, FieldError } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { Textarea } from "@/web/components/ui/textarea";
import { rememberSpace } from "@/web/lib/last-space";
import { spaceThreadsQuery, spacesQuery } from "@/web/lib/queries";

const spaceRoute = getRouteApi("/_app/s/$spaceId");

export function SpacePage() {
  const { spaceId } = spaceRoute.useParams();
  const spaces = useQuery(spacesQuery);
  const threads = useQuery(spaceThreadsQuery(spaceId));
  const newThread = useNewThread();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const space = spaces.data?.find((s) => s.id === spaceId);

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  const needle = filter.trim().toLowerCase();
  const shown = threads.data?.filter((thread) => thread.title.toLowerCase().includes(needle));

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("text");
    setError(await newThread(spaceId, typeof text === "string" ? text : ""));
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
      <PageHeader crumbs={[{ label: space?.name ?? "" }]} />
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
        <div className="flex flex-col gap-2">
          <InputGroup>
            <InputGroupInput
              type="search"
              placeholder="Filter threads…"
              aria-label="Filter threads"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Threads">
            {threads.data?.length === 0 && (
              <li className="p-4 text-sm text-muted-foreground">No threads yet.</li>
            )}
            {!!threads.data?.length && shown?.length === 0 && (
              <li className="p-4 text-sm text-muted-foreground">No thread matches.</li>
            )}
            {shown?.map((thread) => (
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
      </div>
    </>
  );
}
