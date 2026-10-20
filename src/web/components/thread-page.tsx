// A thread: its events as they happen, a composer to post messages and the thread's model.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useState } from "react";

import { anyThreadEventSchema, threadSchema } from "@/shared/threads.ts";
import { PageHeader } from "@/web/components/app-shell";
import { ModelPicker } from "@/web/components/model-picker";
import { ThreadEvent } from "@/web/components/thread-events";
import { Button } from "@/web/components/ui/button";
import { FieldError } from "@/web/components/ui/field";
import { Textarea } from "@/web/components/ui/textarea";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import { modelsQuery, spaceThreadsQuery, spacesQuery, threadQuery } from "@/web/lib/queries";
import { mergeEvents, useThreadEvents } from "@/web/lib/thread-events";

const threadRoute = getRouteApi("/_app/t/$threadId");

export function ThreadPage() {
  const { threadId } = threadRoute.useParams();
  const queryClient = useQueryClient();
  const detail = useQuery(threadQuery(threadId));
  const spaces = useQuery(spacesQuery);
  const models = useQuery(modelsQuery);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const thread = detail.data?.thread;
  const space = spaces.data?.find((s) => s.id === thread?.spaceId);

  useEffect(() => {
    if (thread) rememberSpace(thread.spaceId);
  }, [thread]);

  const spaceId = thread?.spaceId;
  const refreshList = useCallback(() => {
    if (spaceId)
      void queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
  }, [queryClient, spaceId]);
  useThreadEvents(threadId, detail.isSuccess, refreshList);

  async function send(form: HTMLFormElement) {
    const text = new FormData(form).get("text");
    if (typeof text !== "string" || !text.trim()) return;
    setPending(true);
    const res = await apiClient.v1.threads[":id"].messages.$post({
      param: { id: threadId },
      json: { text },
    });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setError(undefined);
    form.reset();
    mergeEvents(queryClient, threadId, [anyThreadEventSchema.parse(await res.json())]);
    await queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey });
    refreshList();
  }

  async function chooseModel(model: string) {
    const res = await apiClient.v1.threads[":id"].$patch({
      param: { id: threadId },
      json: { model },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const updated = threadSchema.parse(await res.json());
    queryClient.setQueryData(threadQuery(threadId).queryKey, (current) =>
      current ? { ...current, thread: updated } : current,
    );
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  if (detail.isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Not found" }]} />
        <p className="p-4 text-muted-foreground">This thread does not exist or is not yours.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={[
          ...(space
            ? [
                {
                  label: space.name,
                  link: { to: "/s/$spaceId" as const, params: { spaceId: space.id } },
                },
              ]
            : []),
          { label: thread?.title ?? "" },
        ]}
      />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 p-4">
        <div className="flex flex-1 flex-col gap-6" aria-label="Events" role="log">
          {detail.data?.events.map((event) => (
            <ThreadEvent key={event.seq} event={event} />
          ))}
        </div>
        <form
          className="sticky bottom-4 flex flex-col gap-2 rounded-xl border bg-background p-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void send(event.currentTarget);
          }}
        >
          <Textarea
            name="text"
            placeholder="Write a message…"
            aria-label="Message"
            className="border-0 shadow-none focus-visible:ring-0"
            onKeyDown={submitOnEnter}
          />
          <div className="flex items-center justify-between gap-2">
            <ModelPicker
              models={models.data?.models ?? []}
              value={thread?.model ?? null}
              onChange={(ref) => void chooseModel(ref)}
              placeholder="Model"
              className="w-56"
            />
            <Button type="submit" disabled={pending}>
              Send
            </Button>
          </div>
          <FieldError>{error}</FieldError>
        </form>
      </div>
    </>
  );
}
