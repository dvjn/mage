// Provider accounts an org reaches models through.

export interface Connection {
  id: string;
  orgId: string;
  // The user who connected it; null once that user is gone.
  createdBy: string | null;
  provider: "openai" | "anthropic";
  // A subscription sign-in, or an API key; an org has one sign-in of each kind, and any number of
  // keys.
  authKind: "codex" | "claude" | "api_key";
  // The provider account, or a key's masked hint.
  account: string;
  // The name people gave a key; null for sign-ins.
  label: string | null;
  // Whether models the provider adds are turned on when first seen.
  autoEnableModels: boolean;
  createdAt: Date;
}

export type NewConnection = Omit<
  Connection,
  "id" | "createdAt" | "createdBy" | "label" | "autoEnableModels"
> & {
  createdBy: string;
  label?: string | null;
};

export interface ConnectionStore {
  create(connection: NewConnection): Connection;
  list(orgId: string): Connection[];
  // The connection with this id when it belongs to the org.
  find(orgId: string, id: string): Connection | null;
  setLabel(id: string, label: string | null): void;
  setAutoEnableModels(id: string, on: boolean): void;
  delete(id: string): void;
}
