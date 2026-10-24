// The agent's runs: one per wake-up of the agent in a thread, at most one active per thread at a
// time. A worker holds a running run under a lease; each claim raises the run's lease epoch, and
// every write for the run checks the epoch it holds, so a worker that lost its lease writes nothing.

import type { FailureKind, RunReason } from "@/shared/threads.ts";

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type EndStatus = Extract<RunStatus, "completed" | "failed" | "cancelled">;

export interface Run {
  id: string;
  threadId: string;
  status: RunStatus;
  // The seq of the message that woke the agent.
  triggerSeq: number;
  // The model ref it replied with, once it started.
  model: string | null;
  // The run this one follows, and why.
  continuesRunId: string | null;
  reason: RunReason | null;
  // Who woke the agent; null for a retry or once that user is gone.
  createdBy: string | null;
  // How many times this input has been tried, counting this run.
  attempt: number;
  cancelRequestedAt: Date | null;
  cancelRequestedBy: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  leaseEpoch: number;
  error: string | null;
  errorKind: FailureKind | null;
  errorDetail: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface NewRun {
  threadId: string;
  triggerSeq: number;
  createdBy: string | null;
  continuesRunId?: string | null;
  reason?: RunReason | null;
  attempt?: number;
}

// The right to write for a run, held by one worker until it ends or expires.
export interface Lease {
  runId: string;
  owner: string;
  epoch: number;
}

// Thrown by a write whose lease no longer holds.
export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`lease on run ${runId} lost`);
  }
}

export interface RunStore {
  create(run: NewRun): Run;
  find(id: string): Run | null;
  // The thread's newest run.
  latest(threadId: string): Run | null;
  // The thread's queued, running or waiting run.
  active(threadId: string): Run | null;
  // The threads with a queued, running or waiting run.
  activeThreadIds(): string[];
  // The queued, running and waiting runs of the space's threads, or of the threads named.
  activeInSpace(spaceId: string): Run[];
  activeIn(threadIds: string[]): Run[];
  // Asks the thread's active run to stop, unless someone already has; null when there is none.
  requestCancel(threadId: string, userId: string, at: Date): Run | null;
  // Takes the oldest queued run for the owner until `expiresAt`.
  claim(owner: string, expiresAt: Date): Run | null;
  // Takes a running run whose lease expired before `before`, or any running run without `before`.
  takeOver(id: string, owner: string, expiresAt: Date, before?: Date): Run | null;
  // Running runs whose lease expired before `before`, or every running run without it.
  stale(before?: Date): Run[];
  // The run as it is now; throws LeaseLost unless the lease holds.
  hold(lease: Lease): Run;
  // Extends the lease; throws LeaseLost unless it holds.
  renew(lease: Lease, expiresAt: Date): Run;
  // Records the model the run replies with.
  setModel(lease: Lease, model: string): void;
  // Lets the lease go while the run waits for a person's decision; nothing holds it meanwhile.
  wait(lease: Lease): Run;
  // Queues a waiting run again, to be claimed like any other; false when it was not waiting.
  resume(runId: string): boolean;
  // Ends the run and lets its lease go.
  end(
    lease: Lease,
    outcome: {
      status: EndStatus;
      error?: string;
      errorKind?: FailureKind;
      errorDetail?: string;
      usage?: { inputTokens: number; outputTokens: number };
    },
  ): Run;
}
