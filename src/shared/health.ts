// The body of the API health check, shared by the server and the web client.

import * as z from "zod";

export const healthSchema = z.object({
  ok: z.boolean(),
  database: z.boolean(),
});

export type Health = z.infer<typeof healthSchema>;
