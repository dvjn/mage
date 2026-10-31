// The instructions an org, or one of its spaces, gives the agent.

export interface InstructionRecord {
  text: string;
  updatedAt: Date;
}

export interface InstructionStore {
  // The org's own with no space given, or the space's.
  get(orgId: string, spaceId: string | null): InstructionRecord | null;
  set(orgId: string, spaceId: string | null, text: string, userId: string): void;
}
