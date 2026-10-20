import { expect, type Page, test } from "@playwright/test";

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

test.describe("the theme menu", () => {
  // Sign-ups are rate limited per client address; this journey counts as its own client.
  test.use({ colorScheme: "light", extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.9" } });

  test("picks a theme that stays after a reload", async ({ page }) => {
    await signUp(page);
    await expect(page.locator("html")).toHaveClass("light");

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass("dark");

    await page.reload();
    await expect(page.locator("html")).toHaveClass("dark");
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`with a ${colorScheme} browser theme`, () => {
    test.use({ colorScheme });

    test(`the app renders ${colorScheme}`, async ({ page }) => {
      await page.goto("/login");
      await expect(page.locator("html")).toHaveClass(colorScheme);
    });

    test(`the ${colorScheme} theme applies before the app script loads`, async ({ page }) => {
      await page.route("**/*.{js,tsx}", (route) => route.abort());
      await page.goto("/login");
      await expect(page.locator("html")).toHaveClass(colorScheme);
    });
  });
}
