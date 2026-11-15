import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";

import { describe, expect, it } from "vite-plus/test";

import { answersInTime } from "./listen.ts";

// Holds the event loop up, as a long synchronous step does.
function stall(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy.
  }
}

describe("a check of a connection", () => {
  it("counts an answer that arrived while the event loop was held up past the time", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const accepted = once(server, "connection") as Promise<[Socket]>;
    const client = connect((server.address() as { port: number }).port, "127.0.0.1");
    await once(client, "connect");
    const [peer] = await accepted;
    const answer = once(client, "data");
    peer.write("1");
    const checking = answersInTime(answer, 20);
    stall(100);
    expect(await checking).toBe(true);
    client.destroy();
    peer.destroy();
    server.close();
  });

  it("counts no answer in time as none", async () => {
    expect(await answersInTime(new Promise(() => {}), 20)).toBe(false);
  });

  it("counts a failure as none", async () => {
    expect(await answersInTime(Promise.reject(new Error("closed")), 20)).toBe(false);
  });
});
