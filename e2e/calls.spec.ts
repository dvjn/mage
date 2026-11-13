import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 520;
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
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

test("a call started in the background shows as a tool row that ends done, and tells the agent", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool jobs.start ${JSON.stringify({ tool: "thread.rename", input: { title: "Looms" } })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Looms");
  await expect(page.getByRole("button", { name: /Jobs.* · Done/ })).toBeVisible();
  await expect(page.getByText(/Background call .* finished/)).toBeVisible();
  // Its notification is the end of it: an ended job is not in the tray.
  await expect(page.getByRole("toolbar", { name: "Context" })).toHaveCount(0);
});
