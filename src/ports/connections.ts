// The accounts, keys, cloud credentials and servers an org reaches models through.

import type { AuthKind, HostId } from "@/shared/hosts.ts";

export interface Connection {
  id: string;
  orgId: string;
  // The user who connected it; null once that user is gone.
  createdBy: string | null;
  // Who serves its models.
  host: HostId;
  // A subscription sign-in, a key, cloud credentials or a server's address; an org has one sign-in
  // of each host, and any number of the rest.
  authKind: AuthKind;
  // The account signed in to, a key's masked hint, or what else tells the credentials apart.
  account: string;
  // The name people gave it; null for sign-ins.
  label: string | null;
  // What is not secret about how it connects: the way it does, and fields such as its region.
  settings: Record<string, string>;
  // Whether models the provider adds are turned on when first seen.
  autoEnableModels: boolean;
  createdAt: Date;
}

export type NewConnection = Omit<
  Connection,
  "id" | "createdAt" | "createdBy" | "label" | "autoEnableModels" | "settings"
> & {
  createdBy: string;
  label?: string | null;
  settings?: Record<string, string>;
};

export type ConnectionChanges = Partial<
  Pick<Connection, "authKind" | "account" | "label" | "settings">
>;

export interface ConnectionStore {
  create(connection: NewConnection): Connection;
  list(orgId: string): Connection[];
  // The connection with this id when it belongs to the org.
  find(orgId: string, id: string): Connection | null;
  update(id: string, changes: ConnectionChanges): void;
  setAutoEnableModels(id: string, on: boolean): void;
  delete(id: string): void;
}
