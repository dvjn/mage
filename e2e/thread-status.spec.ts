import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 120;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index + 20}.${client}` };
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

async function someoneElse(
  browser: Browser,
  index: number,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({
    extraHTTPHeaders: nextClient(index),
    ...(viewport && { viewport }),
  });
  return context.newPage();
}

function spaceIdOf(page: Page) {
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

// Starts a thread from the space's page and goes back to that page.
async function startThread(page: Page, text: string) {
  const space = page.url();
  await write(page, text);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const thread = page.url();
  await page.goto(space);
  return thread;
}

// Opens the thread, once the tab has moved to its org.
async function openThread(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toContainText(title);
}

// The thread's row in the sidebar's threads list.
function sidebarRow(page: Page, title: string) {
  return page
    .getByRole("list", { name: "Today" })
    .locator("[data-sidebar=menu-item]")
    .filter({ hasText: title });
}

function needsYou(page: Page) {
  return page.getByRole("list", { name: "Needs you" });
}

test("opening a thread clears what is new for that person only", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  const threadUrl = await startThread(page, "// Engines");
  const grace = await someoneElse(browser, testInfo.parallelIndex);
  const graceEmail = await signUp(grace, "Grace Hopper");
  joinSpaceOf(adaEmail, graceEmail, "messager");

  await grace.goto(page.url());
  await expect(sidebarRow(grace, "Engines")).toHaveAttribute("data-status", "unread");
  await expect(sidebarRow(page, "Engines")).toHaveAttribute("data-status", "read");

  await openThread(grace, threadUrl, "Engines");
  await write(grace, "// Looks good");
  await expect(sidebarRow(grace, "Engines")).toHaveAttribute("data-status", "read");
  // Ada hears of it while she is elsewhere.
  await expect(sidebarRow(page, "Engines")).toHaveAttribute("data-status", "unread");
  await expect(page.getByRole("img", { name: "New messages" }).first()).toBeVisible();
  // The row says who has written and what was said last.
  await expect(sidebarRow(page, "Engines")).toContainText("Grace: // Looks good");
  await expect(
    sidebarRow(page, "Engines").getByRole("img", { name: "Ada Lovelace and Grace Hopper" }),
  ).toBeVisible();

  await sidebarRow(page, "Engines").getByRole("link").click();
  await expect(sidebarRow(page, "Engines")).toHaveAttribute("data-status", "read");
  await grace.goto(`/s/${spaceId}`);
  await expect(sidebarRow(grace, "Engines")).toHaveAttribute("data-status", "read");
});

test("a failed run needs the person until they open it, and a run elsewhere spins", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const threadUrl = await startThread(page, "// Card reader");
  const grace = await someoneElse(browser, testInfo.parallelIndex);
  const graceEmail = await signUp(grace, "Grace Hopper");
  joinSpaceOf(adaEmail, graceEmail, "messager");
  await openThread(grace, threadUrl, "Card reader");

  await write(grace, "Count the cards very slowly");
  await expect(sidebarRow(page, "Card reader")).toHaveAttribute("data-status", "working");
  await expect(
    sidebarRow(page, "Card reader").getByRole("img", { name: /^Working/ }),
  ).toBeVisible();
  await grace.getByRole("button", { name: "Stop" }).click();
  await expect(sidebarRow(page, "Card reader")).not.toHaveAttribute("data-status", "working");

  await write(grace, "/fail The provider is over its limit.");
  await expect(sidebarRow(page, "Card reader")).toHaveAttribute("data-status", "failed");
  await expect(needsYou(page)).toContainText("Card reader");
  await expect(
    needsYou(page).getByRole("img", { name: /^Failed · .*over its limit/ }),
  ).toBeVisible();
  await expect(page).toHaveTitle("● Mage");

  await needsYou(page)
    .getByRole("link", { name: /Card reader/ })
    .click();
  await expect(page).toHaveURL(threadUrl);
  await expect(needsYou(page)).toHaveCount(0);
  await expect(sidebarRow(page, "Card reader")).toHaveAttribute("data-status", "read");
  await expect(page).toHaveTitle("Mage");
});

test("a viewer sees the agent paused while a messager's call waits for approval", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  const res = await page.request.patch(`/api/v1/spaces/${spaceId}/tools`, {
    data: { toolIds: ["thread.rename"], mode: "ask" },
  });
  expect(res.ok()).toBe(true);
  const threadUrl = await startThread(page, "// Looms");
  const grace = await someoneElse(browser, testInfo.parallelIndex);
  const graceEmail = await signUp(grace, "Grace Hopper");
  joinSpaceOf(adaEmail, graceEmail, "messager");
  const alan = await someoneElse(browser, testInfo.parallelIndex);
  const alanEmail = await signUp(alan, "Alan Turing");
  joinSpaceOf(adaEmail, alanEmail, "viewer");
  await alan.goto(page.url());

  await openThread(grace, threadUrl, "Looms");
  await write(grace, '/tool thread.rename {"title":"Weaving"}');

  await expect(sidebarRow(page, "Looms")).toHaveAttribute("data-status", "waiting");
  await expect(needsYou(page).getByRole("img", { name: /^Waiting for you/ })).toBeVisible();
  await expect(sidebarRow(alan, "Looms")).toHaveAttribute("data-status", "paused");
  await expect(
    sidebarRow(alan, "Looms").getByRole("img", { name: "Paused · waiting for someone to approve" }),
  ).toBeVisible();
  await expect(needsYou(alan)).toHaveCount(0);
});

test("a shared thread shows its status in the same row, also on a phone", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  const threadUrl = await startThread(page, "// Gears");
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const link = page.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const url = await link.inputValue();
  await page.keyboard.press("Escape");

  const hedy = await someoneElse(browser, testInfo.parallelIndex, { width: 390, height: 844 });
  await signUp(hedy, "Hedy Lamarr");
  await hedy.goto(url);
  await expect(hedy.locator("[data-slot=breadcrumb-page]")).toContainText("Gears");
  await hedy.goto("/shared");
  const row = hedy
    .getByRole("table", { name: "Shared threads" })
    .getByRole("link", { name: /Gears/ });
  await expect(row).toHaveAttribute("data-status", "read");

  await write(page, "// Another note");
  await expect(row).toHaveAttribute("data-status", "unread");
  // The status's glyph sits at the end of the title's line, named for those who cannot see it.
  await expect(row.getByRole("img", { name: "New messages" })).toBeVisible();
  await expect(row).toContainText("Ada Lovelace's Space · Ada: // Another note");
});
