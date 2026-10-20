import { expect, test } from "@playwright/test";

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
