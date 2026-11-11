import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 10;
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
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Personal Space");
}

function messages(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
}

test("a message posted in a new thread is there after a reload", async ({ page }) => {
  await signUp(page);

  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(messages(page).getByText("How do engines compute?")).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("How do engines compute?");

  await send(page, "And what about looms?");
  await expect(messages(page).getByText("And what about looms?")).toBeVisible();

  await page.reload();
  await expect(messages(page).getByText("How do engines compute?")).toBeVisible();
  await expect(messages(page).getByText("And what about looms?")).toBeVisible();
  await expect(
    page.locator("[data-sidebar=sidebar]").getByRole("link", { name: "How do engines compute?" }),
  ).toBeVisible();
});

test("a message stays in the composer until it is posted, so leaving once it empties loses nothing", async ({
  page,
}) => {
  await signUp(page);
  await send(page, "First");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(messages(page).getByText("First")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/threads/*/messages", async (route) => {
    await held;
    await route.continue();
  });
  const box = page.getByLabel("Message", { exact: true });
  await send(page, "Second");
  await expect(box).toHaveValue("Second");
  release();
  await expect(box).toHaveValue("");
  await page.reload();
  await expect(messages(page).getByText("Second")).toBeVisible();
});

test("a second space can be made, renamed and switched from the sidebar header", async ({
  page,
}) => {
  await signUp(page);
  const sidebar = page.locator("[data-sidebar=sidebar]");
  const switcher = page.getByRole("button", { name: "Switch space" });
  await expect(switcher).toContainText("PS");
  await expect(switcher).toContainText("Personal");
  await page.getByLabel("Message", { exact: true }).fill("Engines");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(sidebar.getByRole("link", { name: "Engines" })).toBeVisible();

  await switcher.click();
  await page.getByRole("menuitem", { name: "New space" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Research");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Research");
  await expect(switcher).toContainText("Research");
  await expect(sidebar.getByRole("link", { name: "Engines" })).toHaveCount(0);

  const settings = sidebar.getByRole("link", { name: "Space settings" });
  await settings.click();
  await expect(page).toHaveURL(/\/s\/[^/]+\/settings$/);
  await expect(settings).toHaveAttribute("data-active");
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Settings");
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Space name" }).fill("Mills");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("[data-slot=breadcrumb-link]")).toHaveText("Mills");
  await expect(switcher).toContainText("Mills");

  await switcher.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Mills" })).toContainText("(active)");
  await menu.getByRole("menuitem", { name: "Personal Space" }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Personal Space");
  await expect(switcher).toContainText("Personal Space");
  await expect(sidebar.getByRole("link", { name: "Engines" })).toBeVisible();
  await settings.click();
  await expect(page.getByRole("button", { name: "Delete space" })).toHaveCount(0);
});

test("an empty space is deleted from its settings, after a confirmation", async ({ page }) => {
  await signUp(page);
  const sidebar = page.locator("[data-sidebar=sidebar]");
  const switcher = page.getByRole("button", { name: "Switch space" });
  await switcher.click();
  await page.getByRole("menuitem", { name: "New space" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Scratch");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(switcher).toContainText("Scratch");

  await sidebar.getByRole("link", { name: "Space settings" }).click();
  await page.getByRole("button", { name: "Delete space" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Delete Scratch?");
  await confirm.getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Personal Space");
  await switcher.click();
  await expect(page.getByRole("menuitem", { name: "Scratch" })).toHaveCount(0);
});

test("deleting the open thread leads back to its space", async ({ page }) => {
  await signUp(page);
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await page.getByLabel("Message", { exact: true }).fill("Short lived");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  await sidebar.getByRole("button", { name: "More for Short lived" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Delete Short lived?");
  await confirm.getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(sidebar.getByRole("link", { name: "Short lived" })).toHaveCount(0);
  await expect(page.getByRole("main").getByText("No threads yet", { exact: true })).toBeVisible();
});

test("two tabs on a thread see each other's messages live", async ({ page, context }) => {
  await signUp(page);
  await page.getByLabel("Message", { exact: true }).fill("Two tabs");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByLabel("Message", { exact: true })).toBeVisible();

  await send(page, "Hello from the first tab");
  await expect(messages(other).getByText("Hello from the first tab")).toBeVisible();

  await send(other, "Hello from the second tab");
  await expect(messages(page).getByText("Hello from the second tab")).toBeVisible();
  const fromAda = { name: "Message from Ada Lovelace" };
  await expect(messages(page).getByRole("article", fromAda)).toHaveCount(3);
  await expect(messages(other).getByRole("article", fromAda)).toHaveCount(3);
});

test("a collapsed sidebar stays collapsed after a reload", async ({ page }) => {
  await signUp(page);
  const sidebar = page.locator("[data-slot=sidebar][data-state]");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
});

test("the header's More menu renames and deletes the open thread", async ({ page }) => {
  await signUp(page);
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await page.getByLabel("Message", { exact: true }).fill("Menu subject");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog");
  await rename.getByRole("textbox").fill("Renamed from header");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(sidebar.getByRole("link", { name: "Renamed from header" })).toBeVisible();

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Delete Renamed from header?");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(sidebar.getByRole("link", { name: "Renamed from header" })).toHaveCount(0);
});
