import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 580;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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

test("a webhook is a tool row and a card in the tray, takes a post, and a person pauses and deletes it", async ({
  page,
}) => {
  await signUp(page);
  await write(
    page,
    `^tool triggers.add_webhook ${JSON.stringify({ name: "Deploys", note: "Check the deploy" })}`,
  );
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await page
    .getByRole("region", { name: "Approvals" })
    .getByRole("button", { name: "Allow", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Triggers › Add webhook · Ran · allowed by Ada Lovelace/ }),
  ).toBeVisible();
  await page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Webhooks" })
    .click();
  const card = page.getByTestId("tray-card").filter({ hasText: "Deploys" });
  await expect(card).not.toContainText("No deliveries");
  await card.getByRole("button", { name: "Copy URL" }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("/api/hooks/");

  const [posted] = await Promise.all([
    page.request.post(url, { data: { ref: "main" } }),
    page.request.post(url, { data: { ref: "dev" } }),
  ]);
  expect(posted.status()).toBe(200);
  await expect(card).not.toContainText("Last");
  // Its history is listed only once opened, newest first, with what each post said it was.
  const dialog = page.getByRole("dialog", { name: "Deploys history" });
  const history = dialog.getByTestId("trigger-history");
  await expect(dialog).toHaveCount(0);
  await card.getByRole("button", { name: "History, 2 deliveries" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history).toContainText("application/json");
  await expect(history).toContainText("Unsigned");
  await expect(dialog.getByTestId("pager")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Each post is told to the agent in a card of its own.
  const told = page.getByRole("article", { name: "Notification" });
  await expect(told).toHaveCount(2);
  await expect(told.first()).toContainText("Deploys");
  await expect(told.first()).toContainText("Delivered");

  await card.getByRole("button", { name: "Signature: off" }).click();
  await expect(page.getByText("X-Hub-Signature-256")).toBeVisible();
  await page.getByLabel("Secret").fill("s3cret");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Signature: on" })).toBeVisible();
  expect((await page.request.post(url, { data: {} })).status()).toBe(403);
  await card.getByRole("button", { name: "Signature: on" }).click();
  await expect(page.getByRole("dialog", { name: "Change secret" })).toBeVisible();
  await page.getByRole("button", { name: "Remove signature" }).click();
  await expect(card.getByRole("button", { name: "Signature: off" })).toBeVisible();
  expect((await page.request.post(url, { data: {} })).status()).toBe(200);

  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card).toContainText("Paused");
  await expect(card.getByRole("button", { name: "Resume" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await card.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(card).toHaveCount(0);
  expect((await page.request.post(url, { data: {} })).status()).toBe(404);
});

test("each delivery is its own notification that expands to its payload", async ({ page }) => {
  await signUp(page);
  await write(
    page,
    `^tool triggers.add_webhook ${JSON.stringify({ name: "Deploys", note: "Look" })}`,
  );
  await page
    .getByRole("region", { name: "Approvals" })
    .getByRole("button", { name: "Allow", exact: true })
    .click();
  await page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Webhooks" })
    .click();
  await page.getByTestId("tray-card").getByRole("button", { name: "Copy URL" }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  // The item's row in the chat stays marked while its card is open, and not after.
  await expect(page.locator('[data-lit="true"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-lit="true"]')).toHaveCount(0);
  await Promise.all([
    page.request.post(url, { data: { ref: "main" } }),
    page.request.post(url, { data: { ref: "dev" } }),
  ]);
  const deliveries = page.getByRole("article", { name: "Notification" });
  await expect(deliveries).toHaveCount(2);
  await expect(page.getByText(/"ref": "(main|dev)"/)).toHaveCount(0);
  await deliveries
    .filter({ hasText: "Deploys" })
    .first()
    .getByRole("button", { name: "Show details" })
    .click();
  await expect(page.getByText(/"ref": "(main|dev)"/)).toBeVisible();
  await expect(page.getByText("application/json")).toBeVisible();
  await expect(page.getByText("Unsigned")).toBeVisible();
});

test("a webhook's deliveries are listed a page at a time", async ({ page }) => {
  await signUp(page);
  await write(
    page,
    `^tool triggers.add_webhook ${JSON.stringify({ name: "Deploys", note: "Look" })}`,
  );
  await page
    .getByRole("region", { name: "Approvals" })
    .getByRole("button", { name: "Allow", exact: true })
    .click();
  await page
    .getByRole("toolbar", { name: "Context" })
    .getByRole("button", { name: "Webhooks" })
    .click();
  const card = page.getByTestId("tray-card").filter({ hasText: "Deploys" });
  await card.getByRole("button", { name: "Copy URL" }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  for (let n = 1; n <= 12; n += 1) {
    expect((await page.request.post(url, { data: { n } })).status()).toBe(200);
  }
  await card.getByRole("button", { name: "History, 12 deliveries" }).click();
  const dialog = page.getByRole("dialog", { name: "Deploys history" });
  const history = dialog.getByTestId("trigger-history");
  await expect(history.getByRole("listitem")).toHaveCount(10);
  await expect(dialog.getByTestId("pager")).toContainText("1–10 of 12");
  await expect(dialog.getByRole("button", { name: "Newer" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Older" }).click();
  await expect(dialog.getByTestId("pager")).toContainText("11–12 of 12");
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Older" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Newer" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(10);
});
