// The array methods that take a test, for a test that must wait: each item is tested in turn, one
// at a time and in order, as the plain methods test them.

type Test<T> = (item: T, index: number) => Promise<unknown>;

export async function filterAsync<T>(items: readonly T[], test: Test<T>): Promise<T[]> {
  const kept: T[] = [];
  for (const [index, item] of items.entries()) if (await test(item, index)) kept.push(item);
  return kept;
}

export async function findAsync<T>(items: readonly T[], test: Test<T>): Promise<T | undefined> {
  for (const [index, item] of items.entries()) if (await test(item, index)) return item;
  return undefined;
}

export async function someAsync<T>(items: readonly T[], test: Test<T>): Promise<boolean> {
  for (const [index, item] of items.entries()) if (await test(item, index)) return true;
  return false;
}

export async function everyAsync<T>(items: readonly T[], test: Test<T>): Promise<boolean> {
  for (const [index, item] of items.entries()) if (!(await test(item, index))) return false;
  return true;
}

// Each item mapped in turn, one at a time and in order, where mapping them all at once would
// interleave their writes.
export async function mapAsync<T, R>(
  items: readonly T[],
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const mapped: R[] = [];
  for (const [index, item] of items.entries()) mapped.push(await map(item, index));
  return mapped;
}
