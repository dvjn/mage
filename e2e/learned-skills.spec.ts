import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 820;
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

// The stand-in model says back what follows a ^say line: the skill's instructions say so.
const SAVE = `^tool space.save_skill ${JSON.stringify({
  name: "deploy-notes",
  description: "Write the notes for a deploy",
  instructions: "^say\nDeploys go out on Tuesdays.",
})}`;

test("reflect saves a skill once approved, the space lists it as learned, a new thread runs it, and managers change it", async ({
  page,
  browser,
}) => {
  const spaceId = await signUp(page);
  await write(page, `/reflect\n${SAVE}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = page.getByRole("region", { name: "Approvals" }).getByTestId("tray-card");
  await expect(card).toContainText("Save skill");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toHaveCount(0);

  await page.goto(`/s/${spaceId}/settings/skills`);
  await expect(page.getByRole("region", { name: "Written and uploaded" })).toHaveCount(0);
  const group = page.getByRole("region", { name: "Learned" });
  await expect(group).toContainText("1 of 1 on");
  await group.getByRole("button", { name: /^Learned/ }).click();
  const learned = group.getByRole("listitem", { name: "deploy-notes" });
  await expect(learned).toContainText("Approved by Ada Lovelace");
  await expect(learned.getByRole("switch")).toBeChecked();

  // A draft keeps its space's commands a while, in the cache a reload paints from: a fresh browser
  // reads them anew.
  const fresh = await browser.newContext({ storageState: await page.context().storageState() });
  const other = await fresh.newPage();
  await other.goto(`/s/${spaceId}`);
  const box = other.getByLabel("Message", { exact: true });
  await box.fill("/deploy");
  const menu = other.getByRole("listbox", { name: "Commands" });
  await expect(menu.getByRole("option")).toHaveText([/^\/deploy-notes.*Write the notes/]);
  await box.press("Enter");
  await expect(box).toHaveValue("/deploy-notes ");
  await box.press("Enter");
  await expect(other).toHaveURL(/\/t\/[^/]+$/);
  const events = other.getByRole("log", { name: "Events" });
  await expect(events.getByText("Deploys go out on Tuesdays.")).toBeVisible();
  await fresh.close();

  // The group stays open as it was left.
  await page.goto(`/s/${spaceId}/settings/skills`);
  await learned.getByRole("button").click();
  const dialog = page.getByRole("dialog", { name: "deploy-notes" });
  await expect(dialog).toContainText("Approved by Ada Lovelace");
  await dialog.getByLabel("Description").fill("Write the notes for a release");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(learned).toContainText("Write the notes for a release");

  await learned.getByRole("switch").click();
  await expect(group).toContainText("0 of 1 on");

  await learned.getByRole("button").click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(learned).toHaveCount(0);
});
