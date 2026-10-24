// A stand-in SCIM directory: it provisions people and groups into Mage the way an identity provider
// pushes them, with a bearer token, creating people and groups, adding them to groups and taking
// them out, turning people off and on again, and deleting them.

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

  return {
    // Provisions the person; resolves to their id at Mage's SCIM service.
    async createUser(person: ScimPerson) {
      const created = await request("POST", "/Users", {
        schemas: [USER],
        externalId: person.externalId ?? person.email,
        userName: person.email,
        displayName: person.name,
        name: { formatted: person.name },
        emails: [{ value: person.email, primary: true, type: "work" }],
        active: true,
      });
      return created?.id as string;
    },

    setActive(id: string, active: boolean) {
      return patch(`/Users/${id}`, [{ op: "replace", path: "active", value: active }]);
    },

    deleteUser(id: string) {
      return request("DELETE", `/Users/${id}`);
    },

    // Provisions the group with the people in it; resolves to its id at Mage's SCIM service.
    async createGroup(name: string, memberIds: string[] = []) {
      const created = await request("POST", "/Groups", {
        schemas: [GROUP],
        externalId: name,
        displayName: name,
        members: members(memberIds),
      });
      return created?.id as string;
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
