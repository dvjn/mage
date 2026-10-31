import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 140;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.2.${index}.${client}` };
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

async function someoneElse(browser: Browser, index: number) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  return context.newPage();
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function replies(page: Page) {
  return transcript(page).getByRole("article", { name: "Message from Agent" });
}

function messages(page: Page) {
  return transcript(page).getByRole("article", { name: /^Message from (?!Agent)/ });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

const LAYOUT = `root = Stack([summary, regions, booking, more])
summary = Card("Q3", [figures])
figures = Row([revenue, churn])
revenue = Stat("Revenue", "$1.2M", "+4%")
churn = Stat("Churn", "2.1%")
regions = Table(["Region", "Revenue"], [["EU", "$400k"], ["US", "$800k"]])
booking = Form("Booking", [name, day], [book])
name = Input("Name")
day = Select("Day", ["Monday", "Tuesday"])
book = Button("Book", @ToAssistant("Book a review"))
more = Button("Show March", @ToAssistant("Show March in detail"))`;

const SAY = `/say\nHere are the numbers.\n\n\`\`\`ui\n${LAYOUT}\n\`\`\`\n\nThat is all.`;

test("a layout in a reply draws as it streams, and its buttons post as whoever clicks", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  await write(page, SAY);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  const reply = replies(page).first();
  const layout = reply.locator("[data-slot=reply-ui]");
  // The card shows before the rest of the layout has arrived.
  await expect(layout.getByText("Q3", { exact: true })).toBeVisible();
  await expect(reply.locator("[aria-busy=true]")).toHaveCount(1);
  await expect(reply).toContainText("That is all.");
  await expect(layout).toHaveAttribute("data-drawn", "true");
  await expect(layout.getByText("$1.2M")).toBeVisible();
  await expect(layout.getByRole("table")).toContainText("EU$400k");
  await expect(layout.getByText("root = Stack")).toHaveCount(0);

  const alan = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(alan, "Alan Turing"), "viewer");
  await alan.goto(page.url());
  await expect(replies(alan).first().getByRole("button", { name: "Show March" })).toBeDisabled();

  await reply.getByRole("button", { name: "Show March" }).click();
  await expect(messages(page).last()).toContainText("Show March in detail");
  await expect(replies(page).last()).toContainText("I have read 2 messages");

  const form = reply.getByRole("form", { name: "Booking" });
  await form.getByRole("textbox").fill("Ada");
  await form.getByRole("combobox", { name: "Day" }).click();
  await page.getByRole("option", { name: "Tuesday" }).click();
  await form.getByRole("button", { name: "Book" }).click();
  await expect(messages(page).last()).toContainText("Book a review");
  await expect(messages(page).last()).toContainText("Name: Ada");
  await expect(messages(page).last()).toContainText("Day: Tuesday");
});

test("a layout that cannot be drawn shows its source", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await write(page, "/say\nHere:\n\n```ui\n<div>not a layout</div>\n```");
  const layout = replies(page).first().locator("[data-slot=reply-ui]");
  await expect(layout).toHaveAttribute("data-drawn", "false");
  await expect(layout).toHaveText("<div>not a layout</div>");
});

test("rich replies can be turned off for the org, and the agent is no longer told of them", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const space = page.url();
  await write(page, "/prompt");
  await expect(replies(page).first()).toContainText("Rich replies:");

  await page.goto("/org/tools");
  const row = page.getByRole("region", { name: "Rich replies" });
  await expect(row).toContainText("Cards, tables and buttons in the agent's replies");
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).not.toBeChecked();

  // A new thread, so the reply above has no say in it.
  await page.goto(space);
  await write(page, "/prompt");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(replies(page).first()).toContainText("Reply in Markdown.");
  await expect(replies(page).first().locator("[aria-busy=true]")).toHaveCount(0);
  await expect(replies(page).first()).not.toContainText("Rich replies:");
});
