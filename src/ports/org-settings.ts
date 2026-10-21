// Choices an org makes for everyone in it.

export interface OrgSettings {
  // A model ref such as `codex/gpt-5`, or null when the org has not picked one.
  defaultModel: string | null;
  // The model ref that names threads, or null to choose one automatically.
  titleModel: string | null;
}

export interface OrgSettingStore {
  get(orgId: string): OrgSettings;
  setDefaultModel(orgId: string, ref: string): void;
  setTitleModel(orgId: string, ref: string | null): void;
}
