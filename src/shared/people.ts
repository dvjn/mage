// How a person is named in text written for the model, where they are gone from the org altogether
// and have no name.

export function personLabel(person: { name: string | null }) {
  return person.name ?? "(former member)";
}
