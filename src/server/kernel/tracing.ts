// What traces carry beyond the libraries' own spans: the tracer runs and tool calls start spans
// with, which provider headers outgoing requests record, whether model calls record their whole
// prompts and replies, and what ties each run to the requests that caused it. Without a tracer
// provider started, every span here is a no-op.

import {
  type Attributes,
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  trace,
} from "@opentelemetry/api";

export const tracer = trace.getTracer("mage");

// The provider headers outgoing requests record, by exact name or prefix; every other header, and
// every credential, stays out of traces.
const RECORDED_HEADERS = {
  request: { names: ["anthropic-beta", "anthropic-version", "user-agent", "x-app"], prefixes: [] },
  response: {
    names: ["request-id", "x-request-id", "openai-processing-ms"],
    prefixes: ["anthropic-ratelimit-", "x-ratelimit-"],
  },
} as const;

// The headers of `pairs` that the side records, as span attributes named by the HTTP semantic
// conventions.
export function recordedHeaders(
  side: "request" | "response",
  pairs: Iterable<readonly [string, string]>,
): Attributes {
  const { names, prefixes } = RECORDED_HEADERS[side];
  const attributes: Record<string, string[]> = {};
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    const recorded =
      (names as readonly string[]).includes(name) ||
      (prefixes as readonly string[]).some((prefix) => name.startsWith(prefix));
    if (!recorded) continue;
    (attributes[`http.${side}.header.${name}`] ??= []).push(value);
  }
  return attributes;
}

// A request's headers as the fetch client's diagnostics give them: `name: value` lines, or names
// and values in turn.
export function requestHeaderPairs(headers: string | (string | string[])[]): [string, string][] {
  if (typeof headers === "string") {
    return headers.split("\r\n").flatMap((line): [string, string][] => {
      const at = line.indexOf(":");
      return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
    });
  }
  const pairs: [string, string][] = [];
  for (let at = 0; at + 1 < headers.length; at += 2) {
    const value = headers[at + 1]!;
    for (const one of Array.isArray(value) ? value : [value])
      pairs.push([String(headers[at]), one]);
  }
  return pairs;
}

// A response's headers as the fetch client's diagnostics give them: names and values in turn.
export function responseHeaderPairs(headers: readonly Uint8Array[]): [string, string][] {
  const decoder = new TextDecoder();
  const pairs: [string, string][] = [];
  for (let at = 0; at + 1 < headers.length; at += 2) {
    pairs.push([decoder.decode(headers[at]), decoder.decode(headers[at + 1])]);
  }
  return pairs;
}

let recordsContent = false;

// Set once tracing starts: whether model and tool calls record what they were given and gave back.
export function recordContent(on: boolean) {
  recordsContent = on;
}

export function contentRecorded() {
  return recordsContent;
}

// The AI SDK's telemetry settings for a model call.
export function modelTelemetry() {
  return { recordInputs: recordsContent, recordOutputs: recordsContent };
}

// The span context as a W3C traceparent.
export function traceparentOf(spanContext: SpanContext): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpanContext(ROOT_CONTEXT, spanContext), carrier);
  return carrier.traceparent;
}

// The span of the work in progress, when it is one worth linking to.
function activeSpanContext(): SpanContext | null {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext && trace.isSpanContextValid(spanContext) ? spanContext : null;
}

// How long, and how many, causes wait for a run of their thread to start.
const CAUSE_MS = 10 * 60 * 1000;
const CAUSES_PER_THREAD = 16;

// Ties runs to what caused them: whatever woke a thread (a post, a decision, an answer, a
// notification, or the run before) is linked from the run it starts, and from the run under way,
// which it may steer. Each run's own span is known by its id while it runs, for its readers.
export function createRunTraces(now: () => number = Date.now) {
  const causes = new Map<string, { link: Link; at: number }[]>();
  const runs = new Map<string, string>();

  function fresh(threadId: string) {
    const kept = (causes.get(threadId) ?? []).filter(({ at }) => now() - at < CAUSE_MS);
    if (kept.length > 0) causes.set(threadId, kept);
    else causes.delete(threadId);
    return kept;
  }

  return {
    // Notes the active span as a cause of the thread's next run; the link, or null with none.
    caused(threadId: string): Link | null {
      const spanContext = activeSpanContext();
      if (!spanContext) return null;
      const link = { context: spanContext };
      causes.set(threadId, [...fresh(threadId), { link, at: now() }].slice(-CAUSES_PER_THREAD));
      return link;
    },

    // Takes the causes waiting for the thread's next run.
    take(threadId: string): Link[] {
      const links = fresh(threadId).map(({ link }) => link);
      causes.delete(threadId);
      return links;
    },

    // Starts a run's span in the trace of the first cause, the one that woke the thread, so a turn
    // reads as one trace; later causes are linked. A run without causes is a root of its own.
    start(run: { id: string; threadId: string }, attributes: Attributes): Span {
      const [first, ...rest] = this.take(run.threadId);
      const span = tracer.startSpan(
        "run",
        first ? { links: rest, attributes } : { root: true, attributes },
        first ? trace.setSpanContext(ROOT_CONTEXT, first.context) : ROOT_CONTEXT,
      );
      const traceparent = traceparentOf(span.spanContext());
      if (span.isRecording() && traceparent) runs.set(run.id, traceparent);
      return span;
    },

    // Forgets the run's span once it ended.
    ended(runId: string) {
      runs.delete(runId);
    },

    // The traceparent of the run's span while it runs.
    traceparent(runId: string): string | undefined {
      return runs.get(runId);
    },
  };
}

export type RunTraces = ReturnType<typeof createRunTraces>;
