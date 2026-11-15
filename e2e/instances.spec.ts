// Two built servers on one database, as instances behind one address: one is killed as a process
// dies, mid-reply, and the other takes the work over and finishes it once.

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

import { brokenRules } from "./seed.ts";
import { databases, instanceServers, serverEnv } from "./servers.ts";

const [first, second] = instanceServers;

// The servers this file started, each stopped as it ends.
const started = new Set<ChildProcess>();
test.afterAll(() => {
  for (const child of started) child.kill("SIGKILL");
});

// Starts the built server listening at `url`, its output kept beside the journey's results, and
// waits until it answers.
async function startServer(url: string, logPath: string) {
  const child = spawn(process.execPath, ["--enable-source-maps", "dist/server/main.js"], {
    env: {
      ...process.env,
      ...serverEnv,
      DATABASE_URL: databases.mage_instances,
      PORT: new URL(url).port,
      BASE_URL: url,
      LOG_FORMAT: "json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.add(child);
  child.once("exit", () => started.delete(child));
  const log = createWriteStream(logPath);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  await expect
    .poll(async () => (await fetch(`${url}/api/health`).catch(() => null))?.ok ?? false, {
      timeout: 60_000,
    })
    .toBe(true);
  return child;
}

async function killed(child: ChildProcess) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

async function signUp(page: Page, server: string) {
  await page.goto(`${server}/signup`);
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

function replies(page: Page) {
  return page.getByRole("log", { name: "Events" }).getByRole("article", {
    name: "Message from Agent",
  });
}

// The runs of the thread, oldest first.
async function runsOf(db: pg.Client, threadId: string) {
  return (
    await db.query<{
      id: string;
      status: string;
      attempt: number;
      reason: string | null;
      continues_run_id: string | null;
      lease_owner: string | null;
    }>(
      `select id, status, attempt, reason, continues_run_id, lease_owner from run
        where thread_id = $1 order by created_at, id`,
      [threadId],
    )
  ).rows;
}

test("a server killed mid-reply leaves the other to finish the work once", async ({
  page,
}, testInfo) => {
  // The run is taken over once its lease, renewed every ten seconds, has run out.
  test.setTimeout(180_000);
  const db = new pg.Client({ connectionString: databases.mage_instances });
  const a = await startServer(first, testInfo.outputPath("first.log"));
  // Both are up before the message is sent, the second paused so the first takes the run.
  const b = await startServer(second, testInfo.outputPath("second.log"));
  b.kill("SIGSTOP");
  await db.connect();
  try {
    await signUp(page, first);
    await page.getByLabel("Message", { exact: true }).fill("Tell me about engines very slowly");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    await expect(page).toHaveURL(/\/t\/[^/]+$/);
    const threadId = new URL(page.url()).pathname.split("/t/")[1]!;
    // Mid-reply on the first server, before the second can take the run.
    await expect(replies(page)).toContainText("I have read 1 message,");
    const [running] = await runsOf(db, threadId);
    expect(running).toMatchObject({ status: "running", attempt: 1 });

    b.kill("SIGCONT");
    expect(await runsOf(db, threadId)).toEqual([running]);
    await killed(a);

    await expect
      .poll(async () => (await runsOf(db, threadId)).map((run) => run.status), {
        timeout: 120_000,
        intervals: [500],
      })
      .toEqual(["failed", "completed"]);
    const [interrupted, retried] = await runsOf(db, threadId);
    expect(interrupted!.id).toBe(running!.id);
    expect(retried).toMatchObject({
      attempt: 2,
      reason: "retry",
      continues_run_id: running!.id,
    });
    expect(retried!.lease_owner).not.toBe(running!.lease_owner);

    // One message from Ada, taken in once by each run; one reply finished, the first run's cut
    // off.
    const inputs = await db.query<{ status: string }>(
      "select status from thread_input where thread_id = $1",
      [threadId],
    );
    expect(inputs.rows).toHaveLength(1);
    const events = await db.query<{ type: string; status: string | null; run_id: string | null }>(
      `select type, data->>'status' as status, data->>'runId' as run_id from thread_event
        where thread_id = $1 and type in ('message', 'message.completed', 'run.completed')
        order by seq`,
      [threadId],
    );
    expect(events.rows).toEqual([
      { type: "message", status: null, run_id: null },
      { type: "message.completed", status: "failed", run_id: running!.id },
      { type: "message.completed", status: "completed", run_id: retried!.id },
      { type: "run.completed", status: null, run_id: retried!.id },
    ]);

    // Read through the second server, the same session working there.
    await page.goto(`${second}/t/${threadId}`);
    await expect(replies(page).last()).toContainText("I have read 1 message,");
    expect(await brokenRules(second)).toEqual([]);
  } finally {
    await db.end();
  }
});
