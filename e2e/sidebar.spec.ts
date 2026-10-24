import { expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 160;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function signUp(page: Page, name: string) {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
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

test("Ctrl+O opens a draft that becomes a thread only when its first message is sent", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  // The shortcut acts on the active space, once the sidebar knows it.
  await expect(sidebar(page).getByRole("button", { name: "New thread" })).toBeVisible();
  await page.keyboard.press("Control+o");
  await expect(page).toHaveURL(/\/s\/[^/]+\/new$/);
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  // Leaving the draft leaves nothing behind.
  await page.goBack();
  await expect(page.getByRole("list", { name: "Threads" })).toContainText("No threads yet.");

  await expect(sidebar(page).getByRole("button", { name: "New thread" })).toBeVisible();
  await page.keyboard.press("Control+o");
  // The space page has a composer too; write in the draft's once it shows.
  await expect(page.getByRole("heading", { name: "New thread" })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  // Ctrl+Shift+O asks for a new folder's name.
  await page.keyboard.press("Control+Shift+O");
  const folderDialog = page.getByRole("dialog", { name: "New folder" });
  await folderDialog.getByRole("textbox", { name: "Name" }).fill("Engines");
  await folderDialog.getByRole("button", { name: "Create" }).click();
  await expect(sidebar(page).getByRole("button", { name: "Engines", exact: true })).toBeVisible();
  const today = sidebar(page).getByRole("list", { name: "Today" });
  await expect(today.getByRole("link", { name: "How do engines compute?" })).toBeVisible();
});

test("a draft's folder is picked in its breadcrumb, and a thread moves from it", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  // Without a folder the breadcrumb offers to add one, and makes it on the way.
  await sidebar(page).getByRole("button", { name: "New thread" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+\/new$/);
  await page.getByRole("button", { name: "Add to folder" }).click();
  await page.getByPlaceholder("Find a folder").fill("Engines");
  await page.getByRole("option", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Engines");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/new\?folder=/);
  await expect(page.getByRole("button", { name: "Folder: Engines" })).toBeVisible();

  await page.getByLabel("Message", { exact: true }).fill("Pistons");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const folder = sidebar(page)
    .locator("[data-sidebar=menu-item]")
    .filter({ has: page.getByRole("button", { name: "Engines", exact: true }) });
  await expect(folder.getByRole("link", { name: "Pistons" })).toBeVisible();

  // The thread keeps the same breadcrumb, and moves out of the folder from it.
  await page.getByRole("button", { name: "Folder: Engines" }).click();
  await page.getByRole("option", { name: "No folder" }).click();
  await expect(page.getByRole("button", { name: "Add to folder" })).toBeVisible();
  await expect(folder.getByRole("link", { name: "Pistons" })).toHaveCount(0);
  await expect(sidebar(page).getByRole("link", { name: "Pistons" })).toBeVisible();
});

test("a viewer sees no write actions, and a failed delete says why in its dialog", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const threadUrl = page.url();

  const context = await browser.newContext({
    extraHTTPHeaders: nextClient(testInfo.parallelIndex),
  });
  const alan = await context.newPage();
  const alanEmail = await signUp(alan, "Alan Turing");
  joinSpaceOf(adaEmail, alanEmail, "viewer");
  await alan.goto(threadUrl);
  await expect(sidebar(alan).getByRole("link", { name: "How do engines compute?" })).toBeVisible();
  const switcher = alan.getByRole("button", { name: "Switch space" });
  // Someone else's personal org is named after its owner.
  await expect(switcher).toContainText("Ada Lovelace's Personal");
  await switcher.click();
  await expect(alan.getByRole("group", { name: "Joined spaces" })).toContainText("Viewer");
  await alan.keyboard.press("Escape");
  await expect(sidebar(alan).getByRole("button", { name: "New thread" })).toHaveCount(0);
  await expect(sidebar(alan).getByRole("button", { name: "New folder" })).toHaveCount(0);
  await expect(
    sidebar(alan).getByRole("button", { name: "Actions for How do engines compute?" }),
  ).toHaveCount(0);
  await expect(sidebar(alan).getByRole("link", { name: "Space settings" })).toBeVisible();
  // The shortcuts do nothing for a viewer.
  await alan.keyboard.press("Control+o");
  await alan.keyboard.press("Control+Shift+O");
  await expect(alan).toHaveURL(threadUrl);
  await expect(alan.getByRole("dialog")).toHaveCount(0);
  await context.close();

  // The thread's owner sees Delete; a failure would stay in the dialog with a toast.
  await sidebar(page).getByRole("button", { name: "Actions for How do engines compute?" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.route("**/api/v1/threads/*", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 403, json: { error: "Only the space's owner can do this" } })
      : route.continue(),
  );
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Only the space's owner can do this");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the sidebar closes when a page opens from it", async ({ page }) => {
    await signUp(page, "Ada Lovelace");
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
    const sheet = page.locator("[data-mobile=true][data-sidebar=sidebar]");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("link", { name: "Space settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(sheet).toBeHidden();
  });
});

test("? lists the shortcuts, which do not fire while typing unless they use Ctrl", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  await page.keyboard.press("Shift+?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await expect(help.getByRole("region", { name: "General" })).toContainText("Search threads");
  await expect(help).toContainText("Ctrl");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();

  // Typing ? in a field types it.
  await page.getByLabel("Message", { exact: true }).fill("Why");
  await page.getByLabel("Message", { exact: true }).press("Shift+?");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Why?");
  await expect(help).toBeHidden();
  // A Ctrl shortcut works from the field too.
  await page.getByLabel("Message", { exact: true }).press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search threads" })).toBeVisible();
});

test("shortcut hints stay hidden until a row is hovered or Ctrl is held", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  const search = sidebar(page).getByRole("button", { name: /^Search/ });
  const hint = search.locator("[data-slot=kbd]");
  await expect(hint).toHaveText("Ctrl+K");
  await expect(hint).toHaveCSS("opacity", "0");
  await search.hover();
  await expect(hint).toHaveCSS("opacity", "1");
  await page.mouse.move(800, 400);
  await expect(hint).toHaveCSS("opacity", "0");

  await page.keyboard.down("Control");
  await expect(hint).toHaveCSS("opacity", "1");
  await page.keyboard.up("Control");
  await expect(hint).toHaveCSS("opacity", "0");
});

test("a provider's models are turned off in its dialog, and leave the pickers", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  await page.goto("/org/providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  const add = page.getByRole("dialog");
  await add.getByRole("button", { name: /^Anthropic/ }).click();
  await add.getByLabel("API key").fill("sk-ant-demo-1234");
  await add.getByRole("button", { name: "Add key" }).click();
  await add.getByRole("button", { name: "Done" }).click();

  const count = page.getByRole("button", { name: "Models of Anthropic API key" });
  await expect(count).toHaveText("2 of 2 on");
  await count.click();
  const dialog = page.getByRole("dialog", { name: "Anthropic API key models" });
  await expect(dialog.getByRole("switch", { name: "Echo Mini available" })).toBeChecked();
  await dialog.getByRole("switch", { name: "Echo Mini available" }).click();
  await expect(dialog.getByRole("switch", { name: "Echo Mini available" })).not.toBeChecked();
  const auto = dialog.getByRole("switch", { name: /Turn on new models automatically/ });
  await expect(auto).toBeChecked();
  await auto.click();
  await expect(auto).not.toBeChecked();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(count).toHaveText("1 of 2 on");

  await page.goto("/");
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option", { name: "Echo", exact: true })).toBeVisible();
  await expect(list.getByRole("option", { name: "Echo Mini" })).toHaveCount(0);
});

test("a thread on a model turned off replies with the default until it is back on", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const api = (method: string, path: string, data?: object) =>
    page.request.fetch(`/api/v1${path}`, { method, data });
  const key = (await (
    await api("POST", "/connections/api-keys", { provider: "anthropic", key: "sk-ant-demo-1234" })
  ).json()) as { id: string };
  await api("PUT", "/settings/default-model", { ref: `${key.id}/echo` });
  await page.getByLabel("Message", { exact: true }).fill("How do engines compute?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const threadId = page.url().split("/t/")[1]!;
  // Its own effort goes with its own model; the default takes the org's effort with it.
  await api("PUT", "/settings/default-effort", { effort: "low" });
  await api("PATCH", `/threads/${threadId}`, { model: `${key.id}/echo-mini`, effort: "high" });
  // The space starts threads on the same model, so its default gives way to the org's too.
  const [space] = (await (await api("GET", "/spaces")).json()) as { id: string }[];
  await api("PATCH", `/spaces/${space!.id}/defaults`, { model: `${key.id}/echo-mini` });
  const turn = (enabled: boolean) =>
    api("PATCH", `/connections/${key.id}/models`, { set: { ids: ["echo-mini"], enabled } });
  await turn(false);
  await page.reload();

  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toContainText("Default · Echo");
  await expect(model).toHaveClass(/text-amber/);
  await expect(page.getByRole("combobox", { name: "Reasoning effort" })).toContainText(
    "Default · Low",
  );
  await model.hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toContainText(
    "Echo Mini is turned off, so this thread uses the default",
  );
  await model.click();
  await expect(page.getByText("Turned off", { exact: true })).toBeVisible();
  // The default row names the model it resolves to, never a ref.
  const defaultRow = page.getByRole("button", { name: /Default · Echo$/ });
  await expect(defaultRow).toBeVisible();
  // It names what replies, with no warning about the space's own default.
  await expect(defaultRow.locator("svg")).toHaveCount(0);
  await expect(page.getByText(/\/echo/)).toHaveCount(0);
  await page.keyboard.press("Escape");

  const replies = page
    .getByRole("log", { name: "Events" })
    .getByRole("article", { name: "Message from Agent" });
  await page.getByLabel("Message", { exact: true }).fill("And looms?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(replies).toHaveCount(2);

  await turn(true);
  await page.reload();
  await expect(model).toHaveText(/^Echo Mini/);
  await expect(model).not.toHaveClass(/text-amber/);
});
