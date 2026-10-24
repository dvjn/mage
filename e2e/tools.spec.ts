import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 210;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function fillSignUp(page: Page, name: string) {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  return email;
}

async function signUp(page: Page, name: string) {
  await page.goto("/signup");
  const email = await fillSignUp(page, name);
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

function card(page: Page) {
  return transcript(page).getByRole("article", { name: "Approval request" });
}

// The line a tool call that is not waiting shows as.
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

async function startThread(page: Page, text: string) {
  await write(page, text);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
}

// Makes a folder in the space whose page or thread is open.
async function makeFolder(page: Page, spaceId: string, name: string) {
  const res = await page.request.post(`/api/v1/spaces/${spaceId}/folders`, { data: { name } });
  expect(res.ok()).toBe(true);
}

function spaceIdOf(page: Page) {
  return new URL(page.url()).pathname.split("/")[2]!;
}

// Makes an invite link from the thread's Share dialog and closes it.
async function inviteLink(page: Page) {
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const link = page.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const url = await link.inputValue();
  await page.keyboard.press("Escape");
  return url;
}

test("the agent renames a thread at once when the owner alone asked", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, '/tool thread.rename {"title":"Engines"}');

  await expect(line(page, /^Renamed to "Engines"/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.rename said: ok/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Engines");
  await expect(card(page)).toHaveCount(0);

  await line(page, /^Renamed to "Engines"/).click();
  await expect(transcript(page)).toContainText('"title": "Engines"');
});

test("a guest's words make a move wait; Allow for now lets the next one run until they write again", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await makeFolder(page, spaceId, "Research");
  await makeFolder(page, spaceId, "Archive");
  await startThread(page, "How do engines compute?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await write(guest, "Can they hop frequencies?");
  await expect(replies(page)).toHaveCount(2);

  await write(page, '/tool thread.move {"folder":"Research"}');
  await expect(card(page)).toContainText("Wants to move this thread");
  await expect(card(page)).toContainText("To folder: Research");
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    "The agent is waiting for a decision above; you can still steer or queue.",
  );
  // The guest may not decide: the card is paused for them.
  await expect(card(guest)).toContainText("Paused");
  await expect(card(guest).getByRole("button", { name: "Allow", exact: true })).toBeDisabled();

  await card(page).getByRole("button", { name: "Allow for now" }).click();
  await expect(line(page, /^Moved to Research · allowed for now by Ada Lovelace/)).toBeVisible();
  await expect(line(guest, /^Moved to Research/)).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb]")).toContainText("Research");
  await expect(replies(page).last()).toHaveText(/Tool thread.move said: ok/);

  await write(page, '/tool thread.move {"folder":"Archive"}');
  await expect(line(page, /^Moved to Archive$/)).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  await write(guest, "Thanks");
  await expect(replies(page).last()).toHaveText(/I have read \d+ messages/);
  await write(page, '/tool thread.move {"folder":"Research"}');
  await expect(card(page)).toContainText("To folder: Research");
  await card(page).getByRole("button", { name: "Deny" }).click();
  await expect(line(page, /^Not moved · denied by Ada Lovelace/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.move said: error This action/);
});

test("a messager who needs approval sees the card paused while the owner decides it", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await page.goto(`/s/${spaceId}/settings`);
  const rename = page.getByRole("listitem", { name: "Rename the thread" });
  await rename.getByRole("combobox", { name: "Messagers: Rename the thread" }).click();
  await page.getByRole("option", { name: "Need approval" }).click();
  await expect(
    rename.getByRole("combobox", { name: "Messagers: Rename the thread" }),
  ).toContainText("Need approval");
  await page.goto(`/s/${spaceId}`);
  await startThread(page, "How do looms work?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);

  const grace = await someoneElse(browser, testInfo.parallelIndex);
  const graceEmail = await signUp(grace, "Grace Hopper");
  joinSpaceOf(adaEmail, graceEmail, "messager");
  await grace.goto(page.url());
  await expect(transcript(grace)).toContainText("How do looms work?");
  await write(grace, '/tool thread.rename {"title":"Looms"}');

  await expect(card(grace)).toContainText('To "Looms"');
  await expect(card(grace)).toContainText("Paused");
  await expect(card(grace).getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect(card(page)).not.toContainText("Paused");
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();

  await expect(line(grace, /^Renamed to "Looms" · allowed by Ada Lovelace/)).toBeVisible();
  await expect(card(grace)).toHaveCount(0);
  await expect(grace.locator("[data-slot=breadcrumb-page]")).toHaveText("Looms");
});

// Grace, a messager in Ada's space, whose renames need approval there.
async function messagerNeedingApproval(page: Page, browser: Browser, index: number) {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  const res = await page.request.patch(`/api/v1/spaces/${spaceId}/tools`, {
    data: { toolId: "thread.rename", messager: "approve" },
  });
  expect(res.ok()).toBe(true);
  const grace = await someoneElse(browser, index);
  const graceEmail = await signUp(grace, "Grace Hopper");
  joinSpaceOf(adaEmail, graceEmail, "messager");
  return grace;
}

test("on a phone the card's buttons stack, Allow first and Deny last", async ({
  page,
  browser,
}, testInfo) => {
  const grace = await messagerNeedingApproval(page, browser, testInfo.parallelIndex);
  await page.setViewportSize({ width: 390, height: 800 });
  await startThread(page, "How do engines compute?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  await grace.goto(page.url());
  await expect(transcript(grace)).toContainText("How do engines compute?");
  await write(grace, '/tool thread.rename {"title":"Pistons"}');
  await expect(card(grace)).toContainText("Paused");

  const allow = card(page).getByRole("button", { name: "Allow", exact: true });
  const forNow = card(page).getByRole("button", { name: "Allow for now" });
  const deny = card(page).getByRole("button", { name: "Deny" });
  const [a, b, c] = await Promise.all([allow, forNow, deny].map((button) => button.boundingBox()));
  expect(a!.x).toBe(c!.x);
  expect(a!.width).toBe(c!.width);
  expect(a!.y).toBeLessThan(b!.y);
  expect(b!.y).toBeLessThan(c!.y);
  await allow.click();
  await expect(line(page, /^Renamed to "Pistons"/)).toBeVisible();
});

test("a tool the space turned off is not offered, and the agent says it cannot use it", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await page.goto(`/s/${spaceId}/settings`);
  await page.getByRole("switch", { name: "Move the thread to a folder" }).click();
  await expect(page.getByRole("switch", { name: "Move the thread to a folder" })).not.toBeChecked();
  await page.goto(`/s/${spaceId}`);

  await startThread(page, '/tool thread.move {"folder":"Research"}');
  await expect(replies(page)).toHaveText(/I cannot use thread.move here\./);
  await expect(card(page)).toHaveCount(0);
});
