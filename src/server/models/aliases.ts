// The short names an org's connections go by in the model aliases the agent reads and writes,
// `<slug>/<model id>`: each from the name people gave the connection, or else its host's, and
// unique within the org. They are worked out from the connections as they are, never stored, so
// renaming a connection changes its slug.

import { connectionName } from "@/shared/connections.ts";
import { HOSTS } from "@/shared/hosts.ts";

import type { Connection } from "./connections.ts";

type Named = Pick<Connection, "id" | "host" | "authKind" | "label">;

const MAX_LENGTH = 32;

// Lower-case letters and digits, with a hyphen for each run of anything else.
export function slugOf(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_LENGTH)
    .replace(/^-+|-+$/g, "");
}

// Each connection's slug by its id. Of connections that would share one, the earlier in the list
// keeps it and the later take a number. None takes what stored refs call another connection, a
// sign-in's host or a connection's id, so a ref reads the same as before.
export function connectionSlugs(list: readonly Named[]): Map<string, string> {
  const stored = new Map<string, string>();
  for (const connection of list) {
    stored.set(connection.id, connection.id);
    if (connection.authKind === "oauth") stored.set(connection.host, connection.id);
  }
  const slugs = new Map<string, string>();
  const taken = new Set<string>();
  for (const connection of list) {
    const base =
      slugOf(connectionName(connection) ?? HOSTS[connection.host].label) || connection.host;
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      if (taken.has(slug) || (stored.get(slug) ?? connection.id) !== connection.id) continue;
      taken.add(slug);
      slugs.set(connection.id, slug);
      break;
    }
  }
  return slugs;
}
