import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 300;
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

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

test("instructions from the org and the space are in the agent's prompt", async ({ page }) => {
  const spaceId = await signUp(page);
  await page.goto("/org/general");
  const box = page.getByLabel("Instructions", { exact: true });
  await box.fill("x".repeat(20_001));
  await expect(page.getByText(/sent with every message/)).toBeVisible();
  await box.fill("x".repeat(50_001));
  await expect(page.getByText("Too long to save.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await box.fill("Always answer in British spelling.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.goto(`/s/${spaceId}/settings`);
  await page.getByText("The organization's instructions", { exact: true }).click();
  await expect(page.getByText("Always answer in British spelling.")).toBeVisible();
  await page.getByLabel("Instructions", { exact: true }).fill("Cite the ledger entry id.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.goto(`/s/${spaceId}/new`);
  await write(page, "/prompt");
  const reply = transcript(page).getByRole("article", { name: "Message from Agent" });
  await expect(reply).toContainText("Always answer in British spelling.");
  await expect(reply).toContainText("Cite the ledger entry id.");
});
