// A stand-in SCIM directory: it provisions people and groups into Mage the way an identity provider
// pushes them, with a bearer token, creating people and groups, adding them to groups and taking
// them out, turning people off and on again, and deleting them. Given a directory of its own, it
// pushes all of it, finding each person by user name and each group by name, so pushing again
// changes only what changed.

import { subjectOf } from "./identity.ts";

// The token the browser journeys' server takes from its directory.
export const JOURNEY_SCIM_TOKEN = "mage-browser-journeys-scim-token-0123456789";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export interface ScimClientOptions {
  // Where Mage is served.
  baseUrl: string;
  token: string;
  // How requests are sent; the global fetch by default.
  fetch?: (url: string, init: RequestInit) => Response | Promise<Response>;
}

export interface ScimPerson {
  name: string;
  email: string;
  // The person's id at the directory; the email by default.
  externalId?: string;
  // What they sign in to the directory with; the email by default.
  userName?: string;
}

export interface DirectoryGroup {
  name: string;
  email?: string;
  // Its people, by user name.
  members: string[];
}

export function scimClient(options: ScimClientOptions) {
  const send = options.fetch ?? fetch;
  const base = `${options.baseUrl.replace(/\/+$/, "")}/api/auth/scim/v2`;

  async function request(method: string, path: string, body?: object) {
    const res = await send(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(body && { "Content-Type": "application/scim+json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!res.ok)
      throw new Error(`SCIM ${method} ${path} answered ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : ((await res.json()) as { id: string });
  }

  function patch(path: string, operations: object[]) {
    return request("PATCH", path, { schemas: [PATCH], Operations: operations });
  }

  const members = (ids: string[]) => ids.map((value) => ({ value }));

  const userOf = (person: ScimPerson) => ({
    schemas: [USER],
    externalId: person.externalId ?? person.email,
    userName: person.userName ?? person.email,
    displayName: person.name,
    name: { formatted: person.name },
    emails: [{ value: person.email, primary: true, type: "work" }],
    active: true,
  });

  const groupOf = (name: string, memberIds: string[], email?: string) => ({
    schemas: [GROUP],
    externalId: name,
    displayName: name,
    members: members(memberIds),
    ...(email && { emails: [{ value: email, type: "work", primary: true }] }),
  });

  // The id of the one resource the filter finds, if any.
  async function find(path: string, filter: string) {
    const found = (await request("GET", `${path}?filter=${encodeURIComponent(filter)}`)) as {
      Resources?: { id: string }[];
    } | null;
    return found?.Resources?.[0]?.id ?? null;
  }

  return {
    // Provisions the person; resolves to their id at Mage's SCIM service.
    async createUser(person: ScimPerson) {
      const created = await request("POST", "/Users", userOf(person));
      return created?.id as string;
    },

    // Provisions the person, or replaces what Mage has for the one with their user name.
    async putUser(person: ScimPerson) {
      const id = await find(
        "/Users",
        `userName eq ${JSON.stringify(person.userName ?? person.email)}`,
      );
      const saved = id
        ? await request("PUT", `/Users/${id}`, userOf(person))
        : await request("POST", "/Users", userOf(person));
      return saved?.id as string;
    },

    // Provisions the group with these people, or replaces the one with its name.
    async putGroup(name: string, memberIds: string[], email?: string) {
      const id = await find("/Groups", `displayName eq ${JSON.stringify(name)}`);
      const saved = id
        ? await request("PUT", `/Groups/${id}`, groupOf(name, memberIds, email))
        : await request("POST", "/Groups", groupOf(name, memberIds, email));
      return saved?.id as string;
    },

    setActive(id: string, active: boolean) {
      return patch(`/Users/${id}`, [{ op: "replace", path: "active", value: active }]);
    },

    deleteUser(id: string) {
      return request("DELETE", `/Users/${id}`);
    },

    // Provisions the group with the people in it; resolves to its id at Mage's SCIM service.
    async createGroup(name: string, memberIds: string[] = [], email?: string) {
      const created = await request("POST", "/Groups", groupOf(name, memberIds, email));
      return created?.id as string;
    },

    // Sets the group's email the way Entra ID sends a mapped attribute, or takes it away.
    setGroupEmail(groupId: string, email: string | null) {
      return patch(
        `/Groups/${groupId}`,
        email
          ? [{ op: "replace", path: 'emails[type eq "work"].value', value: email }]
          : [{ op: "remove", path: "emails" }],
      );
    },

    addMembers(groupId: string, memberIds: string[]) {
      return patch(`/Groups/${groupId}`, [
        { op: "add", path: "members", value: members(memberIds) },
      ]);
    },

    removeMembers(groupId: string, memberIds: string[]) {
      return patch(`/Groups/${groupId}`, [
        { op: "remove", path: "members", value: members(memberIds) },
      ]);
    },

    deleteGroup(groupId: string) {
      return request("DELETE", `/Groups/${groupId}`);
    },
  };
}

export type ScimClient = ReturnType<typeof scimClient>;

// Pushes the whole directory: each person, known to Mage by the subject they sign in with, then
// each group with its people.
export async function pushDirectory(
  client: ScimClient,
  people: (ScimPerson & { userName: string })[],
  groups: DirectoryGroup[],
) {
  const ids = new Map<string, string>();
  for (const person of people) {
    ids.set(
      person.userName,
      await client.putUser({ ...person, externalId: person.externalId ?? subjectOf(person.email) }),
    );
  }
  for (const group of groups) {
    const memberIds = group.members.flatMap((userName) => ids.get(userName) ?? []);
    await client.putGroup(group.name, memberIds, group.email);
  }
}
