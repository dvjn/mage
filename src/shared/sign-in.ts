// The ways to sign in this server offers, shared by the server and the web client.

import * as z from "zod";

export const signInOptionsSchema = z.object({
  // Who may sign in with a password: everyone, only the operators, or nobody.
  password: z.enum(["everyone", "operator", "off"]),
  // The identity provider people can sign in with, by the name its button shows.
  oidc: z.object({ name: z.string() }).nullable(),
});

export type SignInOptions = z.infer<typeof signInOptionsSchema>;
