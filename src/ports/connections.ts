// Provider accounts an org reaches models through.

export interface Connection {
  id: string;
  orgId: string;
  // The user who connected it; null once that user is gone.
  createdBy: string | null;
  provider: "openai";
  authKind: "codex";
  account: string;
  createdAt: Date;
}

export type NewConnection = Omit<Connection, "id" | "createdAt" | "createdBy"> & {
  createdBy: string;
};

export interface ConnectionStore {
  create(connection: NewConnection): Connection;
  list(orgId: string): Connection[];
  // The connection with this id when it belongs to the org.
  find(orgId: string, id: string): Connection | null;
  delete(id: string): void;
}
