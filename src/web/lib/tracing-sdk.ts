// The web client's tracing, loaded only while the server traces: the page's load, requests to the
// server carrying the trace they belong to, people's actions as spans, and, for each run, when its
// reply first shows and when it is done, linked to the run's span on the server. Spans go to the
// server, which passes them on.

import {
  type Context,
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const tracer = trace.getTracer("mage-web");

// How long after an action the thread's next run is taken to answer it.
const ACTION_MS = 2 * 60 * 1000;

export function start() {
  const spans = new URL("/api/web/traces", window.location.origin).href;
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ "service.name": "mage-web" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: spans }))],
  });
  provider.register();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new DocumentLoadInstrumentation(),
      // Only requests to this server carry the trace; sending spans is not traced itself.
      new FetchInstrumentation({ ignoreUrls: [spans], clearTimingResources: true }),
    ],
  });
}

// The last action in each thread, for the run that answers it.
const actions = new Map<string, { context: Context; start: number }>();

export function traced<T>(
  name: string,
  threadId: string | null,
  action: () => Promise<T>,
  threadOf?: (result: T) => string,
): Promise<T> {
  const attributes = threadId ? { "thread.id": threadId } : {};
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    const taken = { context: context.active(), start: Date.now() };
    if (threadId) actions.set(threadId, taken);
    try {
      const result = await action();
      const found = threadId ?? threadOf?.(result);
      if (found && !threadId) {
        span.setAttribute("thread.id", found);
        actions.set(found, taken);
      }
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

// A run as the thread's reader follows it, while it replies: since when, the action it answers and
// the run's span on the server, once known.
interface Followed {
  runId: string;
  start: number;
  parent: Context;
  trace?: string;
  link?: Link;
  shown: boolean;
}

const followed = new Map<string, Followed>();

function linkOf(traceparent: string): Link | undefined {
  const spanContext = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent }));
  return spanContext && trace.isSpanContextValid(spanContext)
    ? { context: spanContext }
    : undefined;
}

function record(name: string, run: Followed, attributes: Record<string, string> = {}) {
  const span = tracer.startSpan(
    name,
    {
      startTime: run.start,
      links: run.link ? [run.link] : [],
      attributes: { "run.id": run.runId, ...attributes },
    },
    run.parent,
  );
  span.end(Date.now());
}

// A reply is done once its run ends, or waits for someone, which its span on the server ending
// shows; a run that goes on after a decision is followed again from the decision.
export function runShown(
  threadId: string,
  run: { id: string; waiting: string | null; trace?: string } | null,
) {
  const replying = run && !run.waiting ? run : null;
  const current = followed.get(threadId);
  if (
    current &&
    (current.runId !== replying?.id || (current.trace && current.trace !== replying.trace))
  ) {
    followed.delete(threadId);
    record("reply done", current, {
      "thread.id": threadId,
      "run.ended": run ? "waiting" : "ended",
    });
  }
  if (!replying) return;
  let next = followed.get(threadId);
  if (!next) {
    const action = actions.get(threadId);
    actions.delete(threadId);
    const answers = action && Date.now() - action.start < ACTION_MS;
    next = {
      runId: replying.id,
      start: answers ? action.start : Date.now(),
      parent: answers ? action.context : ROOT_CONTEXT,
      shown: false,
    };
    followed.set(threadId, next);
  }
  if (replying.trace && !next.trace) {
    next.trace = replying.trace;
    next.link = linkOf(replying.trace);
  }
}

// The first piece of a run's reply is recorded once the browser has painted it.
export function pieceShown(threadId: string, part: "text" | "reasoning") {
  const run = followed.get(threadId);
  if (!run || run.shown) return;
  run.shown = true;
  requestAnimationFrame(() => record("first token shown", run, { "thread.id": threadId, part }));
}
