// The signed-in user, their active org and their role in it, and how the org is named to them,
// shared by the server and the web client.

import * as z from "zod";

export const meSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  org: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["personal", "team"]),
    // Who owns it; for a personal org, the person it is named after.
    ownerName: z.string().nullable(),
  }),
  role: z.string(),
});

// How the switcher names the org: "Personal" for the signed-in person's own personal org, "Ada's
// Personal" for someone else's, and a team org by its name.
export function orgSubtitle(me: Pick<Me, "org" | "role">) {
  if (me.org.kind === "team") return me.org.name;
  if (me.role === "owner") return "Personal";
  return `${me.org.ownerName ?? me.org.name}'s Personal`;
}

export type Me = z.infer<typeof meSchema>;
