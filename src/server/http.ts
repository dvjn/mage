import { validator } from "hono/validator";
import type * as z from "zod";

import type { Principal, SignedIn } from "@/server/orgs/identity.ts";

export type ApiEnv = { Variables: { principal: Principal | null; account: SignedIn | null } };

// Set for every org route behind the signed-in check.
export function signedIn(principal: Principal | null): Principal {
  if (!principal) throw new Error("route reached without a principal");
  return principal;
}

// A JSON body that must match the schema; otherwise 400 with the error given.
export function jsonBody<T extends z.ZodType>(schema: T, error: string) {
  return validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return c.json({ error }, 400);
    return parsed.data as z.output<T>;
  });
}

// A body that must match the schema; otherwise 400 with what is wrong first.
export function checkedBody<T extends z.ZodType>(schema: T) {
  return validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "The body is not valid" }, 400);
    }
    return parsed.data as z.output<T>;
  });
}

// A query string that must match the schema; otherwise 400.
export function queryOf<T extends z.ZodType>(schema: T) {
  return validator("query", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return c.json({ error: "Give q, limit, cursor and filters as they are" }, 400);
    return parsed.data as z.output<T>;
  });
}
