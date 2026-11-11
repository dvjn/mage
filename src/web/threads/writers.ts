// Who has written in a thread, as its row in a list says it: a short line of the first names of
// the one or two who wrote last, "You" for whoever is signed in, then how many more there are
// ("Grace, You +3"); and in full, every name a list has with a guest marked, for its tooltip.

import { displayName } from "@/web/lib/people.ts";
import type { ThreadParticipants } from "@/shared/threads/list.ts";

const names = new Intl.ListFormat(undefined, { type: "conjunction" });

// The most names the short line shows.
const SHOWN = 2;

// A person's first name; one who is gone from the org altogether has none and is named whole.
function firstName(person: { name: string | null }) {
  const name = displayName(person);
  if (person.name === null) return name;
  return name.trim().split(/\s+/)[0] || name;
}

// "Grace, You +3", or null while nobody has written.
export function writerLine({ people, total }: ThreadParticipants, meId?: string) {
  if (people.length === 0) return null;
  const shown = people
    .slice(0, SHOWN)
    .map((person) => (person.userId === meId ? "You" : firstName(person)));
  const more = total - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more}` : shown.join(", ");
}

// "Hedy Lamarr (guest), Ada Lovelace, and 2 more", or null while nobody has written.
export function writersInFull({ people, total }: ThreadParticipants) {
  if (people.length === 0) return null;
  const more = total - people.length;
  return names.format([
    ...people.map((person) =>
      person.guest ? `${displayName(person)} (guest)` : displayName(person),
    ),
    ...(more > 0 ? [`${more} more`] : []),
  ]);
}
