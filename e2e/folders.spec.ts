import { expect, type Page, test } from "@playwright/test";

import { addThreads } from "./database.ts";

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
  const email = `${crypto.randomUUID()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  return email;
}

function sidebar(page: Page) {
  return page.locator("[data-sidebar=sidebar]");
}

// The folder's chip, named with how many threads it holds.
function chip(page: Page, name: string) {
  return sidebar(page)
    .getByRole("group", { name: "Folders" })
    .getByRole("button", { name: new RegExp(`^${name} \\d`) });
}

async function itemMenu(page: Page, name: string, item: string) {
  await sidebar(page)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  await page.getByRole("menuitem", { name: item }).click();
}

// Picks the folder's chip, then an action from its menu.
async function folderMenu(page: Page, name: string, item: string) {
  await chip(page, name).click();
  await expect(chip(page, name)).toHaveAttribute("aria-pressed", "true");
  await itemMenu(page, name, item);
}

async function nameIt(page: Page, name: string, action: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: action }).click();
  await expect(dialog).toBeHidden();
}

// Starts a draft in the folder; its first message makes the thread and names it.
async function newThreadIn(page: Page, folderName: string, title: string) {
  await folderMenu(page, folderName, "New thread");
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
  await expect(sidebar(page).getByRole("link", { name: /^Pistons/ })).toBeVisible();
  await expect(chip(page, "Engines")).toHaveAccessibleName("Engines 1 thread");

  // The picked folder is remembered.
  await page.reload();
  await expect(chip(page, "Engines")).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar(page).getByRole("link", { name: /^Pistons/ })).toBeVisible();

  await itemMenu(page, "Pistons", "Move to");
  await page
    .getByRole("dialog", { name: "Move Pistons" })
    .getByRole("option", { name: "No folder" })
    .click();
  await expect(sidebar(page).getByRole("link", { name: /^Pistons/ })).toHaveCount(0);
  await expect(sidebar(page).getByText("No threads", { exact: true })).toBeVisible();
  await expect(chip(page, "Engines")).toHaveAccessibleName("Engines 0 threads");
  await chip(page, "All").click();
  await expect(sidebar(page).getByRole("link", { name: /^Pistons/ })).toBeVisible();
});

test("a folder is renamed and deleted from its chip's menu, its threads moving to the top", async ({
  page,
}) => {
  await signUp(page);
  await sidebar(page).getByRole("button", { name: "New folder" }).click();
  await nameIt(page, "Looms", "Create");
  await newThreadIn(page, "Looms", "Punched cards");

  await folderMenu(page, "Looms", "Rename");
  await nameIt(page, "Jacquard", "Save");
  await expect(chip(page, "Jacquard")).toHaveAttribute("aria-pressed", "true");

  await itemMenu(page, "Jacquard", "Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Its threads move to the top of the space.");
  await confirm.getByRole("button", { name: "Delete" }).click();

  await expect(chip(page, "Jacquard")).toHaveCount(0);
  await expect(sidebar(page).getByRole("link", { name: /^Punched cards/ })).toBeVisible();
});

test("chips pick a folder, the list groups and cuts its threads, and the search opens on the scope", async ({
  page,
}) => {
  const email = await signUp(page);
  for (const name of ["Gears", "Cards", "Pistons", "Valves", "Levers"]) {
    addThreads(email, 1, { prefix: name, folder: name });
  }
  addThreads(email, 6, { prefix: "Loose" });
  addThreads(email, 5, { prefix: "Loom", folder: "Looms" });
  await page.reload();

  // All, then the most recently active folders that fit on two rows, then the rest in the search.
  const group = sidebar(page).getByRole("group", { name: "Folders" });
  await expect(group.getByRole("button").nth(0)).toHaveText("All 16 threads");
  await expect(group.getByRole("button").nth(1)).toHaveText("Looms 5 threads");
  const more = group.getByRole("button", { name: /^\d+ more$/ });
  await expect(more).toBeVisible();
  expect((await group.boundingBox())!.height).toBeLessThan(3 * 24);
  await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
  const today = sidebar(page).getByRole("list", { name: "Today" });
  await expect(today.getByRole("link")).toHaveCount(4);
  await expect(today.getByRole("link", { name: /^Loom 5/ })).toContainText("Looms");

  // The last row opens the search on every thread.
  await sidebar(page).getByRole("button", { name: "12 more threads" }).click();
  const dialog = page.getByRole("dialog", { name: "Search threads" });
  await expect(dialog.getByRole("option")).toHaveCount(16);
  await page.keyboard.press("Escape");

  // "<n> more" opens the folders; choosing one scopes the threads to it until Backspace clears it.
  await more.click();
  await expect(dialog.getByRole("button", { name: /^Folders \d/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("option")).toHaveCount(6);
  await dialog.getByRole("combobox").fill("gea");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Search all threads, not only Gears" }),
  ).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("combobox").press("Backspace");
  await expect(dialog.getByRole("option")).toHaveCount(16);
  await page.keyboard.press("Escape");

  // A picked folder lists its newest few and leads to the search on it for all.
  await chip(page, "Looms").click();
  await expect(sidebar(page).getByRole("button", { name: /^Search Looms/ })).toHaveCount(0);
  await expect(today.getByRole("link")).toHaveCount(4);
  await expect(today.getByRole("link", { name: /^Loom 5/ })).not.toContainText("Looms");
  await sidebar(page).getByRole("button", { name: "All 5 in Looms" }).click();
  await expect(dialog.getByRole("combobox")).toHaveAttribute("placeholder", "Search 5 threads");
  await expect(dialog.getByRole("option")).toHaveCount(5);
  await dialog.getByRole("button", { name: "Search all threads, not only Looms" }).click();
  await expect(dialog.getByRole("option")).toHaveCount(16);
});

test("a long folder name is cut short in its chip, on rows and in the search's scope", async ({
  page,
}) => {
  const long = "Customer escalations for enterprise accounts";
  const email = await signUp(page);
  addThreads(email, 1, { prefix: "Looms", folder: "Looms" });
  addThreads(email, 2, { prefix: "Escalation", folder: long });
  await page.reload();

  const group = sidebar(page).getByRole("group", { name: "Folders" });
  const longChip = chip(page, long);
  await expect(longChip).toHaveAccessibleName(`${long} 2 threads`);
  expect((await group.boundingBox())!.height).toBeLessThan(3 * 24);
  expect((await longChip.boundingBox())!.width).toBeLessThan(160);
  // The row's title keeps most of the row.
  const row = sidebar(page).getByRole("link", { name: /^Escalation 2/ });
  const place = row.getByText(long);
  expect((await place.boundingBox())!.width).toBeLessThanOrEqual(80);

  await longChip.click();
  await sidebar(page)
    .getByRole("button", { name: /^Search/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Search threads" });
  await expect(dialog.getByRole("button", { name: /^Search all threads, not only/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("Tab");
  await dialog.getByRole("combobox").fill("customer");
  await page.keyboard.press("Enter");
  const token = dialog.getByRole("button", { name: `Search all threads, not only ${long}` });
  await expect(token).toBeVisible();
  expect((await token.boundingBox())!.width).toBeLessThan(200);
});
