// Sign-ins a user has started in their browser and not yet finished; each is used once.

export type SignInKind = "codex";

export interface SignInAttempt {
  kind: SignInKind;
  state: string;
  codeVerifier: string;
  orgId: string;
  userId: string;
  expiresAt: Date;
}

export interface SignInAttemptStore {
  create(attempt: SignInAttempt): void;
  // Removes and returns the attempt of this kind and state when the user started it in the org.
  take(match: {
    kind: SignInKind;
    state: string;
    orgId: string;
    userId: string;
  }): SignInAttempt | null;
  deleteExpired(now: Date): void;
}
