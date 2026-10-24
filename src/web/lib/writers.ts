// Who has written in a thread, as its row in a list says it: a short line of the first names of
// the one or two who wrote last, "You" for whoever is signed in, then how many more there are
// ("Grace, You +3"); and in full, every name a list has with a guest marked, for its tooltip.

import type { ThreadParticipants } from "@/shared/threads.ts";

const names = new Intl.ListFormat(undefined, { type: "conjunction" });

// The most names the short line shows.
const SHOWN = 2;

// A name's first word; a name in brackets, as a former member's is, stays whole.
function firstName(name: string) {
  if (name.startsWith("(")) return name;
  return name.trim().split(/\s+/)[0] || name;
}

// "Grace, You +3", or null while nobody has written.
export function writerLine({ people, total }: ThreadParticipants, meId?: string) {
  if (people.length === 0) return null;
  const shown = people
    .slice(0, SHOWN)
    .map((person) => (person.userId === meId ? "You" : firstName(person.name)));
  const more = total - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more}` : shown.join(", ");
}

// "Hedy Lamarr (guest), Ada Lovelace, and 2 more", or null while nobody has written.
export function writersInFull({ people, total }: ThreadParticipants) {
  if (people.length === 0) return null;
  const more = total - people.length;
  return names.format([
    ...people.map((person) => (person.guest ? `${person.name} (guest)` : person.name)),
    ...(more > 0 ? [`${more} more`] : []),
  ]);
}
