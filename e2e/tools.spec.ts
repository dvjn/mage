import { type Browser, expect, type Page, test } from "@playwright/test";

import { joinSpaceOf } from "./database.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 210;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.0.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function fillSignUp(page: Page, name: string) {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  return email;
}

async function signUp(page: Page, name: string) {
  await page.goto("/signup");
  const email = await fillSignUp(page, name);
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

function card(page: Page) {
  return transcript(page).getByRole("article", { name: "Approval request" });
}

// The settings card of the built-in toolsets.
function builtIn(page: Page) {
  return page.locator("[data-slot=card]").filter({
    has: page.locator("[data-slot=card-title]", { hasText: /^Built in$/ }),
  });
}

// The line a tool call that is not waiting shows as.
function line(page: Page, text: string | RegExp) {
  return transcript(page).getByRole("button", { name: text });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

async function startThread(page: Page, text: string) {
  await write(page, text);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
}

// Makes a folder in the space whose page or thread is open.
async function makeFolder(page: Page, spaceId: string, name: string) {
  const res = await page.request.post(`/api/v1/spaces/${spaceId}/folders`, { data: { name } });
  expect(res.ok()).toBe(true);
}

function spaceIdOf(page: Page) {
  return new URL(page.url()).pathname.split("/")[2]!;
}

// Makes an invite link from the thread's Share dialog and closes it.
async function inviteLink(page: Page) {
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const link = page.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const url = await link.inputValue();
  await page.keyboard.press("Escape");
  return url;
}

test("the agent renames a thread at once when the owner alone asked", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, '/tool thread.rename {"title":"Engines"}');

  await expect(line(page, /^Rename thread · Ran$/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.rename said: ok/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Engines");
  await expect(card(page)).toHaveCount(0);

  // The call and the reply are one turn of the agent's, under one header.
  await expect(replies(page)).toHaveCount(2);
  await expect(replies(page).first().getByText("Agent", { exact: true })).toBeVisible();
  await expect(replies(page).last().getByText("Agent", { exact: true })).toHaveCount(0);

  await line(page, /^Rename thread · Ran$/).click();
  const input = transcript(page).getByRole("region", { name: "Input" });
  await expect(input).toHaveText("InputTitleEngines");
  await expect(transcript(page).getByRole("region", { name: "Output" })).toContainText("Engines");
});

// Sets the tool's mode in the open space's settings, from the tool's own row.
async function setInSpace(page: Page, spaceId: string, tool: string, mode: string) {
  await page.goto(`/s/${spaceId}/settings/tools`);
  const row = page.getByRole("listitem", { name: tool });
  await row.getByRole("button", { name: mode }).click();
  await expect(row.getByRole("button", { name: mode })).toHaveAttribute("aria-pressed", "true");
  await page.goto(`/s/${spaceId}`);
}

test("a tool that needs approval asks every time, and a guest may decide it", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await makeFolder(page, spaceId, "Research");
  await makeFolder(page, spaceId, "Archive");
  await setInSpace(page, spaceId, "Move thread", "Needs approval");
  await startThread(page, "How do engines compute?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);

  await write(page, '/tool thread.move {"folder":"Research"}');
  await expect(card(page)).toContainText("The agent wants to use Move thread");
  await expect(card(page)).toContainText("Research");
  await expect(card(page).getByRole("button", { name: "Allow for now" })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    "The agent is waiting for a decision above; you can still steer or queue.",
  );
  await expect(card(guest)).not.toContainText("Paused");
  await card(guest).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(line(page, /^Move thread · Ran · allowed by Hedy Lamarr/)).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb]")).toContainText("Research");
  await expect(replies(page).last()).toHaveText(/Tool thread.move said: ok/);

  await write(page, '/tool thread.move {"folder":"Archive"}');
  await expect(card(page)).toContainText("Archive");
  await card(page).getByRole("button", { name: "Deny" }).click();
  await expect(line(page, /^Move thread · Denied · by Ada Lovelace/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.move said: error This action/);
});

test("a viewer sees the card paused while a messager decides it", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await setInSpace(page, spaceId, "Rename thread", "Needs approval");
  await startThread(page, "How do looms work?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);

  const grace = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(grace, "Grace Hopper"), "messager");
  const alan = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(alan, "Alan Turing"), "viewer");
  await write(page, '/tool thread.rename {"title":"Looms"}');

  await alan.goto(page.url());
  await expect(card(alan)).toContainText("The agent wants to use Rename thread");
  await expect(card(alan)).toContainText("Paused");
  await expect(card(alan).getByRole("button", { name: "Deny" })).toBeDisabled();
  await grace.goto(page.url());
  await expect(card(grace)).not.toContainText("Paused");
  await card(grace).getByRole("button", { name: "Allow", exact: true }).click();

  await expect(line(alan, /^Rename thread · Ran · allowed by Grace Hopper/)).toBeVisible();
  await expect(card(alan)).toHaveCount(0);
  await expect(alan.locator("[data-slot=breadcrumb-page]")).toHaveText("Looms");
});

test("on a phone the card's buttons stack, Allow first and Deny last", async ({
  page,
  browser,
}, testInfo) => {
  await signUp(page, "Ada Lovelace");
  await page.setViewportSize({ width: 390, height: 800 });
  await startThread(page, "How do engines compute?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  const url = await inviteLink(page);
  const threadId = new URL(page.url()).pathname.split("/")[2]!;

  // A guest writes, then loses access: what they wrote now needs approval.
  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);
  await write(guest, "Call it Pistons");
  await expect(replies(page)).toHaveCount(2);
  const me = (await (await guest.request.get("/api/v1/me")).json()) as { user: { id: string } };
  const revoked = await page.request.delete(`/api/v1/threads/${threadId}/guests/${me.user.id}`);
  expect(revoked.ok()).toBe(true);

  await write(page, '/tool thread.rename {"title":"Pistons"}');
  const allow = card(page).getByRole("button", { name: "Allow", exact: true });
  const forNow = card(page).getByRole("button", { name: "Allow for now" });
  const deny = card(page).getByRole("button", { name: "Deny" });
  const [a, b, c] = await Promise.all([allow, forNow, deny].map((button) => button.boundingBox()));
  expect(a!.x).toBe(c!.x);
  expect(a!.width).toBe(c!.width);
  expect(a!.y).toBeLessThan(b!.y);
  expect(b!.y).toBeLessThan(c!.y);
  await allow.click();
  await expect(line(page, /^Rename thread · Ran/)).toBeVisible();
});

test("a tool the space blocked is not offered, and the agent says it cannot use it", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await setInSpace(page, spaceId, "Move thread", "Blocked");

  await startThread(page, '/tool thread.move {"folder":"Research"}');
  await expect(replies(page)).toHaveText(/I cannot use thread.move here\./);
  await expect(card(page)).toHaveCount(0);
});

test("a space can only make a tool stricter than its org, and remembers the toolsets it closed", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await page.goto("/org/tools");
  const orgMove = page.getByRole("listitem", { name: "Move thread" });
  await orgMove.getByRole("button", { name: "Needs approval" }).click();
  await expect(orgMove.getByRole("button", { name: "Needs approval" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.goto(`/s/${spaceId}/settings/tools`);
  const thread = page.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("4 tools");
  const toolset = thread.getByRole("button", { name: /^Thread 4 tools/ });
  await expect(toolset).toContainText("3 allowed, 1 needs approval, 0 blocked");
  const move = page.getByRole("listitem", { name: "Move thread" });
  await expect(move.getByRole("button", { name: "Always allow" })).toBeDisabled();
  await expect(move.getByRole("img", { name: "Set by the organization" })).toBeVisible();
  await expect(
    page
      .getByRole("listitem", { name: "Rename thread" })
      .getByRole("img", { name: "Set by the organization" }),
  ).toHaveCount(0);
  await expect(move.getByRole("button", { name: "Needs approval" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const interactive = page.getByRole("group", { name: "Interactive tools", exact: true });
  // The groups are plain headings: only the toolset opens and closes.
  await expect(thread.getByRole("button", { name: /^(Read-only|Interactive)/i })).toHaveCount(0);
  // Its tools differ, so no icon of the group is pressed.
  for (const name of ["Allow all", "Ask for all", "Block all"]) {
    await expect(interactive.getByRole("button", { name })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  }
  await expect(
    page
      .getByRole("group", { name: "Read-only tools", exact: true })
      .getByRole("button", { name: "Allow all" }),
  ).toHaveAttribute("aria-pressed", "true");
  await interactive.getByRole("button", { name: "Block all" }).click();
  await expect(interactive.getByRole("button", { name: "Block all" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(move.getByRole("button", { name: "Blocked" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(toolset).toContainText("1 allowed, 0 need approval, 3 blocked");

  await toolset.click();
  await expect(move).toBeHidden();
  await page.reload();
  await expect(page.getByRole("region", { name: "Thread" })).toContainText("4 tools");
  await expect(page.getByRole("listitem", { name: "Move thread" })).toBeHidden();
});

test("tools have their own settings page in the org and in a space", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await page.goto("/org/general");
  await expect(page.getByRole("region", { name: "Thread" })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name: "Tools" })
    .click();
  await expect(page).toHaveURL(/\/org\/tools$/);
  // The page's title is the only "Tools" heading; the toolsets are in a card for their source.
  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toHaveCount(1);
  await expect(builtIn(page)).toHaveCount(1);
  await expect(builtIn(page).getByRole("region", { name: "Thread" })).toContainText("4 tools");

  // A person's own space has no members to set.
  await page.goto(`/s/${spaceId}/settings`);
  const nav = page.getByRole("navigation", { name: "Space settings" });
  await expect(nav.getByRole("link")).toHaveText(["General", "Tools"]);
  await expect(page.getByRole("region", { name: "Thread" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Tools" }).click();
  await expect(page).toHaveURL(/\/settings\/tools$/);
  await expect(page.getByRole("region", { name: "Thread" })).toContainText("4 tools");
  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toHaveCount(1);
  await expect(builtIn(page).getByRole("region", { name: "Thread" })).toHaveCount(1);
  await page.goto(`/s/${spaceId}/settings/members`);
  await expect(page).toHaveURL(/\/settings$/);
});
