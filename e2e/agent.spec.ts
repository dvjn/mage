import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 70;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function signUp(page: Page, name: string) {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  return email;
}

// A second person in their own browser.
async function someoneElse(browser: Browser, index: number, name: string) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  const page = await context.newPage();
  return { page, email: await signUp(page, name) };
}

async function startThread(page: Page, text: string) {
  await page.getByLabel("First message").fill(text);
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function agentWriting(page: Page) {
  return transcript(page).locator('[aria-busy="true"]');
}

function replies(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Agent" });
}

async function write(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
}

test("a message gets a streamed reply from the agent", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "How do engines compute?");

  await expect(agentWriting(page)).toBeVisible();
  await expect(replies(page)).toHaveText(/I have read 1 message, and so the engine/);
  await expect(agentWriting(page)).toBeHidden();
  await page.reload();
  await expect(replies(page)).toHaveText(/I have read 1 message, and so the engine/);
  // The stand-in model's name, the reply's tokens, and the thread's.
  await expect(replies(page)).toContainText("echo");
  await expect(replies(page).getByText(/\d+ tokens$/)).toBeAttached();
  await expect(replies(page).getByRole("button", { name: "Copy message" })).toBeAttached();
  await expect(page.locator("header").getByText(/\d+ tokens$/)).toBeVisible();
});

test("the model's reasoning shows above its reply, folded once it answers", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "Think about engines");

  const reply = replies(page).first();
  await expect(reply).toContainText("I have read 1 message");
  const thought = reply.getByRole("button", { name: /Thought for \d+s/ });
  await expect(thought).toBeVisible();
  await expect(reply.getByText("Considering the gears and the levers")).toBeHidden();
  await thought.click();
  await expect(reply.getByText("Considering the gears and the levers")).toBeVisible();
});

test("a message sent mid-reply steers it with one more reply", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "Tell me slowly");
  await expect(replies(page).first()).toContainText("I have read 1 message");

  await write(page, "Mention looms too");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const tray = page.getByRole("list", { name: "Waiting messages" });
  await expect(tray).toContainText("steers this reply");
  await expect(page.getByRole("list", { name: "Waiting messages" })).toContainText(
    "steers this reply",
  );

  await expect(replies(page)).toHaveCount(2);
  await expect(replies(page).nth(1)).toContainText("I have read 2 messages");
  await expect(transcript(page).getByRole("article").nth(2)).toContainText("Mention looms too");
  await expect(tray).toBeHidden();
});

test("Alt+Enter queues a message for the next reply", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "Tell me slowly");
  await expect(replies(page).first()).toContainText("I have read 1 message");

  await write(page, "Then talk about looms");
  await page.getByLabel("Message", { exact: true }).press("Alt+Enter");
  await expect(page.getByRole("list", { name: "Waiting messages" })).toContainText(
    "queued for the next reply",
  );
  await expect(page.getByRole("list", { name: "Waiting messages" })).toContainText(
    "queued for the next reply",
  );

  await expect(replies(page).nth(1)).toContainText("I have read 2 messages");
});

test("interrupt & send cuts the reply short and answers the new message", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "Tell me slowly");
  await expect(replies(page).first()).toContainText("I have read 1 message");

  await write(page, "Shorter, please");
  await page.getByRole("button", { name: "More ways to send" }).click();
  await page.getByRole("menuitem", { name: "Interrupt & send" }).click();

  await expect(replies(page).first()).toContainText("Interrupted");
  await expect(transcript(page)).toContainText("Ada Lovelace stopped the agent");
  await expect(replies(page).nth(1)).toContainText("I have read 2 messages");
});

test("stop ends the reply where it is, and retry tries it again", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "Tell me slowly");
  await expect(replies(page).first()).toContainText("I have read 1 message");

  await page.getByRole("button", { name: "Stop" }).click();

  await expect(replies(page).first()).toContainText("Interrupted");
  await expect(transcript(page)).toContainText("Ada Lovelace stopped the agent");
  await expect(agentWriting(page)).toBeHidden();
  await expect(replies(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(replies(page).nth(1)).toContainText("I have read 1 message");
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("two people in one thread see each other's messages, steers and stops live", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const grace = await someoneElse(browser, testInfo.parallelIndex, "Grace Hopper");
  joinSpaceOf(adaEmail, grace.email, "messager");
  await startThread(page, "Tell me slowly");
  await grace.page.goto(page.url());

  await expect(transcript(grace.page)).toContainText("Tell me slowly");
  await expect(agentWriting(grace.page)).toBeVisible();
  await write(grace.page, "Mention looms too, slowly");
  await grace.page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.getByRole("list", { name: "Waiting messages" })).toContainText("Grace Hopper");
  await expect(replies(page).nth(1)).toContainText("I have read 2 messages");
  await expect(replies(grace.page).nth(1)).toContainText("I have read 2 messages");
  await grace.page.getByRole("button", { name: "Stop" }).click();

  await expect(transcript(page)).toContainText("Grace Hopper stopped the agent");
  await expect(transcript(grace.page)).toContainText("Grace Hopper stopped the agent");
  await grace.page.context().close();
});

test("a viewer reads the thread but cannot write in it", async ({ page, browser }, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const alan = await someoneElse(browser, testInfo.parallelIndex, "Alan Turing");
  joinSpaceOf(adaEmail, alan.email, "viewer");
  await startThread(page, "How do engines compute?");
  await alan.page.goto(page.url());

  await expect(transcript(alan.page)).toContainText("How do engines compute?");
  await expect(replies(alan.page)).toContainText("I have read 1 message");
  await expect(alan.page.getByLabel("Message", { exact: true })).toBeDisabled();

  await alan.page
    .locator("[data-sidebar=sidebar]")
    .getByRole("link", { name: "Space settings" })
    .click();
  await expect(alan.page.getByRole("textbox", { name: "Name" })).toBeDisabled();
  await expect(alan.page.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await expect(alan.page.getByRole("button", { name: "Delete space" })).toHaveCount(0);
  await alan.page.context().close();
});
