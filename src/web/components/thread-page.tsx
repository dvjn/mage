// A thread: its events as they happen, kept scrolled to the newest, a composer to post messages
// and the thread's model.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { anyThreadEventSchema, threadSchema } from "@/shared/threads.ts";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/web/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/web/components/ai-elements/prompt-input";
import { PageHeader } from "@/web/components/app-shell";
import { ModelPicker } from "@/web/components/model-picker";
import { ThreadEvent } from "@/web/components/thread-events";
import { FieldError } from "@/web/components/ui/field";
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

  // Throws when the message is not posted, so the composer keeps the text.
  async function send(text: string) {
    if (!text.trim()) return;
    setPending(true);
    const res = await apiClient.v1.threads[":id"].messages.$post({
      param: { id: threadId },
      json: { text },
    });
    setPending(false);
    if (!res.ok) {
      const failed = await errorOf(res);
      setError(failed);
      throw new Error(failed);
    }
    setError(undefined);
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

  if (detail.isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Not found" }]} />
        <p className="p-4 text-muted-foreground">This thread does not exist or is not yours.</p>
      </>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
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
      <Conversation aria-label="Events" className="min-h-0">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {detail.data?.events.length === 0 ? (
            <ConversationEmptyState description="Write the first message below." />
          ) : (
            detail.data?.events.map((event) => <ThreadEvent key={event.seq} event={event} />)
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        <PromptInput onSubmit={(message) => send(message.text)}>
          <PromptInputBody>
            <PromptInputTextarea aria-label="Message" placeholder="Write a message…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <ModelPicker
                models={models.data?.models ?? []}
                value={thread?.model ?? null}
                onChange={(ref) => void chooseModel(ref)}
                placeholder="Model"
                className="w-56"
              />
            </PromptInputTools>
            <PromptInputSubmit status={pending ? "submitted" : undefined} disabled={pending} />
          </PromptInputFooter>
        </PromptInput>
        <FieldError className="mt-2">{error}</FieldError>
      </div>
    </div>
  );
}
