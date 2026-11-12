import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 120;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

// Signs up and has a thread answered, waiting until it is kept in the browser.
async function threadKept(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(
    page.getByRole("log", { name: "Events" }).getByText("I have read 1 message"),
  ).toBeVisible();
  // Kept once the session read after the last change has been written.
  await page.waitForTimeout(1500);
}

test("a kept thread shows before the session is read again", async ({ page }) => {
  await threadKept(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/auth/get-session", async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await expect(
    page.getByRole("log", { name: "Events" }).getByText("I have read 1 message"),
  ).toBeVisible();
  release();
});

test("a session the server no longer knows ends at the sign-in page, on a reload", async ({
  page,
  context,
}) => {
  await threadKept(page);
  await context.clearCookies();
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
});

test("a session the server no longer knows ends at the sign-in page, in the app", async ({
  page,
  context,
}) => {
  await threadKept(page);
  await context.clearCookies();
  await page.getByLabel("Message", { exact: true }).fill("Still there?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/login/);
});
