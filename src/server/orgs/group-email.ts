// A group's mail address from what a SCIM directory sends. The SCIM library keeps only a group's
// name, external id and members, so the address is read here from the same requests and kept on the
// group beside them. Directories send it as the standard `emails` list (Entra ID with a mapping to
// `emails[type eq "work"].value`, Authentik with a group mapping), or, from Entra's group
// extension, as the primary one of `proxyAddresses`.

import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

import { scimGroup } from "./schema.ts";

const ENTRA_GROUP = "urn:ietf:params:scim:schemas:extension:microsoft:entra:2.0:group";
const GROUPS_PATH = /\/scim\/v2\/Groups(?:\/([^/?]+))?\/?$/;

type Json = Record<string, unknown>;

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The address of an `emails` list: the work one, else the primary one, else the first.
function fromEmails(value: unknown) {
  if (typeof value === "string") return textOf(value);
  const list = (Array.isArray(value) ? value : [value]).filter(isObject);
  const typed = (type: string) =>
    list.find((e) => String(e.type).toLowerCase() === type && e.value);
  const entry = typed("work") ?? list.find((e) => e.primary === true && e.value) ?? list[0];
  return entry ? textOf(entry.value) : null;
}

// The primary address of `proxyAddresses`: the one that starts with an upper-case `SMTP:`.
function fromProxyAddresses(value: unknown) {
  const list = Array.isArray(value) ? value : [value];
  const primary = list.find((a) => typeof a === "string" && a.startsWith("SMTP:"));
  return typeof primary === "string" ? textOf(primary.slice(5)) : null;
}

// The address of a group's attributes, null when it has none.
export function emailOfGroup(body: unknown): string | null {
  if (!isObject(body)) return null;
  const extension = Object.entries(body).find(([key]) => key.toLowerCase() === ENTRA_GROUP)?.[1];
  return (
    fromEmails(body.emails) ??
    (isObject(extension) ? fromProxyAddresses(extension.proxyAddresses) : null)
  );
}

function touchesEmail(operation: Json) {
  const path = typeof operation.path === "string" ? operation.path.toLowerCase() : "";
  return path.startsWith("emails") || path.startsWith(`${ENTRA_GROUP}:proxyaddresses`);
}

// What a PATCH does to the address: nothing (undefined), takes it away (null), or sets it; and the
// PATCH without the operations on it, which the SCIM library does not accept.
export function readPatch(body: unknown): { email: string | null | undefined; rest: unknown } {
  if (!isObject(body)) return { email: undefined, rest: body };
  const key = "Operations" in body ? "Operations" : "operations";
  const operations = body[key];
  if (!Array.isArray(operations)) return { email: undefined, rest: body };
  let email: string | null | undefined;
  const kept: unknown[] = [];
  for (const operation of operations) {
    if (!isObject(operation)) {
      kept.push(operation);
      continue;
    }
    const op = String(operation.op).toLowerCase();
    if (touchesEmail(operation)) {
      const path = String(operation.path).toLowerCase();
      if (op === "remove") email = null;
      else if (op === "add" || op === "replace") {
        email =
          (path.startsWith("emails")
            ? fromEmails(operation.value)
            : fromProxyAddresses(operation.value)) ?? null;
      }
    } else if (!operation.path && op !== "remove" && isObject(operation.value)) {
      const { emails: _emails, ...value } = operation.value;
      const extensionKey = Object.keys(value).find((k) => k.toLowerCase() === ENTRA_GROUP);
      if ("emails" in operation.value || extensionKey) {
        email = emailOfGroup(operation.value);
        if (extensionKey) delete value[extensionKey];
        if (Object.keys(value).length) kept.push({ ...operation, value });
      } else kept.push(operation);
    } else kept.push(operation);
  }
  return { email, rest: { ...body, [key]: kept } };
}

// Wraps the auth handler: after the directory's create, replace or patch of a group succeeded, the
// group keeps the address it sent.
export function keepGroupEmails(db: Db, handle: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    const target = GROUPS_PATH.exec(new URL(request.url).pathname);
    const method = request.method;
    if (!target || !["POST", "PUT", "PATCH"].includes(method)) return handle(request);
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => undefined);
    let email: string | null | undefined;
    let forwarded = request;
    if (method === "PATCH") {
      const patch = readPatch(body);
      email = patch.email;
      // Authentik leaves out the PATCH message schema, which the SCIM library requires.
      const unnamed = isObject(patch.rest) && !("schemas" in patch.rest);
      if (unnamed) patch.rest = { schemas: [PATCH_OP], ...(patch.rest as Json) };
      if (email !== undefined || unnamed) {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        const operations = patch.rest as { Operations?: unknown[]; operations?: unknown[] };
        const none = !(operations.Operations ?? operations.operations)?.length;
        // With nothing else to do, the group is answered as it stands.
        forwarded = none
          ? new Request(request.url, { method: "GET", headers })
          : new Request(request.url, { method, headers, body: JSON.stringify(patch.rest) });
      }
    } else email = emailOfGroup(body);
    const response = await handle(forwarded);
    if (!response.ok) return response;
    const id =
      target[1] ??
      (
        (await response
          .clone()
          .json()
          .catch(() => undefined)) as { id?: string } | undefined
      )?.id;
    if (!id || email === undefined) return response;
    db.update(scimGroup)
      .set({ email, emailKey: email ? email.toLowerCase() : null })
      .where(eq(scimGroup.id, id))
      .run();
    return response;
  };
}
