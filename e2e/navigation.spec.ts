import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client.
let client = 500;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

function row(page: Page, title: string) {
  return page
    .locator("[data-sidebar=sidebar] [data-sidebar=menu-item][data-status]")
    .filter({ hasText: title });
}

test("a press on a cached thread's link shows its last message at once, even on a slow server", async ({
  page,
}) => {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);

  await write(page, '/tool thread.rename {"title":"First thread"}');
  for (let i = 0; i < 6; i++) await write(page, `first ${i}`);
  await page
    .getByRole("button", { name: /new thread/i })
    .first()
    .click();
  await write(page, '/tool thread.rename {"title":"Second thread"}');
  await write(page, "second only");

  // Both are read now; the second is the one to come back to.
  await row(page, "First thread").getByRole("link").click();
  await expect(page.getByRole("log", { name: "Events" })).toContainText("first 5");
  await row(page, "Second thread").getByRole("link").click();
  await expect(page.getByRole("log", { name: "Events" })).toContainText("second only");
  await row(page, "First thread").getByRole("link").click();
  await expect(page.getByRole("log", { name: "Events" })).toContainText("first 5");

  await page.route("**/api/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue().catch(() => {});
  });

  const link = row(page, "Second thread").getByRole("link");
  const box = (await link.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 5);
  const shown = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        addEventListener(
          "pointerdown",
          () => {
            const start = performance.now();
            const tick = () => {
              const log = document.querySelector("[role=log]");
              if (log?.textContent?.includes("second only")) resolve(performance.now() - start);
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          { once: true, capture: true },
        );
      }),
  );
  const entries = await page.evaluate(() => history.length);
  // Only the press, no release: the page opens on press start.
  await page.mouse.down();
  expect(await shown).toBeLessThan(100);
  await page.mouse.up();
  // The click ending the press does not follow the link again.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
});
