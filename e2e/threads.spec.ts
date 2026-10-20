import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client.
let client = 10;
test.beforeEach(async ({ context }) => {
  client += 1;
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": `192.0.2.${client}` });
});

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Full Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Your space");
}

function messages(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Submit" }).click();
}

test("a message posted in a new thread is there after a reload", async ({ page }) => {
  await signUp(page);

  await page.getByLabel("First message").fill("How do engines compute?");
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(messages(page).getByText("How do engines compute?")).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("How do engines compute?");

  await send(page, "And what about looms?");
  await expect(messages(page).getByText("And what about looms?")).toBeVisible();

  await page.reload();
  await expect(messages(page).getByText("How do engines compute?")).toBeVisible();
  await expect(messages(page).getByText("And what about looms?")).toBeVisible();
  await expect(
    page.locator("[data-sidebar=sidebar]").getByText("How do engines compute?"),
  ).toBeVisible();
});

test("a second space can be made, renamed and switched from the sidebar header", async ({
  page,
}) => {
  await signUp(page);
  const sidebar = page.locator("[data-sidebar=sidebar]");
  const switcher = page.getByRole("button", { name: "Switch space" });
  await expect(switcher).toContainText("YS");
  await sidebar.getByRole("button", { name: "New thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(sidebar.getByRole("link", { name: "New thread" })).toBeVisible();

  await switcher.click();
  await page.getByRole("menuitem", { name: "Add space" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Research");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Research");
  await expect(switcher).toContainText("Research");
  await expect(sidebar.getByRole("link", { name: "New thread" })).toHaveCount(0);

  await page.getByRole("button", { name: "Rename" }).click();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Engines");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Engines");
  await expect(switcher).toContainText("Engines");

  await switcher.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Engines" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Your space" }).click();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Your space");
  await expect(switcher).toContainText("Your space");
  await expect(sidebar.getByRole("link", { name: "New thread" })).toBeVisible();
});

test("two tabs on a thread see each other's messages live", async ({ page, context }) => {
  await signUp(page);
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: "New thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByLabel("Message", { exact: true })).toBeVisible();

  await send(page, "Hello from the first tab");
  await expect(messages(other).getByText("Hello from the first tab")).toBeVisible();

  await send(other, "Hello from the second tab");
  await expect(messages(page).getByText("Hello from the second tab")).toBeVisible();
  await expect(messages(page).getByRole("article")).toHaveCount(2);
  await expect(messages(other).getByRole("article")).toHaveCount(2);
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
