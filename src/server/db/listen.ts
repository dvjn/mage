// Hears Postgres notifications on a connection of its own, outside the pool: a listening
// connection must stay open, and a pooled one is handed to others. A lost connection is made again,
// waiting longer after each failure, and whoever listens is told of the gap, since what was
// notified meanwhile is lost.

import pg from "pg";

const FIRST_WAIT_MS = 500;
const LONGEST_WAIT_MS = 5000;
// How long a listening connection has to answer its check, or to connect and start listening,
// before it counts as lost.
const CHECK_MS = 3000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What the work answers, or a failure once it takes longer than CHECK_MS.
async function inTime<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no answer")), CHECK_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// Closes the connection's socket at once, which ends the connection without a word to the server.
function cut(client: pg.Client) {
  (
    client as unknown as { connection: { stream: { destroy(): void } } }
  ).connection.stream.destroy();
}

export function listenAt(url: string) {
  // The connections listening now, for checking they still answer.
  const open = new Set<pg.Client>();

  async function listen(
    channel: string,
    onMessage: (payload: string) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    let stopped = false;
    let client: pg.Client | undefined;

    async function connect() {
      const next = new pg.Client({ connectionString: url, keepAlive: true });
      next.on("notification", (notification) => {
        if (notification.channel === channel && notification.payload !== undefined) {
          onMessage(notification.payload);
        }
      });
      // An error on a connection is followed by its end.
      next.on("error", () => {});
      next.on("end", () => lost(next));
      // A network that stalls while connecting answers nothing, so the attempt is cut in time.
      try {
        await inTime(
          (async () => {
            await next.connect();
            await next.query(`listen "${channel.replaceAll('"', '""')}"`);
          })(),
        );
      } catch (err) {
        cut(next);
        await inTime(next.end()).catch(() => {});
        throw err;
      }
      client = next;
      open.add(next);
    }

    function lost(which: pg.Client) {
      open.delete(which);
      if (stopped || client !== which) return;
      client = undefined;
      void again();
    }

    async function again() {
      for (let wait = FIRST_WAIT_MS; !stopped; wait = Math.min(wait * 2, LONGEST_WAIT_MS)) {
        await pause(wait);
        if (stopped) return;
        try {
          await connect();
          onGap();
          return;
        } catch {
          // Tried again after a longer wait.
        }
      }
    }

    await connect();
    return async () => {
      stopped = true;
      const last = client;
      client = undefined;
      if (last) open.delete(last);
      await last?.end().catch(() => {});
    };
  }

  // Makes sure each listening connection still answers, in time; one that does not is cut, to be
  // made again. A connection whose network stalled answers nothing and closes nothing, so it is
  // cut at the socket rather than asked to end.
  listen.check = async () => {
    await Promise.all(
      [...open].map(async (client) => {
        try {
          await inTime(client.query("select 1"));
        } catch {
          cut(client);
        }
      }),
    );
  };

  return listen;
}
