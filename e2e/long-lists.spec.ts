import { type Browser, expect, type Page, test } from "@playwright/test";

import { addThreads, shareThreads } from "./database.ts";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 180;
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

async function someoneElse(browser: Browser, index: number, name: string) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  const page = await context.newPage();
  return { page, email: await signUp(page, name) };
}

function sidebar(page: Page) {
  return page.locator("[data-sidebar=sidebar]");
}

test("the space switcher finds a space as you type, without jumping to a row", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  for (const name of ["Engines", "Looms", "Notes", "Sums"]) {
    const res = await page.request.post("/api/v1/spaces", { data: { name } });
    expect(res.ok()).toBe(true);
  }
  await page.reload();
  await page.getByRole("button", { name: "Switch space" }).click();
  const filter = page.getByRole("searchbox", { name: "Filter spaces" });
  await expect(filter).toBeFocused();
  // Typing stays in the input: "s" would otherwise jump to "Sums".
  await page.keyboard.type("loo");
  await expect(filter).toHaveValue("loo");
  await expect(filter).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "Looms" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Engines" })).toHaveCount(0);
  // "New space" stays; the org header steps aside so Enter opens the first match.
  await expect(page.getByRole("menuitem", { name: "New space" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Organization settings" })).toHaveCount(0);
  await page.keyboard.type("x");
  await expect(page.getByText("No space matches.")).toBeVisible();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Switch space" })).toContainText("Looms");
});

test("a folder lists its newest few threads, the search lists them all, and the space page pages them", async ({
  page,
}) => {
  const email = await signUp(page, "Ada Lovelace");
  addThreads(email, 31, { prefix: "Loom", folder: "Looms" });
  addThreads(email, 2, { prefix: "Loose" });
  await page.reload();
  const space = page.url();
  await sidebar(page)
    .getByRole("button", { name: /^Looms \d/ })
    .click();
  await expect(sidebar(page).getByRole("link", { name: /^Loom \d+ / })).toHaveCount(4);
  await sidebar(page).getByRole("button", { name: "All 31 in Looms" }).click();
  const dialog = page.getByRole("dialog", { name: "Search threads" });
  await expect(dialog.getByRole("option")).toHaveCount(31);
  await page.keyboard.press("Escape");

  await page.goto(space);
  await page.getByRole("button", { name: "Folder", exact: true }).click();
  await page.getByRole("option", { name: "Looms" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+\?folder=/);
  const threads = page.getByRole("table", { name: "Threads" });
  // A page holds 10; the footer leads to the rest.
  await expect(threads.getByRole("link", { name: /^Loom \d+/ })).toHaveCount(10);
  await expect(page.getByText("1–10 of 31")).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(threads.getByRole("link", { name: /^Loom \d+/ })).toHaveCount(10);
  await expect(page.getByText("Page 2 of 4")).toBeVisible();
  await expect(threads.getByRole("link", { name: /^Loose/ })).toHaveCount(0);
  // Choosing the folder again clears it.
  await page.getByRole("button", { name: "Folder: Looms" }).click();
  await page.getByRole("option", { name: "Looms" }).click();
  await expect(threads.getByRole("link", { name: /^Loose/ })).toHaveCount(2);
});

test("shared threads: the sidebar lists the newest few, and the page filters by title and place", async ({
  page,
  browser,
}, testInfo) => {
  const host = await signUp(page, "Ada Lovelace");
  addThreads(host, 31, { prefix: "Engine" });
  const guest = await someoneElse(browser, testInfo.parallelIndex, "Grace Hopper");
  shareThreads(host, guest.email);
  await guest.page.goto("/shared");
  const shared = sidebar(guest.page).getByRole("link", { name: /^Engine \d+/ });
  await expect(shared).toHaveCount(4);
  await sidebar(guest.page).getByRole("button", { name: "27 more threads" }).click();
  const dialog = guest.page.getByRole("dialog", { name: "Search threads" });
  await expect(dialog.getByRole("option")).toHaveCount(31);
  await guest.page.keyboard.press("Escape");
  await expect(guest.page).toHaveURL(/\/shared$/);
  const list = guest.page.getByRole("table", { name: "Shared threads" });
  await expect(list.getByRole("row")).toHaveCount(10);
  await expect(guest.page.getByText("1–10 of 31")).toBeVisible();
  // More rows a page show them all, and the footer goes once everything fits.
  await guest.page.getByRole("combobox", { name: "Rows per page" }).click();
  await guest.page.getByRole("option", { name: "50" }).click();
  await expect(list.getByRole("row")).toHaveCount(31);
  await expect(guest.page.getByText("Rows per page")).toBeHidden();
  const filter = guest.page.getByRole("searchbox", { name: "Filter threads" });
  await filter.fill("Engine 3");
  await expect(list.getByRole("row")).toHaveCount(3);
  // The place, the host's space, matches too.
  await filter.fill("lovelace");
  await expect(list.getByRole("row")).toHaveCount(31);
  await filter.fill("babbage");
  await expect(guest.page.getByText("No matches")).toBeVisible();
});

test("the share sheet filters its people once there are more than 8 rows", async ({ page }) => {
  const email = await signUp(page, "Ada Lovelace");
  addThreads(email, 1, { prefix: "Engine" });
  await page.reload();
  await sidebar(page).getByRole("link", { name: "Engine 1" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const threadId = page.url().split("/t/")[1];
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this thread" });
  await expect(dialog.getByText("Nobody has written yet.")).toBeVisible();
  await expect(dialog.getByRole("searchbox", { name: "Filter people" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const accessFor of ["1h", "1h", "1h", "1h", "1d", "1d", "1d", "7d", "7d"]) {
    const res = await page.request.post(`/api/v1/threads/${threadId}/invites`, {
      data: { accessFor },
    });
    expect(res.ok()).toBe(true);
  }
  await page.getByRole("button", { name: "Share" }).click();
  const filter = dialog.getByRole("searchbox", { name: "Filter people" });
  await expect(filter).toBeVisible();
  await filter.fill("7 days");
  await expect(dialog.getByRole("listitem", { name: "Unused link" })).toHaveCount(2);
});
