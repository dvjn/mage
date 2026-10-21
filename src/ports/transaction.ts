// Runs synchronous store work as one transaction: all of its writes happen, or none.

export type Transact = <T>(work: () => T) => T;
