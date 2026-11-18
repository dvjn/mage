import { expect, type Page, test } from "@playwright/test";

import { mcpServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 720;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

// Gives the org the stand-in server whose one tool counts up slowly.
async function addCounter(page: Page) {
  const res = await page.request.post("/api/v1/org/mcp-servers", {
    data: { name: "Counter", url: `${mcpServer}/slow/mcp`, auth: { kind: "none" } },
  });
  expect(res.ok()).toBe(true);
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function replies(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Agent" });
}

// Opens a kind of the activity tray and answers its cards.
async function tray(page: Page, kind: string) {
  await page.getByRole("toolbar", { name: "Context" }).getByRole("button", { name: kind }).click();
  return page.getByTestId("tray-card");
}

// What the agent is told when a job ends, as its card in the transcript.
function told(page: Page) {
  return transcript(page).getByRole("article", { name: "Notice" });
}

test("a running call moved to the background goes on as a job, and the agent is told when it ends", async ({
  page,
}) => {
  await signUp(page);
  await addCounter(page);
  await write(page, `^tool mcp.counter.count ${JSON.stringify({ steps: 80, ms: 100 })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // A call can be moved once it has run for a moment.
  await transcript(page).getByRole("button", { name: "Move to background" }).click();
  // The run goes on at once, told the call was moved.
  await expect(replies(page).last()).toContainText("movedToBackground");
  // The call keeps its one line, which shows its job's status, and the tray lists it.
  const line = transcript(page).getByRole("button", { name: /Count · / });
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAccessibleName(/Count · Running/);
  await expect((await tray(page, "Jobs")).filter({ hasText: "Count" })).toHaveCount(1);
  // The job ends on its own, and the agent is told.
  await expect(told(page)).toContainText("Count", { timeout: 15_000 });
  await expect(line.first()).toHaveAccessibleName(/Count · Done/);
  await expect(told(page)).toContainText("Done");
  await expect(replies(page).last()).toContainText("I have read 2 messages");
});

test("a job is cancelled from the tray, and the agent is not told", async ({ page }) => {
  await signUp(page);
  await addCounter(page);
  // A server's tool is turned on before it is called.
  await write(page, `^tool tools.search ${JSON.stringify({ select: ["mcp.counter.count"] })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page).last()).toContainText("Tool tools.search said: ok");
  await write(
    page,
    `^tool jobs.start ${JSON.stringify({ tool: "mcp.counter.count", input: { steps: 600, ms: 100 } })}`,
  );
  await expect(replies(page).last()).toContainText("Tool jobs.start said: ok");

  const jobs = await tray(page, "Jobs");
  await jobs.filter({ hasText: "Count" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("toolbar", { name: "Context" })).toHaveCount(0);
  // The job shows in place of the Start that made it.
  await expect(
    transcript(page).getByRole("button", { name: /^Counter › Count.* · Cancelled/ }),
  ).toBeVisible();
  await expect(told(page)).toHaveCount(0);
  await expect(replies(page)).toHaveCount(4);
});

test("a job past the thread's limit is queued in the tray, and cancelled from there", async ({
  page,
}) => {
  await signUp(page);
  await addCounter(page);
  await write(page, `^tool tools.search ${JSON.stringify({ select: ["mcp.counter.count"] })}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page).last()).toContainText("Tool tools.search said: ok");
  // Eight counting slowly take every place; the ninth, asked for alone, waits its turn.
  const start = `^tool jobs.start ${JSON.stringify({ tool: "mcp.counter.count", input: { steps: 120, ms: 1000 } })}`;
  await write(page, Array.from({ length: 8 }, () => start).join("\n"));
  const cards = await tray(page, "Jobs");
  await expect(cards).toHaveCount(5);
  await expect(page.getByRole("region", { name: "Background jobs" })).toContainText("of 8");
  await page.keyboard.press("Escape");
  await write(page, start);

  await tray(page, "Jobs");
  await expect(page.getByRole("region", { name: "Background jobs" })).toContainText("of 9");
  // The tray lists five at a time, oldest first: the queued one is on the second page.
  await page
    .getByRole("region", { name: "Background jobs" })
    .getByRole("button", { name: "Next" })
    .click();
  const queued = cards.filter({ hasText: "Queued" });
  await expect(queued).toHaveCount(1);
  await queued.getByRole("button", { name: "Cancel" }).click();
  await expect(cards.filter({ hasText: "Queued" })).toHaveCount(0);
});

test("a job that needs approval is decided from the tray of the thread that started it", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool jobs.start ${JSON.stringify({ tool: "webhooks.add", input: { name: "Deploys", note: "Check the deploy" } })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  // The run does not wait for it.
  await expect(replies(page).last()).toContainText("Tool jobs.start said: ok");

  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Deploys");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  // It runs, and the agent is told it ended.
  await expect(told(page)).toContainText("Add webhook");
  await expect(told(page)).toContainText("Done");
  await expect(replies(page).last()).toContainText("I have read 2 messages");
  await expect(card).toHaveCount(0);
});

test("a call started in the background shows in place of the call that started it, and tells the agent when it is done", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool jobs.start ${JSON.stringify({ tool: "thread.rename", input: { title: "Looms" } })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Looms");
  const job = transcript(page).getByRole("button", { name: /^Thread › Rename.* · Done/ });
  await expect(job).toBeVisible();
  await expect(transcript(page).getByRole("button", { name: /Start/ })).toHaveCount(0);
  await job.click();
  await expect(transcript(page).getByRole("region", { name: "Input" })).toContainText(
    "thread.rename",
  );
  await expect(transcript(page).getByRole("region", { name: "Output" })).toContainText("job");
  // The agent is told, in a card that shows the call as its tool does.
  const notice = told(page);
  await expect(notice).toContainText("Rename");
  await expect(notice).toContainText("Done");
  // Its notice is the end of it: an ended job is not in the tray.
  await expect(page.getByRole("toolbar", { name: "Context" })).toHaveCount(0);
});
