// Spans as an exporter would get them, from one tracer provider for the whole test process, and the
// database queries a piece of work makes among them, from the spans the Postgres driver's
// instrumentation records as tracing does in the server. Loaded before every test file: the
// instrumentation hooks the driver as it loads, once per process, and only when the tests run on a
// real server, since the database in the test's process is not that driver.

import { context, trace } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { node, tracing } from "@opentelemetry/sdk-node";
import { beforeEach } from "vite-plus/test";

// Kept across the test files of a process, as the provider registered and the driver hooked are.
const shared = globalThis as {
  testTracing?: { exporter: tracing.InMemorySpanExporter; provider: node.NodeTracerProvider };
};

function started() {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  provider.register();
  if (process.env.TEST_DATABASE_URL) {
    registerInstrumentations({
      tracerProvider: provider,
      instrumentations: [new PgInstrumentation({ requireParentSpan: true })],
    });
  }
  return { exporter, provider };
}

const { exporter, provider } = (shared.testTracing ??= started());
beforeEach(() => exporter.reset());

// The spans ended so far in the test under way.
export function finishedSpans() {
  return exporter.getFinishedSpans();
}

export const tracer = provider.getTracer("tests");

const PG = "@opentelemetry/instrumentation-pg";

// Runs the work in a span of its own; answers what it answered, and the queries made under that
// span, begun and ended transactions and notifications among them. With `under`, only those under
// the spans of that name in its trace, as a run's that the work woke.
export async function queries<T>(work: () => Promise<T>, under?: string) {
  const span = tracer.startSpan("work");
  let result: T;
  try {
    result = await context.with(trace.setSpan(context.active(), span), work);
  } finally {
    span.end();
  }
  await provider.forceFlush();
  const { traceId } = span.spanContext();
  const spans = exporter.getFinishedSpans().filter((one) => one.spanContext().traceId === traceId);
  const parents = new Map(spans.map((one) => [one.spanContext().spanId, one]));
  const within = (one: (typeof spans)[number]) => {
    for (let at = one; at; at = parents.get(at.parentSpanContext?.spanId ?? "")!) {
      if (at.name === under) return true;
    }
    return false;
  };
  const texts = spans
    .filter(
      (one) =>
        one.instrumentationScope.name === PG &&
        one.name.startsWith("pg.query") &&
        (!under || within(one)),
    )
    .map((one) => String(one.attributes["db.query.text"] ?? one.attributes["db.statement"] ?? ""));
  return { result, count: texts.length, texts };
}
