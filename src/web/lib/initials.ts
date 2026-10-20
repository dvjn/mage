// The initials of a name, for an avatar that has no picture. Punctuation around a word, as in
// "(former member)", is skipped.

export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
