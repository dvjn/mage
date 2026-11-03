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
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Personal Space");
}

// Starts a thread from the space page and comes back to the space.
async function startThread(page: Page, text: string) {
  const space = page.url();
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await page.goto(space);
}

function threadList(page: Page) {
  return page.getByRole("table", { name: "Threads" });
}

test("a thread found with the sidebar search opens", async ({ page }) => {
  await signUp(page);
  await startThread(page, "How do engines compute?");
  await startThread(page, "Weaving with looms");
  await expect(threadList(page).getByRole("link")).toHaveCount(2);

  const searchButton = page
    .locator("[data-sidebar=sidebar]")
    .getByRole("button", { name: /^Search/ });
  await searchButton.click();
  const dialog = page.getByRole("dialog", { name: "Search threads" });
  await dialog.getByRole("combobox").fill("ENGINES");
  const result = dialog.getByRole("option", { name: "How do engines compute?" });
  await expect(result).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(1);
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
  await expect(threadList(page)).toBeHidden();
  await expect(page.getByText("No matches")).toBeVisible();
});

test("Ctrl+K lists every thread, searches everywhere or in this space, and finds untitled threads", async ({
  page,
}) => {
  await signUp(page);
  const spaceId = page.url().split("/s/")[1]!;
  await startThread(page, "Untitled ideas about engines");
  // A thread nothing has named yet.
  const res = await page.request.post(`/api/v1/spaces/${spaceId}/threads`, { data: {} });
  expect(res.ok()).toBe(true);
  await page.reload();
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await expect(
    sidebar.getByRole("link", { name: /^Untitled / }).filter({ has: page.locator(".italic") }),
  ).toBeVisible();

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search threads" });
  await expect(dialog).toBeVisible();
  // Before anything is typed, it lists every thread.
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await dialog.getByRole("combobox").fill("untitled");
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await expect(dialog.getByRole("option").filter({ has: page.locator(".italic") })).toHaveCount(1);

  // The scope narrows the search to this space, and back.
  const scope = dialog.getByRole("group", { name: "Where to search" });
  await expect(scope.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await scope.getByRole("button", { name: "Personal Space" }).click();
  await expect(dialog.getByRole("option")).toHaveCount(2);
  // Tab cycles the scopes.
  await dialog.getByRole("combobox").press("Tab");
  await expect(scope.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("option")).toHaveCount(2);
});
