// The error message the API sent with a failed response.

import { apiErrorSchema } from "@/shared/connections.ts";

export async function errorOf(res: { json(): Promise<unknown> }) {
  const body = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error : "Something went wrong. Try again.";
}
