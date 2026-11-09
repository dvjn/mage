import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 340;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

// What heads the summary the agent reads first.
const HEADING = "Summary of this thread's earlier messages, in their place";

// The stand-in model says its system prompt a line at a time, then the summary; on a busy machine
// that takes more than the usual 5 seconds.
const PROMPT_SAID = { timeout: 15_000 };

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function replies(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Agent" });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

// Waits for the agent's run to end, so that the next message starts a run of its own rather than
// steering this one.
async function idle(page: Page) {
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

// A thread of two exchanges, the first of which a compaction summarises.
async function twoExchanges(page: Page) {
  await write(page, "Hello");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page).last()).toContainText("I have read 1 message,");
  await idle(page);
  await write(page, "Second");
  await expect(replies(page).last()).toContainText("I have read 2 messages,");
  await idle(page);
}

test("/compact shows where it compacted with its summary, and the agent goes on from it", async ({
  page,
}) => {
  await signUp(page);
  await twoExchanges(page);

  await write(page, "/compact");
  const divider = page.getByRole("group", { name: "Compaction" });
  await divider.getByRole("button", { name: "Compacted by Ada Lovelace" }).click();
  // The stand-in model's summary, asked for after the thread's two messages.
  await expect(divider).toContainText("I have read 3 messages,");

  await idle(page);
  await write(page, "/prompt");
  await expect(replies(page).last()).toContainText(HEADING, PROMPT_SAID);
  await idle(page);
  // Hello is in the summary now; the agent reads Second, /prompt and this.
  await write(page, "Again");
  await expect(replies(page).last()).toContainText("I have read 3 messages,");
});

test("the agent compacts the thread with its tool and goes on from the summary", async ({
  page,
}) => {
  await signUp(page);
  await twoExchanges(page);

  await write(page, "/tool thread.compact {}");
  const divider = page.getByRole("group", { name: "Compaction" });
  await expect(divider.getByRole("button", { name: "Compacted by the agent" })).toBeVisible();
  await expect(replies(page).last()).toContainText("Tool thread.compact said: ok");

  await idle(page);
  await write(page, "/prompt");
  await expect(replies(page).last()).toContainText(HEADING, PROMPT_SAID);
  await idle(page);
  await write(page, "Again");
  await expect(replies(page).last()).toContainText("I have read 4 messages,");
});
