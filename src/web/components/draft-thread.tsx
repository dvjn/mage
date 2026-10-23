// A new thread before its first message: the composer, ready to write in, with the model and
// effort pickers on the space's defaults, then its org's, which can be changed before sending;
// sending makes the thread with them, in the folder it was started from or at the top of the
// space, and opens it. Nothing is made until then. The folder can be changed from the breadcrumb.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { type ModelPair, replyCandidates } from "@/shared/models.ts";
import { type Effort, threadSchema } from "@/shared/threads.ts";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/web/components/ai-elements/conversation";
import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { folderCrumb } from "@/web/components/folder-choice";
import { Composer } from "@/web/components/thread-composer";
import { ThreadPickers } from "@/web/components/thread-pickers";
import { FieldError } from "@/web/components/ui/field";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { rememberSpace } from "@/web/lib/last-space";
import {
  defaultEffortQuery,
  defaultModelQuery,
  modelsQuery,
  spaceFoldersQuery,
  spaceThreadsQuery,
  spacesQuery,
} from "@/web/lib/queries";

const draftRoute = getRouteApi("/_app/s/$spaceId/new");

// Makes a thread in the space with its first message, in a folder or at its top, and opens it;
// throws with what went wrong otherwise.
export function useCreateThread() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (
    spaceId: string,
    text: string,
    options: { folderId?: string; model?: string | null; effort?: Effort | null } = {},
  ) => {
    const { folderId, model, effort } = options;
    const res = await apiClient.v1.spaces[":id"].threads.$post({
      param: { id: spaceId },
      json: {
        text,
        ...(folderId && { folderId }),
        ...(model && { model }),
        ...(effort && { effort }),
      },
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const thread = threadSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
    await navigate({ to: "/t/$threadId", params: { threadId: thread.id }, replace: true });
  };
}

// Writing a new thread's first message, on the model and effort picked beside it or the space's
// defaults; sending makes the thread and opens it. A reader who cannot write in the space sees why.
export function NewThreadComposer({ spaceId, folderId }: { spaceId: string; folderId?: string }) {
  const spaces = useQuery(spacesQuery);
  const models = useQuery(modelsQuery);
  const orgModel = useQuery(defaultModelQuery);
  const orgEffort = useQuery(defaultEffortQuery);
  // Null follows the defaults.
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const create = useCreateThread();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const space = spaces.data?.find((s) => s.id === spaceId);
  const list = models.data?.models ?? [];
  // The first model, with its effort, that can reply for a thread with `own`, as the server
  // decides it from the same list.
  const replying = (own: ModelPair) => {
    const candidates = replyCandidates(
      own,
      { model: space?.defaultModel ?? null, effort: space?.defaultEffort ?? null },
      { model: orgModel.data?.ref ?? null, effort: orgEffort.data?.effort ?? null },
    );
    for (const { ref, effort } of candidates) {
      const found = list.find((m) => m.ref === ref);
      if (found) return { ref: found.ref, name: found.name, effort };
    }
    return null;
  };
  const defaults = space && {
    model: space.defaultModel ?? orgModel.data?.ref ?? null,
    effort: space.defaultEffort ?? orgEffort.data?.effort ?? null,
    used: replying({ model: null, effort: null }),
  };
  // What replies while the model named is turned off or gone: the space's default, then the org's.
  const used = replying({ model, effort });

  async function send(text: string) {
    if (!text.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      await create(spaceId, text, { folderId, model, effort });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the thread");
      throw err;
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <FieldError>{error}</FieldError>
      <Composer
        running={false}
        readOnly={space?.role === "viewer"}
        sending={sending}
        stopping={false}
        onSend={send}
        onStop={() => {}}
        tools={
          <ThreadPickers
            models={models.data?.models ?? []}
            loading={models.isPending}
            model={model}
            effort={effort}
            defaults={defaults}
            used={used}
            onModel={setModel}
            onEffort={setEffort}
          />
        }
      />
    </div>
  );
}

export function DraftThread() {
  const { spaceId } = draftRoute.useParams();
  const { folder: folderId } = draftRoute.useSearch();
  const spaces = useQuery(spacesQuery);
  const folders = useQuery(spaceFoldersQuery(spaceId));
  const navigate = useNavigate();
  const space = spaces.data?.find((s) => s.id === spaceId);
  const folder = folders.data?.find((f) => f.id === folderId);
  const viewer = space?.role === "viewer";

  useEffect(() => rememberSpace(spaceId), [spaceId]);
  // Ready to write in, as each new draft opens.
  useEffect(() => {
    document.querySelector<HTMLTextAreaElement>("textarea[aria-label=Message]")?.focus();
  }, [spaceId, folderId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumbs={[
          ...(space
            ? [{ label: space.name, link: { to: "/s/$spaceId" as const, params: { spaceId } } }]
            : []),
          ...[
            folderCrumb({
              spaceId,
              folders: folders.data ?? [],
              value: folder?.id ?? null,
              canMove: !!space && space.role !== "viewer" && space.role !== null,
              onChange: (id) =>
                void navigate({
                  to: "/s/$spaceId/new",
                  params: { spaceId },
                  search: id ? { folder: id } : {},
                  replace: true,
                }),
            }),
          ].filter((crumb) => crumb !== null),
          { label: "New thread" },
        ]}
      />
      <Conversation aria-label="Events" className="min-h-0">
        <ConversationContent className={cn(pageWidth, "gap-4")}>
          <ConversationEmptyState
            title={folder ? `New thread in ${folder.name}` : "New thread"}
            icon={folder && <FolderIcon className="size-5" />}
            description={
              viewer
                ? "You can read this space's threads; only people who can write in it start new ones."
                : "Write the first message below; the thread starts when you send it."
            }
          />
        </ConversationContent>
      </Conversation>
      <div className={cn(pageWidth, "p-4 pt-0")}>
        <NewThreadComposer spaceId={spaceId} folderId={folder?.id} />
      </div>
    </div>
  );
}
