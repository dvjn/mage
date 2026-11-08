import { context, propagation, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createRunTraces, tracer } from "@/server/kernel/tracing.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";

// Spans as an exporter would get them, from a provider set up for the test alone.
function recordSpans() {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  provider.register();
  onTestFinished(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });
  return exporter;
}

describe("run traces", () => {
  it("continue the trace of the post that woke the run", async () => {
    const exporter = recordSpans();
    const traces = createRunTraces();
    const { ada, model, worker, post, start, thread, space } = await agentThread({ traces });
    start();

    const posted = await tracer.startActiveSpan("post", async (span) => {
      await post(ada, "Hello");
      span.end();
      return span.spanContext();
    });
    const call = await model.next();
    call.reply("Hi.");
    await worker.idle();

    const run = exporter.getFinishedSpans().find((span) => span.name === "run");
    expect(run?.spanContext().traceId).toBe(posted.traceId);
    expect(run?.parentSpanContext?.spanId).toBe(posted.spanId);
    expect(run?.links).toEqual([]);
    expect(run?.attributes).toMatchObject({
      "thread.id": thread.id,
      "space.id": space.id,
      "run.outcome": "completed",
    });
  });
});
