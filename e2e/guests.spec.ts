import { type Browser, expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 150;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function fillSignUp(page: Page, name: string) {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
}

async function signUp(page: Page, name: string) {
  await page.goto("/signup");
  await fillSignUp(page, name);
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

// Another person in their own browser.
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

// Makes an invite link from the thread's Share dialog and closes it.
async function inviteLink(page: Page) {
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = page.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const url = await link.inputValue();
  await page.keyboard.press("Escape");
  return url;
}

test("a guest joins a thread through a link, writes in it, and loses it when revoked", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  const hostSpace = page.url();
  await page.getByRole("link", { name: "Shared with you" }).click();
  await expect(page.getByText("Nothing is shared with you yet")).toBeVisible();
  await page.goto(hostSpace);
  await page.getByLabel("First message").fill("How do engines compute?");
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await expect(guest.locator("[data-slot=breadcrumb-page]")).toHaveText("How do engines compute?");
  await expect(guest.getByRole("link", { name: "Your space", exact: true })).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(guest.getByLabel("Model", { exact: true })).toHaveCount(0);
  await guest.getByRole("link", { name: "Shared with you" }).click();
  await guest
    .getByRole("list", { name: "Shared threads" })
    .getByRole("link", { name: /^How do engines compute\? Your space/ })
    .click();

  await guest.getByLabel("Message", { exact: true }).fill("Can they hop frequencies?");
  await guest.getByLabel("Message", { exact: true }).press("Enter");
  await expect(replies(guest).nth(1)).toHaveText(/I have read 2 messages/);
  await expect(
    transcript(page).getByRole("article", { name: "Message from Hedy Lamarr" }),
  ).toContainText("guest");

  // The space itself stays out of reach.
  await guest.goto(hostSpace);
  await expect(guest.getByText("This space does not exist or is not yours.")).toBeVisible();
  await guest.goBack();
  await expect(replies(guest)).toHaveCount(2);

  // The link was used up.
  const other = await someoneElse(browser, testInfo.parallelIndex);
  await signUp(other, "Joan Clarke");
  await other.goto(url);
  await expect(other.getByText("This link was already used")).toBeVisible();

  await page.getByRole("button", { name: "Share" }).click();
  const hedy = page.getByRole("listitem", { name: "Hedy Lamarr" });
  await expect(hedy).toContainText("guest");
  await hedy.getByRole("button", { name: "Revoke" }).click();
  await expect(hedy).toBeHidden();

  // The guest's open thread learns of it on its own.
  await expect(guest.getByText("Your access to this thread has ended")).toBeVisible({
    timeout: 20_000,
  });
  await guest.getByRole("link", { name: "Shared with you" }).click();
  await expect(guest.getByText("Nothing is shared with you yet")).toBeVisible();
});

test("someone signed in opens a link and goes straight to the thread", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  await page.getByLabel("First message").fill("// Looms");
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await signUp(guest, "Grace Hopper");
  await guest.goto(url);
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await expect(transcript(guest).getByText("// Looms")).toBeVisible();
});
