// Who is making a request: the signed-in user, the org they act in and their role there.

export interface Principal {
  userId: string;
  orgId: string;
  role: string;
}

export interface Profile {
  user: { id: string; name: string; email: string };
  // The owner's name, or null when the org has none.
  org: { id: string; name: string; kind: "personal" | "team"; ownerName: string | null };
  role: string;
}

export interface Identity {
  // Null when the request carries no valid session.
  resolve(headers: Headers): Promise<Principal | null>;
  profile(principal: Principal): Promise<Profile>;
}
