import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 120;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.1.${index}.${client}` };
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

async function someoneElse(browser: Browser, index: number) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  return context.newPage();
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function replies(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Agent" });
}

function questions(page: Page) {
  return transcript(page).getByRole("article", { name: "Questions from Agent" });
}

function line(page: Page, text: string | RegExp) {
  return transcript(page).getByRole("button", { name: text });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

const ASK = `/tool thread.ask ${JSON.stringify({
  questions: [
    {
      question: "Which quarter?",
      header: "Quarter",
      options: [
        { label: "Q3" },
        { label: "Q4", description: "The latest", preview: "**Oct–Dec**" },
      ],
    },
    {
      question: "What should it include?",
      header: "Include",
      multiSelect: true,
      options: [{ label: "Revenue" }, { label: "Pipeline" }],
    },
  ],
})}`;

test("the agent asks, a viewer waits and a messager answers in options and their own words", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  await write(page, ASK);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(questions(page)).toContainText("Thread");
  await expect(questions(page)).toContainText("Ask");
  await expect(questions(page)).toContainText("Which quarter?");
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    "The agent is waiting for an answer above; you can still steer or queue.",
  );

  const grace = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(grace, "Grace Hopper"), "messager");
  const alan = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(alan, "Alan Turing"), "viewer");

  await alan.goto(page.url());
  await expect(questions(alan)).toContainText("Paused");
  await expect(questions(alan).getByRole("button", { name: "Skip" })).toBeDisabled();

  await grace.goto(page.url());
  await expect(grace.getByRole("list", { name: "Needs you" })).toBeVisible();
  const card = questions(grace);
  await expect(card.getByRole("button", { name: "Answer" })).toBeDisabled();
  await card.getByRole("radio", { name: /^Q4/ }).click();
  await expect(card.getByLabel("Preview of Q4")).toHaveText("Oct–Dec");
  await card.getByRole("checkbox", { name: "Revenue" }).click();
  await card.getByLabel("Other answer to Include").fill("Headcount");
  await card.getByRole("button", { name: "Answer" }).click();

  await expect(line(page, /^Thread › Ask · Answered · by Grace Hopper/)).toBeVisible();
  const answers = transcript(page).getByRole("definition");
  await expect(answers).toHaveText(["Q4", "Revenue, Headcount"]);
  await expect(questions(page)).toHaveCount(0);
  await expect(replies(page).last()).toHaveText(/Tool thread.ask said: ok \{"answers"/);
  await expect(replies(page).last()).toContainText(
    '"What should it include?":["Revenue","Headcount"]',
  );
  await expect(questions(alan)).toHaveCount(0);
});

test("anyone who may answer can skip the questions, and the agent goes on", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await write(page, ASK);
  await questions(page).getByRole("button", { name: "Skip" }).click();

  await expect(line(page, /^Thread › Ask · Skipped · by Ada Lovelace/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.ask said: ok \{"skipped":true\}/);
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    "Write a message",
  );
});
