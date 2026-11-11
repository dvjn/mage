// Deleting an artifact, from the header's more menu, for those the server says may: a question
// that names the threads that used it, and says it goes for everyone.

import { Link } from "@tanstack/react-router";

import type { ArtifactDetail } from "@/shared/artifacts.ts";
import { useDeleteArtifact } from "@/web/artifacts/mutations";
import { ConfirmDialog } from "@/web/components/confirm-dialog";

export function DeleteArtifact({
  artifact,
  open,
  onOpenChange,
}: {
  artifact: ArtifactDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteArtifact(artifact.id);
  if (!artifact.canDelete) return null;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${artifact.title}?`}
      description="It is removed for everyone, with all its versions."
      error={remove.error?.message}
      action="Delete"
      disabled={remove.isPending}
      onConfirm={() => remove.mutate()}
    >
      {artifact.usedIn.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Used in</p>
          <ul className="flex max-h-48 flex-col overflow-y-auto text-sm">
            {artifact.usedIn.map((thread) => (
              <li key={thread.id}>
                <Link
                  to="/t/$threadId"
                  params={{ threadId: thread.id }}
                  className="block truncate py-0.5 hover:underline"
                >
                  {thread.title ?? "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConfirmDialog>
  );
}
