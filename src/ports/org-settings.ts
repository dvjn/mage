// Choices an org makes for everyone in it.

import type { Effort } from "@/shared/threads.ts";

export interface OrgSettings {
  // A model ref such as `codex/gpt-5`, or null when the org has not picked one.
  defaultModel: string | null;
  // The model ref that names threads, or null to choose one automatically.
  titleModel: string | null;
  // The reasoning effort new threads start with, or null for the usual one.
  defaultEffort: Effort | null;
  // Who may make shared spaces in a team org.
  spaceCreation: "members" | "owners";
  // Whether each member of a team org gets a private space of their own on joining.
  memberSpaces: boolean;
}

export interface OrgSettingStore {
  get(orgId: string): OrgSettings;
  setDefaultModel(orgId: string, ref: string): void;
  setTitleModel(orgId: string, ref: string | null): void;
  setDefaultEffort(orgId: string, effort: Effort | null): void;
  setTeamSettings(
    orgId: string,
    changes: Partial<Pick<OrgSettings, "spaceCreation" | "memberSpaces">>,
  ): void;
}
