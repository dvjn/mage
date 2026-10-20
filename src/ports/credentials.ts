// Secrets held for a connection, kept sealed at rest and only readable by the server.

export type Credential = Record<string, unknown>;

export interface CredentialStore {
  put(connectionId: string, credential: Credential): void;
  // Null when the connection has none; throws when the stored value fails authentication.
  get(connectionId: string): Credential | null;
  delete(connectionId: string): void;
}
