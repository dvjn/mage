// The ways to sign in this server offers, shared by the server and the web client.

import * as z from "zod";

export const signInOptionsSchema = z.object({
  // The identity provider people sign in with, by the name its button shows. With one, it is the
  // only way in; without one, people sign in and up with a password.
  oidc: z.object({ name: z.string() }).nullable(),
});

export type SignInOptions = z.infer<typeof signInOptionsSchema>;
