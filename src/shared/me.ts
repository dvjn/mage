// The signed-in user, their active org and their role in it, shared by the server and the web client.

import * as z from "zod";

export const meSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  org: z.object({ id: z.string(), name: z.string(), kind: z.enum(["personal", "team"]) }),
  role: z.string(),
});

export type Me = z.infer<typeof meSchema>;
