import { context, propagation, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createRunTraces, tracer } from "@/server/kernel/tracing.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";

// Spans as an exporter would get them, from one provider for the file: the module's tracer keeps
// the first provider it finds.
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
provider.register();
beforeEach(() => exporter.reset());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("run traces", () => {
  it("continue the trace of the post that woke the run", async () => {
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

  it("start the next turn in its own post's trace, linked to the run before", async () => {
    const traces = createRunTraces();
    const { ada, model, worker, post, start } = await agentThread({ traces });
    start();

    const turn = async (text: string) => {
      const posted = await tracer.startActiveSpan("post", async (span) => {
        await post(ada, text);
        span.end();
        return span.spanContext();
      });
      (await model.next()).reply("Hi.");
      await worker.idle();
      return posted;
    };
    await turn("Hello");
    const second = await turn("Again");

    const [first, next] = exporter.getFinishedSpans().filter((span) => span.name === "run");
    expect(next?.spanContext().traceId).toBe(second.traceId);
    expect(next?.parentSpanContext?.spanId).toBe(second.spanId);
    expect(next?.links.map((link) => link.context.spanId)).toEqual([first?.spanContext().spanId]);
  });
});
