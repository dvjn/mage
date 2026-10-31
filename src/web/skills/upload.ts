// Uploads a SKILL.md or a zip of skill folders.

import { useToast } from "@/web/shell/toaster";
import type { Scope } from "@/web/shell/scope";
import { plural } from "@/web/lib/plural";
import type { Draft } from "@/web/skills/written-dialog";
import { useUploadSkills } from "@/web/skills/mutations";

// Uploads a SKILL.md or a zip of skills; a file that does not name or describe its skill opens the
// new skill dialog with what it holds.
export function useUpload(scope: Scope, onDraft: (draft: Draft) => void) {
  const toast = useToast();
  const uploading = useUploadSkills(scope);

  function upload(file: File) {
    uploading.mutate(file, {
      onSuccess: (result) => {
        if (result.status === "draft") {
          onDraft(result.draft);
          return;
        }
        const [first] = result.skills;
        toast(
          result.skills.length === 1 && first
            ? `Added ${first.name}${first.enabled ? "" : ", off"}`
            : `Added ${plural(result.skills.length, "skill")}, off`,
          "info",
        );
      },
    });
  }

  return { upload, uploading: uploading.isPending, error: uploading.error?.message };
}
