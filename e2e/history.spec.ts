import { expect, type Locator, type Page, test } from "@playwright/test";

import { modelServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 420;
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

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function replies(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Agent" });
}

function messages(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Ada Lovelace" });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

async function idle(page: Page) {
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

// Writes the message and waits for the stand-in model's reply, which says how many it read.
async function exchange(page: Page, text: string, read: number) {
  await write(page, text);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page).last()).toContainText(
    `I have read ${read} ${read === 1 ? "message" : "messages"},`,
  );
  await idle(page);
}

// One of the message's actions, shown as the reader points at it.
async function action(row: Locator, name: string) {
  await row.hover();
  await row
    .getByRole("toolbar", { name: "Message actions" })
    .getByRole("button", { name, exact: true })
    .click();
}

// Retry and fork open a small box of options before they act.
async function retry(row: Locator) {
  await action(row, "Retry");
  await row
    .page()
    .getByRole("group", { name: "Retry with" })
    .getByRole("button", { name: "Retry" })
    .click();
}

async function fork(row: Locator, summary = false) {
  await action(row, "Fork into new thread");
  const box = row.page().getByRole("group", { name: "Fork into new thread" });
  if (summary) await box.getByRole("switch", { name: "Summarize conversation" }).click();
  await box.getByRole("button", { name: "Fork" }).click();
}

test("a reply written again keeps the first as a version, read-only when opened", async ({
  page,
}) => {
  await signUp(page);
  await exchange(page, "Hello", 1);
  const url = page.url();

  const human = messages(page).last();
  const humanActions = human.getByRole("toolbar", { name: "Message actions" });
  await expect(humanActions.getByRole("button")).toHaveCount(2);
  await expect(humanActions.getByRole("button", { name: "Copy", exact: true })).toHaveCount(1);
  await expect(humanActions.getByRole("button", { name: "Edit", exact: true })).toHaveCount(1);
  await expect(human.getByText("Ada Lovelace", { exact: true })).toHaveCount(0);
  await expect(human.locator("time")).toHaveCount(0);
  await page.mouse.move(0, 0);
  const controls = humanActions.locator("..").locator("..");
  await expect(controls).toHaveCSS("opacity", "0");
  await human.hover();
  await expect(controls).toHaveCSS("opacity", "1");

  await retry(replies(page).last());
  await idle(page);
  const versions = replies(page).last().getByRole("group", { name: "Versions" });
  await expect(versions).toContainText("2/2");

  await versions.getByRole("button", { name: "Previous version" }).click();
  await expect(page).toHaveURL(/\?branch=/);
  const banner = page.getByRole("region", { name: "Earlier version" });
  await expect(banner).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  await expect(replies(page).last().getByRole("group", { name: "Versions" })).toContainText("1/2");

  await banner.getByRole("button", { name: "Back to current" }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
});

test("an edited message is sent again, and the agent answers it alone", async ({ page }) => {
  await signUp(page);
  await exchange(page, "First", 1);
  await exchange(page, "Second", 2);

  await action(messages(page).last(), "Edit");
  const box = page.getByLabel("Edit message");
  await box.fill("Second, changed");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(box).toHaveCount(0);
  await expect(messages(page).last()).toContainText("Second, changed");
  await expect(replies(page).last()).toContainText("I have read 2 messages,");
  await idle(page);
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).last().getByRole("group", { name: "Versions" })).toContainText("2/2");
});

test("restoring from a message makes a new current branch, the old one a version from the start", async ({
  page,
}) => {
  await signUp(page);
  await exchange(page, "First", 1);
  await exchange(page, "Second", 2);

  const url = page.url();

  // Nothing follows the last message, so there is nothing to restore from it.
  await replies(page).last().hover();
  const lastActions = replies(page).last().getByRole("toolbar", { name: "Message actions" });
  await expect(lastActions.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(lastActions.getByRole("button", { name: "Restore from here" })).toHaveCount(0);

  await action(replies(page).first(), "Restore from here");
  await expect(messages(page)).toHaveCount(1);
  await expect(replies(page)).toHaveCount(1);

  // A line says where it was restored, with the branch restored from reachable from it at once;
  // the reply restored from keeps no versions.
  const line = transcript(page).getByRole("status", { name: "Restored" });
  await expect(line).toContainText("Restored from here by Ada Lovelace");
  const restored = line.getByRole("group", { name: "Versions" });
  await expect(restored).toContainText("2/2");
  await expect(replies(page).first().getByRole("group", { name: "Versions" })).toHaveCount(0);
  await restored.getByRole("button", { name: "Previous version" }).click();
  const banner = page.getByRole("region", { name: "Earlier version" });
  await expect(banner).toBeVisible();
  await expect(messages(page).last()).toContainText("Second");
  await expect(messages(page).last().getByRole("group", { name: "Versions" })).toContainText("1/2");
  await banner.getByRole("button", { name: "Back to current" }).click();
  await expect(page).toHaveURL(url);

  // The agent reads the restored branch alone; the line keeps the versions.
  await exchange(page, "Third", 2);
  await expect(replies(page).first().getByRole("group", { name: "Versions" })).toHaveCount(0);
  await expect(messages(page).last().getByRole("group", { name: "Versions" })).toHaveCount(0);
  const versions = line.getByRole("group", { name: "Versions" });
  await expect(versions).toContainText("2/2");
  await versions.getByRole("button", { name: "Previous version" }).click();
  await expect(banner).toBeVisible();
  await expect(messages(page).last()).toContainText("Second");
  await expect(banner.getByRole("button", { name: "Restore from here" })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Fork into new thread" })).toBeVisible();
});

test("restoring past calls that changed something asks first and lists them", async ({ page }) => {
  await signUp(page);
  await exchange(page, "First", 1);
  await write(page, '/tool thread.rename {"title":"Renamed"}');
  await expect(replies(page).last()).toContainText("Tool thread.rename said: ok");
  await idle(page);

  await action(replies(page).first(), "Restore from here");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("list", { name: "Not undone" })).toContainText("Thread › Rename");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(messages(page)).toHaveCount(1);
});

test("a thread forks from a message into a new one that links back", async ({ page }) => {
  await signUp(page);
  await exchange(page, "Hello", 1);
  await exchange(page, "Second", 2);
  const source = page.url();

  await fork(replies(page).first());
  await expect(page).not.toHaveURL(source);
  await expect(messages(page)).toHaveCount(1);
  const status = transcript(page).getByRole("status").filter({ hasText: "Forked from" });
  await expect(status).toContainText("Forked from Hello by Ada Lovelace");
  await exchange(page, "Onwards", 2);

  await status.getByRole("link", { name: "Hello" }).click();
  await expect(page).toHaveURL(new RegExp(`${new URL(source).pathname}\\?row=`));
});

test("a link to a message only on an earlier version opens that version at it", async ({
  page,
}) => {
  await signUp(page);
  await exchange(page, "Hello", 1);
  const source = new URL(page.url()).pathname;

  await retry(replies(page).last());
  await idle(page);
  await replies(page)
    .last()
    .getByRole("group", { name: "Versions" })
    .getByRole("button", { name: "Previous version" })
    .click();
  await expect(page.getByRole("region", { name: "Earlier version" })).toBeVisible();
  await fork(replies(page).last());
  await expect(page).not.toHaveURL(new RegExp(source));

  // The fork links back to the first reply, which the thread's current branch no longer holds.
  await transcript(page)
    .getByRole("status")
    .filter({ hasText: "Forked from" })
    .getByRole("link", { name: "Hello" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${source}\\?branch=[^&]+&row=`));
  await expect(page.getByRole("region", { name: "Earlier version" })).toBeVisible();
  await expect(replies(page).last().getByRole("group", { name: "Versions" })).toContainText("1/2");
  await expect(replies(page).last()).toBeInViewport();
});

test("a new thread starts from a summary of the conversation", async ({ page }) => {
  await signUp(page);
  await exchange(page, "Hello", 1);
  const source = page.url();

  await fork(replies(page).last(), true);
  await expect(page).not.toHaveURL(source);
  await expect(transcript(page).getByRole("status")).toContainText(
    "Started from a summary of Hello",
  );
  await expect(page.getByRole("group", { name: "Compaction" })).toBeVisible();
  // The agent reads the summary and the message after it.
  await exchange(page, "Go on", 1);
});

test("side questions are answered aside, kept after the message's actions, one at a time, never posted", async ({
  page,
}) => {
  await signUp(page);
  await exchange(page, "Hello", 1);

  await action(replies(page).last(), "Ask aside");
  const box = page.getByRole("textbox", { name: "Ask aside" });
  await box.fill("Why?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const side = page.getByRole("log", { name: "Side question" });
  await expect(side).toContainText("Why?");
  await expect(side).toContainText("I have read 2 messages,");
  // The thread holds nothing of it, and a button at the row's end opens it.
  await expect(messages(page)).toHaveCount(1);
  const reply = replies(page).last();
  await expect(reply.getByRole("button", { name: "Side question" })).toBeVisible();

  // The answer shows as it is written, and can be stopped there.
  const ask = page.getByRole("button", { name: "Ask", exact: true });
  await expect(ask).toBeVisible();
  await box.fill("Answer slowly");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  const stop = page.getByRole("button", { name: "Stop answering" });
  await expect(stop).toBeVisible();
  await expect(side.getByText("I have read 3 messages,")).toBeVisible();
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(side).toContainText("I have read 3 messages,");
  await expect(ask).toBeVisible();

  // Another side question about the same message is its own, with a switcher to the first.
  await write(page, "/btw And then?");
  await expect(side).toContainText("And then?");
  await expect(side).not.toContainText("Why?");
  await expect(messages(page)).toHaveCount(1);
  const switcher = page.getByRole("group", { name: "Side questions" });
  await expect(switcher).toContainText("2/2");
  await switcher.getByRole("button", { name: "Previous side question" }).click();
  await expect(side).toContainText("Why?");
  await expect(switcher).toContainText("1/2");
});

test("a reply is written again with a model picked for that once, the thread's left as it was", async ({
  page,
}) => {
  await signUp(page);
  await page.goto("/org/providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Search providers").fill("compatible");
  await dialog.getByRole("option", { name: /^OpenAI-compatible ·/ }).click();
  await dialog.getByLabel("Base URL").fill(`${modelServer}/v1`);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 models found");
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.goto("/");
  await exchange(page, "Hello", 1);
  await action(replies(page).last(), "Retry");
  const picker = page.getByRole("group", { name: "Retry with" });
  await picker.getByRole("combobox", { name: "Model", exact: true }).click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /lab-tune-7b/ })
    .click();
  await picker.getByRole("button", { name: "Retry" }).click();

  await expect(replies(page).last().getByRole("group", { name: "Versions" })).toContainText("2/2");
  await expect
    .poll(async () => {
      const detail = await (
        await page.request.get(`/api/v1/threads/${new URL(page.url()).pathname.split("/").pop()}`)
      ).json();
      return detail.rows.filter((row: { kind: string }) => row.kind === "agent").at(-1)?.model;
    })
    .toMatch(/\/lab-tune-7b$/);
  const composer = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(composer).not.toContainText("lab-tune-7b");
});
