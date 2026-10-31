// Changes to skills, which the skills lists then read again: any one change, uploading skills,
// and adding a repository.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { skillSourceSchema, skillUploadResultSchema, UPLOAD_MAX_BYTES } from "@/shared/skills.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import type { Scope } from "@/web/shell/scope";

// Runs a change and reads the skills again, keeping what went wrong. A change that fails answers
// null.
export function useChange() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (send: () => Promise<Response>) => {
      const res = await send();
      if (!res.ok) throw new Error(await errorOf(res));
      return res;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  return {
    error: mutation.error?.message,
    pending: mutation.isPending,
    run: (send: () => Promise<Response>) => mutation.mutateAsync(send).catch(() => null),
  };
}

// Uploads a SKILL.md or a zip of skill folders. One that does not name or describe its skill comes
// back as a draft to finish, and adds nothing yet.
export function useUploadSkills(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (file.size > UPLOAD_MAX_BYTES) throw new Error("This file is too large");
      const json = {
        fileName: file.name,
        data: base64Of(new Uint8Array(await file.arrayBuffer())),
      };
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org.skills.upload.$post({ json })
          : await apiClient.v1.spaces[":id"].skills.upload.$post({
              param: { id: scope.spaceId },
              json,
            });
      if (!res.ok) throw new Error(await errorOf(res));
      return skillUploadResultSchema.parse(await res.json());
    },
    onSuccess: async (result) => {
      if (result.status !== "draft") await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

function base64Of(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

// A repository that could not be added, and why: "auth" or "not_found" asks for a token.
export class AddRepositoryError extends Error {
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}

// Adds a repository of skills whole, from owner/repo, a git address or a command that adds skills.
export function useAddRepository(scope: Scope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: { input: string; token?: string }) => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org["skill-sources"].$post({ json })
          : await apiClient.v1.spaces[":id"]["skill-sources"].$post({
              param: { id: scope.spaceId },
              json,
            });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          reason?: string;
        } | null;
        throw new AddRepositoryError(
          body?.error ?? "Something went wrong. Try again.",
          body?.reason,
        );
      }
      return skillSourceSchema.parse(await res.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
}
