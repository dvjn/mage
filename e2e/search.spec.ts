import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 50;
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
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Your space");
}

// Starts a thread from the space page and comes back to the space.
async function startThread(page: Page, text: string) {
  const space = page.url();
  await page.getByLabel("First message").fill(text);
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await page.goto(space);
}

function threadList(page: Page) {
  return page.getByRole("list", { name: "Threads" });
}

test("a thread found with the sidebar search opens", async ({ page }) => {
  await signUp(page);
  await startThread(page, "How do engines compute?");
  await startThread(page, "Weaving with looms");
  await expect(threadList(page).getByRole("link")).toHaveCount(2);

  const searchButton = page
    .locator("[data-sidebar=sidebar]")
    .getByRole("button", { name: "Search threads" });
  await searchButton.click();
  const dialog = page.getByRole("dialog", { name: "Search threads" });
  await dialog.getByRole("combobox").fill("ENGINES");
  const result = dialog.getByRole("option", { name: "How do engines compute?" });
  await expect(result).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("group", { name: "Your space" })).toBeVisible();
  await result.click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("How do engines compute?");

  await searchButton.click();
  await expect(dialog).toBeVisible();
});

test("the space page narrows its threads by title", async ({ page }) => {
  await signUp(page);
  await startThread(page, "How do engines compute?");
  await startThread(page, "Weaving with looms");
  await expect(threadList(page).getByRole("link")).toHaveCount(2);

  await page.getByLabel("Filter threads").fill("LOOM");
  await expect(threadList(page).getByRole("link")).toHaveCount(1);
  await expect(threadList(page).getByRole("link")).toContainText("Weaving with looms");

  await page.getByLabel("Filter threads").fill("pistons");
  await expect(threadList(page).getByRole("link")).toHaveCount(0);
  await expect(threadList(page)).toContainText("No thread matches.");
});
