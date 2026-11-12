import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 700;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function threadWithMenu(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("Name the engine");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  return page
    .locator("[data-sidebar=sidebar]")
    .getByRole("button", { name: /^More for / })
    .first();
}

test("a row's menu opens on the first press and on the first key, and gives focus back", async ({
  page,
}) => {
  const more = await threadWithMenu(page);
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await more.click();
  const rename = page.getByRole("menuitem", { name: "Rename" });
  await expect(rename).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);
  await expect(more).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(rename).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("a menu button reached by Tab keeps focus, then opens with Space", async ({ page }) => {
  const more = await threadWithMenu(page);
  await page.goto("/");
  await more.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
});

test("one shared tooltip names a control on hover and on keyboard focus, and Escape closes it", async ({
  page,
}) => {
  const more = await threadWithMenu(page);
  await expect(more).toHaveAttribute("aria-label", /^More for /);
  const tip = page.locator("[data-slot=tooltip-content]");
  // A control drawn under a resting pointer is not hovered until the pointer enters it again.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await more.hover();
    await expect(tip).toHaveText("More", { timeout: 1500 });
  }).toPass();
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);

  await page.mouse.move(0, 0);
  await page.goto("/");
  await more.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(more).toBeFocused();
  await expect(tip).toHaveText("More");
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
});
