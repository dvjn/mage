import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 30;
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

function sidebar(page: Page) {
  return page.locator("[data-sidebar=sidebar]");
}

// The sidebar item of the folder, holding its threads.
function folder(page: Page, name: string) {
  return sidebar(page)
    .locator("[data-sidebar=menu-item]")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
}

async function itemMenu(page: Page, name: string, item: string) {
  await sidebar(page)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function nameIt(page: Page, name: string, action: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: action }).click();
  await expect(dialog).toBeHidden();
}

// Starts a draft in the folder; its first message makes the thread and names it.
async function newThreadIn(page: Page, folderName: string, title: string) {
  await itemMenu(page, folderName, "New thread");
  await expect(page).toHaveURL(/\/s\/[^/]+\/new\?folder=/);
  await expect(page.getByText(`New thread in ${folderName}`)).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill(title);
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
}

test("a thread started in a folder stays there after a reload and moves to the top", async ({
  page,
}) => {
  await signUp(page);

  await sidebar(page).getByRole("button", { name: "New folder" }).click();
  await nameIt(page, "Engines", "Create");
  await newThreadIn(page, "Engines", "Pistons");
  await expect(folder(page, "Engines").getByRole("link", { name: "Pistons" })).toBeVisible();
  // The header keeps the folder's name and says how many threads it holds.
  const header = sidebar(page).getByRole("button", { name: "Engines", exact: true });
  await expect(header).toHaveAccessibleDescription("1 thread");

  await page.reload();
  await expect(folder(page, "Engines").getByRole("link", { name: "Pistons" })).toBeVisible();

  await itemMenu(page, "Pistons", "Move to");
  await page
    .getByRole("dialog", { name: "Move Pistons" })
    .getByRole("option", { name: "No folder" })
    .click();
  await expect(sidebar(page).getByRole("link", { name: "Pistons" })).toBeVisible();
  await expect(folder(page, "Engines").getByRole("link", { name: "Pistons" })).toHaveCount(0);
  await expect(header).toHaveAccessibleDescription("0 threads");
});

test("deleting a folder moves its threads to the top of the space", async ({ page }) => {
  await signUp(page);
  await sidebar(page).getByRole("button", { name: "New folder" }).click();
  await nameIt(page, "Looms", "Create");
  await newThreadIn(page, "Looms", "Punched cards");

  await itemMenu(page, "Looms", "Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Its threads move to the top of the space.");
  await confirm.getByRole("button", { name: "Delete" }).click();

  await expect(sidebar(page).getByRole("button", { name: "Looms", exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole("link", { name: "Punched cards" })).toBeVisible();
});
