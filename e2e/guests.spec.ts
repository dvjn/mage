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

// Opens the threads shared with the person from the space switcher.
async function openShared(page: Page) {
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: /^Shared with you/ }).click();
  await expect(page).toHaveURL("/shared");
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

test("a guest joins a thread through a link, writes in it, and loses it when revoked", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  const hostSpace = page.url();
  await openShared(page);
  await expect(page.getByText("Nothing is shared with you yet")).toBeVisible();
  await page.goto(hostSpace);
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await expect(guest.locator("[data-slot=breadcrumb-page]")).toHaveText("How do engines compute?");
  // The host's space is named after them, and is not a link for a guest.
  await expect(
    guest.locator("[data-slot=breadcrumb]").getByRole("link", { name: "Ada Lovelace's Space" }),
  ).toHaveCount(0);
  await expect(guest.locator("[data-slot=breadcrumb]")).toContainText("Ada Lovelace's Space");
  await expect(guest.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(guest.getByLabel("Model", { exact: true })).toHaveCount(0);
  // The sidebar shows where the guest is: the threads shared with them, not a space of their own.
  const switcher = guest.getByRole("button", { name: "Switch space" });
  await expect(switcher).toContainText("Shared with you");
  await expect(switcher).toContainText("1 thread");
  const sidebar = guest.locator("[data-sidebar=sidebar]");
  await expect(sidebar.getByRole("link", { name: "Space settings" })).toHaveCount(0);
  const row = sidebar.getByRole("link", { name: /How do engines compute\?/ });
  await expect(row).toContainText("Ada Lovelace's Space");
  await row.hover();
  await expect(guest.locator("[data-slot=tooltip-content]")).toHaveText("Ada Lovelace's Space");
  await openShared(guest);
  await guest
    .getByRole("table", { name: "Shared threads" })
    .getByRole("link", { name: /How do engines compute\?.*Ada Lovelace's Space/ })
    .click();

  await guest.getByLabel("Message", { exact: true }).fill("Can they hop frequencies?");
  await guest.getByLabel("Message", { exact: true }).press("Enter");
  await expect(replies(guest).nth(1)).toHaveText(/I have read 2 messages/);
  await transcript(page)
    .getByRole("article", { name: "Message from Hedy Lamarr" })
    .getByRole("button", { name: "About Hedy Lamarr" })
    .hover();
  await expect(page.locator("[data-slot=hover-card-content]")).toContainText("Guest");
  // The host's row in the space's list names who wrote, whoever wrote last first, and on hover
  // her as its guest.
  await page.goto(hostSpace);
  const writers = page
    .getByRole("table", { name: "Threads" })
    .getByRole("link", { name: /How do engines compute\?/ })
    .getByText("Hedy, You", { exact: true });
  await writers.hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
    "Hedy Lamarr (guest) and Ada Lovelace",
  );
  await page.goBack();

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
  await expect(hedy).toContainText("Ends");
  await hedy.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove Hedy Lamarr?");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(hedy).toBeHidden();

  // The guest's open thread learns of it on its own.
  await expect(guest.getByText("Your access to this thread has ended")).toBeVisible({
    timeout: 20_000,
  });
  await openShared(guest);
  await expect(guest.getByText("Nothing is shared with you yet")).toBeVisible();
});

test("someone signed in opens a link and goes straight to the thread", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  await page.getByLabel("Message", { exact: true }).fill("// Looms");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await signUp(guest, "Grace Hopper");
  await guest.goto(url);
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await expect(transcript(guest).getByText("// Looms")).toBeVisible();
});

test("a guest opens what the agent published in the thread, until a member turns it off", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  await page.getByLabel("Message", { exact: true }).fill(
    `/tool artifact.publish ${JSON.stringify({
      html: "<title>Sales chart</title><h1>Sales</h1>",
      description: "Sales by month",
      icon: "chart",
    })}`,
  );
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.getByTestId("artifact-card")).toContainText("Sales chart");
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await guest.getByTestId("artifact-card").getByRole("link", { name: "Open" }).click();
  await expect(guest).toHaveURL(/\/artifacts\/[^/]+$/);
  await expect(guest.frameLocator("iframe").getByRole("heading", { name: "Sales" })).toBeVisible();

  await page.getByTestId("artifact-card").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/artifacts\/[^/]+$/);
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this artifact" });
  await expect(dialog.getByText("Thread guests")).toBeVisible();
  await expect(dialog.getByRole("switch")).toBeChecked();
  await dialog.getByRole("switch").click();
  await expect(dialog.getByRole("switch")).not.toBeChecked();

  await guest.goBack();
  await guest.reload();
  const locked = guest.getByTestId("artifact-card");
  await expect(locked).toContainText("Not shared with you");
  await expect(locked.getByRole("link", { name: "Open" })).toHaveCount(0);
});

test("a member gives a thread's guests access from the artifact's card", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  await page.getByLabel("Message", { exact: true }).fill(
    `/tool artifact.publish ${JSON.stringify({
      html: "<title>Sales chart</title><h1>Sales</h1>",
      description: "Sales by month",
      icon: "chart",
    })}`,
  );
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByTestId("artifact-card");
  await expect(card).toContainText("Sales chart");
  // No guests yet, so nothing to give access to.
  await expect(card.getByRole("button", { name: "Give guests access" })).toHaveCount(0);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);

  // Published in the thread, it is shared with the guests already; a member turns that off.
  await page.getByTestId("artifact-card").getByRole("link", { name: "Open" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this artifact" });
  await dialog.getByRole("switch").click();
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await page.goBack();
  await guest.reload();
  await expect(guest.getByTestId("artifact-card")).toContainText("Not shared with you");
  await page.reload();
  await page.getByRole("button", { name: "Give guests access" }).click();
  await expect(page.getByTestId("artifact-card")).toContainText("Guests can open");
  await expect(page.getByRole("button", { name: "Give guests access" })).toHaveCount(0);

  await guest.reload();
  await guest.getByTestId("artifact-card").getByRole("link", { name: "Open" }).click();
  await expect(guest.frameLocator("iframe").getByRole("heading", { name: "Sales" })).toBeVisible();
});
