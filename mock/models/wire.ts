// What every provider API of the stand-in model shares: the conversation as its script reads it,
// the pieces of a reply each protocol writes as server-sent events, and the driver that streams
// them at the script's pace, stalls, refuses, fails or drops as the script says.

import type { ModelMessage } from "../../src/server/models/gateway.ts";
import { type ScriptStep, scriptStep } from "../../src/server/models/hosts/fake-script.ts";
import { wireToolName } from "../../src/shared/tools.ts";

export type Message = Exclude<ModelMessage, { role: "change" }>;
type ToolResult = Extract<Message, { role: "tool" }>["results"][number];

// A request as the script reads it: the system prompt, the conversation and the tools offered, by
// their names on the wire.
export interface Conversation {
  model: string;
  instructions: string;
  messages: Message[];
  tools: string[];
}

// One server-sent event: its name, if the protocol names them, and its data.
export interface Frame {
  event?: string;
  data: unknown;
}

// Writes one reply as a protocol's events; it keeps what it has opened, so each call closes what the
// one before left open.
export interface Encoder {
  start(): Frame[];
  reasoning(piece: string): Frame[];
  text(piece: string): Frame[];
  // A failure inside the stream; a protocol with no event for one has its stream fail instead.
  fail?(message: string): Frame[];
  finish(calls: ScriptStep["calls"], usage: ScriptStep["usage"]): Frame[];
}

export interface Protocol {
  read(body: unknown): Conversation;
  encoder(model: string): Encoder;
  // A refusal with that status, as the provider words one.
  refusal(code: number, message: string): unknown;
  // What ends the stream after its last event, if anything.
  done?: string;
}

// A conversation built a message at a time: the results of consecutive tool calls go together, and
// a call's result is known by the tool's name.
export function conversationBuilder() {
  const messages: Message[] = [];
  const names = new Map<string, string>();
  return {
    messages,
    user(text: string) {
      if (text) messages.push({ role: "user", text });
    },
    assistant(text: string, calls: { id: string; name: string; input: unknown }[] = []) {
      for (const call of calls) names.set(call.id, call.name);
      messages.push({
        role: "assistant",
        text,
        toolCalls: calls.map((call) => ({ callId: call.id, toolId: call.name, input: call.input })),
      });
    },
    result(callId: string, output: unknown, error = false, name?: string) {
      const result: ToolResult = {
        callId,
        toolId: name ?? names.get(callId) ?? callId,
        output: error ? { ok: false, error: String(output) } : { ok: true, value: output },
      };
      const last = messages.at(-1);
      if (last?.role === "tool") last.results.push(result);
      else messages.push({ role: "tool", results: [result] });
    },
  };
}

// A tool's output as sent back: JSON when it parses, the text otherwise.
export function outputOf(content: unknown): unknown {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

// The text of a message's content, as a string or a list of parts with text.
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

const encoder = new TextEncoder();

function sse(frame: Frame) {
  const event = frame.event ? `event: ${frame.event}\n` : "";
  const data = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
  return encoder.encode(`${event}data: ${data}\n\n`);
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

export interface ReplyOptions {
  // How long it waits before each piece it streams.
  pieceMs: number;
}

// Answers one request in the protocol, as the script says for its conversation.
export async function reply(
  protocol: Protocol,
  req: Request,
  options: ReplyOptions,
): Promise<Response> {
  const conversation = protocol.read(await req.json().catch(() => null));
  const step = scriptStep({
    instructions: conversation.instructions,
    messages: conversation.messages,
    offered: new Set(conversation.tools),
    search: "tools.search",
    nameOf: wireToolName,
  });
  await wait(step.stall, req.signal);
  if (step.status) {
    const { code, retryAfter, message } = step.status;
    return Response.json(protocol.refusal(code, message), {
      status: code,
      headers: retryAfter === null ? {} : { "retry-after": String(retryAfter) },
    });
  }
  const write = protocol.encoder(conversation.model);
  const signal = req.signal;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frames: Frame[]) => frames.forEach((frame) => controller.enqueue(sse(frame)));
      send(write.start());
      for (const piece of step.reasoning) {
        await wait(options.pieceMs, signal);
        send(write.reasoning(piece));
      }
      for (const piece of step.text) {
        await wait(options.pieceMs, signal);
        send(write.text(piece));
      }
      if (step.drop || (step.fail !== null && !write.fail)) {
        // What was sent is read first; erroring the stream throws away what is still queued.
        while ((controller.desiredSize ?? 0) < 1) await wait(1, signal);
        // As undici reports a connection closed mid-body.
        controller.error(step.drop ? new TypeError("terminated") : new Error(step.fail!));
        return;
      }
      if (step.fail !== null) send(write.fail!(step.fail));
      else send(write.finish(step.calls, step.usage));
      if (protocol.done) controller.enqueue(sse({ data: protocol.done }));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

let counter = 0;
// An id that differs each time, with the provider's prefix.
export function idOf(prefix: string) {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}
