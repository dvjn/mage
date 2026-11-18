import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 760;
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
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

const SAVE = `^tool space.save_memory ${JSON.stringify({
  type: "decision",
  topic: "Deploys",
  text: "Deploys go out on Tuesdays.",
})}`;

test("a save waits for approval, opens the next thread, and is forgotten in settings", async ({
  page,
}) => {
  const spaceId = await signUp(page);
  await write(page, SAVE);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Save memory");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toHaveCount(0);

  await page.goto(`/s/${spaceId}/settings/memory`);
  const deploys = page.getByRole("region", { name: "Deploys" });
  await expect(deploys).toContainText("Decision");
  await expect(deploys).toContainText("Deploys go out on Tuesdays.");
  await expect(deploys).toContainText("Approved by Ada Lovelace");

  await page.goto(`/s/${spaceId}`);
  await write(page, "When do deploys go out?");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const events = page.getByRole("log", { name: "Events" });
  await expect(events.getByText("Space memory").first()).toBeVisible();
  await events.getByRole("button", { name: "Show details" }).first().click();
  await expect(events.getByRole("region", { name: "Deploys" })).toContainText(
    "Deploys go out on Tuesdays.",
  );

  await page.goto(`/s/${spaceId}/settings/memory`);
  await page.getByRole("button", { name: "More for Deploys go out on Tuesdays." }).click();
  await page.getByRole("menuitem", { name: "Forget" }).click();
  await expect(page.getByText("Nothing saved")).toBeVisible();
});
