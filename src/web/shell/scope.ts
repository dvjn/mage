// Whose settings a page shows: the org's, or one space's own.
export type Scope = { kind: "org" } | { kind: "space"; spaceId: string };
