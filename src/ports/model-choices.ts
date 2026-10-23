// Which of a connection's models people can pick, and when each was first seen in its list.

export interface ModelChoice {
  enabled: boolean;
  firstSeenAt: Date;
}

export interface ModelChoiceStore {
  // Records the models of the list not seen before, turned on or off as given, and returns every
  // model's choice by id.
  sync(
    connectionId: string,
    modelIds: string[],
    enableNew: boolean,
    now: Date,
  ): Map<string, ModelChoice>;
  // Turns the models given on or off, recording those not seen before as first seen now.
  set(connectionId: string, modelIds: string[], enabled: boolean, now: Date): void;
}
