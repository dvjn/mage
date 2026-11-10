// A model the tests drive by hand: each request to it is a call whose events the test sends one at
// a time, so a test can act between any two of them, tool calls among them.

import type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
} from "@/server/models/gateway.ts";
import type { OpenModel } from "@/server/models/service.ts";

const END = Symbol("end");

type Item = ModelEvent | Error | typeof END;

export class Call {
  readonly request: Omit<ModelRequest, "model">;
  readonly signal: AbortSignal;
  private queue: Item[] = [];
  private waiting: ((item: Item) => void) | null = null;

  constructor(request: Omit<ModelRequest, "model">, signal: AbortSignal) {
    this.request = request;
    this.signal = signal;
  }

  private push(item: Item) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  private take(): Promise<Item> {
    const item = this.queue.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  async *events(): AsyncIterable<ModelEvent> {
    for (;;) {
      if (this.signal.aborted) throw new Error("aborted");
      const item = await this.take();
      if (item === END) return;
      if (item instanceof Error) throw item;
      yield item;
    }
  }

  // Resolves once the worker has taken every event sent so far and waits for the next.
  async drained() {
    while (this.queue.length > 0 || !this.waiting) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  // The texts of the messages the call was given; a reply's tool calls, and what they gave back,
  // as `tool <id> <input>` and `result <id> <output>`. Changes are left out.
  get texts() {
    return this.request.messages.flatMap((message: ModelMessage) => {
      if (message.role === "change") return [];
      if (message.role === "tool") {
        return message.results.map(
          (result) => `result ${result.toolId}: ${JSON.stringify(result.output)}`,
        );
      }
      const calls =
        message.role === "assistant"
          ? (message.toolCalls ?? []).map(
              (call) => `tool ${call.toolId}: ${JSON.stringify(call.input)}`,
            )
          : [];
      return [...(message.text ? [`${message.role}: ${message.text}`] : []), ...calls];
    });
  }

  // The ids of the tools the call offered the model, those turned on by searching last.
  get tools() {
    return [...(this.request.tools ?? []).map((tool) => tool.id), ...(this.request.toolsOn ?? [])];
  }

  startStep() {
    this.push({ type: "step-start" });
  }

  delta(text: string) {
    this.push({ type: "delta", text });
  }

  reason(text: string) {
    this.push({ type: "reasoning", text });
  }

  // A call of the tool in the step under way.
  toolCall(callId: string, toolId: string, input: unknown) {
    this.push({ type: "tool-call", callId, toolId, input });
  }

  endStep(usage: ModelUsage = { inputTokens: 3, outputTokens: 2 }) {
    this.push({ type: "step-end", usage });
  }

  end() {
    this.push(END);
  }

  fail(error: string | Error) {
    this.push(typeof error === "string" ? new Error(error) : error);
  }

  // One whole step that answers with the text.
  step(text: string) {
    this.startStep();
    this.delta(text);
    this.endStep();
  }

  // One step and the end of the call.
  reply(text: string) {
    this.step(text);
    this.end();
  }

  // What the step boundary adds to the conversation.
  boundary() {
    return this.request.beforeStep?.() ?? [];
  }
}

export function scriptedModel() {
  const calls: Call[] = [];
  const waiters: ((call: Call) => void)[] = [];
  const model: OpenModel = {
    stream(request, signal) {
      const call = new Call(request, signal);
      calls.push(call);
      waiters.shift()?.(call);
      return call.events();
    },
  };
  let taken = 0;
  return {
    calls,
    open: () => Promise.resolve(model),
    // The next call not yet taken, once it is made.
    next(): Promise<Call> {
      const call = calls[taken];
      taken += 1;
      if (call) return Promise.resolve(call);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
