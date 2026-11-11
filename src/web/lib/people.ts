// How a person is named where the server sent no name: someone gone from the org altogether.

const FORMER_MEMBER = "Former member";

export function displayName(person: { name: string | null }) {
  return person.name ?? FORMER_MEMBER;
}
