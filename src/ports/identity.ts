// Who is making a request: the signed-in user, the org they act in and their role there.

import type { OrgRole } from "./directory.ts";

export interface Principal {
  userId: string;
  orgId: string;
  role: OrgRole;
}

export interface Profile {
  user: { id: string; name: string; email: string };
  // The owner's name, or null when the org has none.
  org: { id: string; name: string; kind: "personal" | "team"; ownerName: string | null };
  role: OrgRole;
}

// The signed-in user, and the principal they act as in the org asked for; null there when they
// are not in it.
export interface SignedIn {
  userId: string;
  email: string;
  principal: Principal | null;
}

export interface Identity {
  // Null when the request carries no valid session. `orgId` is the org the request names; without
  // one, the org the user used last.
  resolve(headers: Headers, orgId: string | null): Promise<SignedIn | null>;
  profile(principal: Principal): Promise<Profile>;
}
