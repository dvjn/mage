// A count with its noun, as "1 skill" or "3 skills".
export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
