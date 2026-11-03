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
  const context = await browser.newContext({
    extraHTTPHeaders: nextClient(index),
  });
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
    has: page.locator("[data-slot=card-title]", { hasText: /^System tools$/ }),
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
  const res = await page.request.post(`/api/v1/spaces/${spaceId}/folders`, {
    data: { name },
  });
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

  await expect(line(page, /^Thread › Rename · Ran$/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.rename said: ok/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Engines");
  await expect(card(page)).toHaveCount(0);

  // The call and the reply are one turn of the agent's, under one header.
  await expect(replies(page)).toHaveCount(2);
  await expect(replies(page).first().getByText("Agent", { exact: true })).toBeVisible();
  await expect(replies(page).last().getByText("Agent", { exact: true })).toHaveCount(0);

  await line(page, /^Thread › Rename · Ran$/).click();
  const input = transcript(page).getByRole("region", { name: "Input" });
  await expect(input).toHaveText("InputTitleEngines");
  await input.getByRole("button", { name: "Raw input" }).click();
  await expect(input.locator("pre")).toContainText('"title": "Engines"');
  await expect(transcript(page).getByRole("region", { name: "Output" })).toContainText("Engines");
});

test("a turn's calls fold into one line that opens on them", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(
    page,
    [
      "Think it over",
      '/tool thread.rename {"title":"Gears"}',
      '/tool thread.rename {"title":"Levers"}',
      '/tool thread.rename {"title":"Engines"}',
    ].join("\n"),
  );

  const group = line(page, /^3 tool calls · Thread$/);
  await expect(group).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.rename said: ok/);
  await expect(line(page, /^Thread › Rename · Ran$/)).toHaveCount(0);

  await group.click();
  await expect(line(page, /^Thread › Rename · Ran$/)).toHaveCount(3);
  await line(page, /^Thread › Rename · Ran$/)
    .last()
    .click();
  await expect(transcript(page).getByRole("region", { name: "Input" })).toHaveText(
    "InputTitleEngines",
  );
});

// Makes an org policy every call of which waits for anyone who can edit the thread, or with the
// fields given, and gives its id.
async function makePolicy(page: Page, fields: Record<string, unknown> = {}) {
  const res = await page.request.post("/api/v1/org/tool-policies", {
    data: {
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: ["editors"],
      independent: false,
      ...fields,
    },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

// Opens tools settings at the url with the Thread toolset expanded.
async function openTools(page: Page, url: string) {
  await page.goto(url);
  const toggle = page
    .getByRole("region", { name: "Thread" })
    .getByRole("button", { name: /^Thread \d+ tools?/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

// The picker of a tool's row, or of a group of tools, in tools settings.
function picker(scope: Page | ReturnType<Page["getByRole"]>, name: string) {
  return scope.getByRole("button", {
    name: new RegExp(`^${name} (policy|policy in this space)$`),
  });
}

// Picks a policy, Off, or nothing in the open picker.
async function choose(page: Page, choice: string) {
  await page.getByRole("menuitemradio", { name: new RegExp(`^${choice}`) }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

// Sets the tool in the open space's settings, from the tool's own row.
async function setInSpace(page: Page, spaceId: string, tool: string, choice: string) {
  await openTools(page, `/s/${spaceId}/settings/tools`);
  const row = page.getByRole("listitem", { name: tool });
  await picker(row, tool).click();
  await choose(page, choice);
  await expect(picker(row, tool)).toContainText(choice);
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
  await makePolicy(page);
  await setInSpace(page, spaceId, "Move", "Sign-off");
  await startThread(page, "How do engines compute?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);
  const url = await inviteLink(page);

  const guest = await someoneElse(browser, testInfo.parallelIndex);
  await guest.goto(url);
  await guest.getByRole("button", { name: "Create account" }).click();
  await fillSignUp(guest, "Hedy Lamarr");
  await expect(guest).toHaveURL(/\/t\/[^/]+$/);

  await write(page, '/tool thread.move {"folder":"Research"}');
  await expect(card(page)).toContainText("Move");
  await expect(card(page)).not.toContainText("The agent wants to use");
  await expect(card(page)).toContainText("Asks each time");
  await expect(card(page)).toContainText("Research");
  await expect(card(page).getByRole("button", { name: "Allow for now" })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    "The agent is waiting for a decision above; you can still steer or queue.",
  );
  await expect(card(guest)).not.toContainText("Paused");
  await card(guest).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(line(page, /^Thread › Move · Ran · allowed by Hedy Lamarr/)).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb]")).toContainText("Research");
  await expect(replies(page).last()).toHaveText(/Tool thread.move said: ok/);

  await write(page, '/tool thread.move {"folder":"Archive"}');
  await expect(card(page)).toContainText("Archive");
  await card(page).getByRole("button", { name: "Deny" }).click();
  await expect(line(page, /^Thread › Move · Denied · by Ada Lovelace/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.move said: error This action/);
});

test("a viewer sees the card paused while a messager decides it", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await makePolicy(page);
  await setInSpace(page, spaceId, "Rename", "Sign-off");
  await startThread(page, "How do looms work?");
  await expect(replies(page)).toHaveText(/I have read 1 message/);

  const grace = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(grace, "Grace Hopper"), "messager");
  const alan = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(alan, "Alan Turing"), "viewer");
  await write(page, '/tool thread.rename {"title":"Looms"}');

  await alan.goto(page.url());
  await expect(card(alan)).toContainText("Rename");
  await expect(card(alan)).toContainText("Asks each time");
  await expect(card(alan)).toContainText("Paused");
  await expect(card(alan).getByRole("button", { name: "Deny" })).toBeDisabled();
  await grace.goto(page.url());
  await expect(card(grace)).not.toContainText("Paused");
  await card(grace).getByRole("button", { name: "Allow", exact: true }).click();

  await expect(line(alan, /^Thread › Rename · Ran · allowed by Grace Hopper/)).toBeVisible();
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
  const me = (await (await guest.request.get("/api/v1/me")).json()) as {
    user: { id: string };
  };
  const revoked = await page.request.delete(`/api/v1/threads/${threadId}/guests/${me.user.id}`);
  expect(revoked.ok()).toBe(true);

  await write(page, '/tool thread.rename {"title":"Pistons"}');
  const allow = card(page).getByRole("button", { name: "Allow", exact: true });
  const forNow = card(page).getByRole("button", { name: "Allow for now" });
  const deny = card(page).getByRole("button", { name: "Deny" });
  // The card shows with the call's event, paused, and its buttons are made anew once the reader's
  // policy for it loads; they are measured after that.
  await expect(deny).toBeEnabled();
  const [a, b, c] = await Promise.all([allow, forNow, deny].map((button) => button.boundingBox()));
  expect(a!.x).toBe(c!.x);
  expect(a!.width).toBe(c!.width);
  expect(a!.y).toBeLessThan(b!.y);
  expect(b!.y).toBeLessThan(c!.y);
  await allow.click();
  await expect(line(page, /^Thread › Rename · Ran/)).toBeVisible();
});

test("a tool the space turned off is not offered, and the agent says it cannot use it", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await setInSpace(page, spaceId, "Move", "Off");

  await startThread(page, '/tool thread.move {"folder":"Research"}');
  await expect(replies(page)).toHaveText(/I cannot use thread.move here\./);
  await expect(card(page)).toHaveCount(0);
});

test("a policy made from a template is used for a group and a tool, and a space adds rules on top", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await openTools(page, "/org/tools");
  const interactive = page.getByRole("group", {
    name: "Interactive tools",
    exact: true,
  });

  // A new policy from a group's picker is used for that group once made.
  await picker(interactive, "Interactive tools").click();
  await page.getByRole("menuitem", { name: "New policy" }).click();
  const dialog = page.getByRole("dialog", { name: "New policy" });
  await expect(dialog).toContainText("It will be used for Thread interactive tools.");
  await expect(dialog.getByRole("button", { name: "Anyone can use" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "Always approve" }).click();
  await expect(dialog.getByRole("radio", { name: /^No one/ })).toBeChecked();
  await dialog.getByLabel("Name").fill("Sign-off");
  await expect(dialog).toContainText("Pick at least one approver");
  await expect(dialog.getByRole("button", { name: "Create policy" })).toBeDisabled();
  const approvers = dialog.getByRole("combobox", { name: "Approvers" });
  await approvers.fill("anyone");
  await expect(page.getByRole("option", { name: /Anyone who can edit the thread/ })).toBeVisible();
  await approvers.press("Enter");
  await expect(dialog).not.toContainText("Pick at least one approver");
  // Backspace in the empty search takes back the last one; Enter adds the top match again.
  await approvers.press("Backspace");
  await expect(dialog).toContainText("Pick at least one approver");
  await approvers.press("Enter");
  await expect(dialog).not.toContainText("Pick at least one approver");
  // Picking "Only these people" follows the template it matches.
  await dialog.getByRole("radio", { name: /^Only these people/ }).click();
  await expect(dialog.getByRole("button", { name: "Some can use" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("radio", { name: /^No one/ }).click();
  await dialog.getByRole("button", { name: "Create policy" }).click();
  await expect(dialog).toBeHidden();

  const move = page.getByRole("listitem", { name: "Move" });
  await expect(picker(move, "Move")).toContainText("Sign-off");
  await expect(picker(interactive, "Interactive tools")).toContainText("Sign-off");
  const policies = page.getByRole("listitem", { name: "Sign-off" });
  await expect(policies).toContainText("Thread editors approve");
  await expect(policies).toContainText("4 tools");

  // A policy in use can be copied but not deleted.
  await policies.getByRole("button").click();
  const edit = page.getByRole("dialog", { name: "Edit policy" });
  await expect(edit).toContainText("Used by 4 tools. Changes apply to all of them.");
  await expect(edit.getByRole("button", { name: "Delete" })).toBeDisabled();
  await edit.getByRole("button", { name: "Duplicate" }).click();
  const copy = page.getByRole("dialog", { name: "New policy" });
  await expect(copy.getByLabel("Name")).toHaveValue("Sign-off copy");
  await copy.getByRole("button", { name: "Cancel" }).click();
  await expect(copy).toBeHidden();

  // One tool back to open; the group is mixed.
  await picker(move, "Move").click();
  await choose(page, "Open");
  await expect(picker(interactive, "Interactive tools")).toContainText("Mixed");
  await expect(policies).toContainText("3 tools");

  // In the space, the org's tools follow the org's policy by default.
  await openTools(page, `/s/${spaceId}/settings/tools`);
  const thread = page.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("6 tools");
  await expect(thread.getByRole("button", { name: /^Thread 6 tools/ })).toContainText("3 Sign-off");
  const rename = page.getByRole("listitem", { name: "Rename" });
  await expect(picker(rename, "Rename")).toContainText("Default · Sign-off");
  await expect(page.getByRole("listitem", { name: "Sign-off" })).toContainText("Organization");
  const spaceGroup = page.getByRole("group", {
    name: "Interactive tools",
    exact: true,
  });
  await picker(spaceGroup, "Interactive tools").click();
  await choose(page, "Off");
  await expect(picker(rename, "Rename")).toContainText("Off");
  await expect(thread.getByRole("button", { name: /^Thread 6 tools/ })).toContainText("4 Off");

  // The org still has its own; the space's rules stay in the space.
  await openTools(page, "/org/tools");
  await expect(picker(page.getByRole("listitem", { name: "Rename" }), "Rename")).toContainText(
    "Sign-off",
  );

  await openTools(page, `/s/${spaceId}/settings/tools`);
  await thread.getByRole("button", { name: /^Thread 6 tools/ }).click();
  await expect(rename).toBeHidden();
  await page.reload();
  await expect(page.getByRole("region", { name: "Thread" })).toContainText("6 tools");
  await expect(page.getByRole("listitem", { name: "Rename" })).toBeHidden();
});

test("a policy's people use a tool directly, and only its approvers approve the rest", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await openTools(page, "/org/tools");
  await page.getByRole("button", { name: "New policy" }).click();
  const dialog = page.getByRole("dialog", { name: "New policy" });
  await dialog.getByRole("button", { name: "Some can use" }).click();
  await dialog.getByLabel("Name").fill("Ada runs");
  await dialog.getByRole("combobox", { name: "People who can use it" }).fill("Ada");
  await page.getByRole("option", { name: /Ada Lovelace/ }).click();
  await dialog.getByRole("combobox", { name: "Approvers" }).fill("Ada");
  await page.getByRole("option", { name: /Ada Lovelace/ }).click();
  await expect(dialog.getByRole("combobox", { name: "Approvers" })).toHaveValue("");
  await dialog.getByRole("button", { name: "Create policy" }).click();
  await expect(dialog).toBeHidden();
  const policy = page.getByRole("listitem", { name: "Ada runs" });
  await expect(policy).toContainText("Ada Lovelace can use");
  await expect(policy).toContainText("Ada Lovelace approves");
  const rename = page.getByRole("listitem", { name: "Rename" });
  await picker(rename, "Rename").click();
  await choose(page, "Ada runs");

  await page.goto(`/s/${spaceId}`);
  await startThread(page, '/tool thread.rename {"title":"Mine"}');
  await expect(line(page, /^Thread › Rename · Ran$/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/Tool thread.rename said: ok/);

  // Grace may message here but is not named: her call waits, and only Ada may approve it.
  const grace = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(grace, "Grace Hopper"), "messager");
  await grace.goto(page.url());
  await expect(line(grace, /^Thread › Rename · Ran$/)).toBeVisible();
  await write(grace, '/tool thread.rename {"title":"Hers"}');
  await expect(card(grace)).toContainText("Rename");
  await expect(card(grace)).toContainText("Paused");
  await expect(card(grace).getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  await expect(card(page)).not.toContainText("Paused");
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(line(grace, /^Thread › Rename · Ran · allowed by Ada Lovelace/)).toBeVisible();
  await expect(grace.locator("[data-slot=breadcrumb-page]")).toHaveText("Hers");
});

test("independent approval needs someone other than the author of the latest message", async ({
  page,
  browser,
}, testInfo) => {
  const adaEmail = await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await openTools(page, `/s/${spaceId}/settings/tools`);
  const rename = page.getByRole("listitem", { name: "Rename" });
  await picker(rename, "Rename").click();
  await page.getByRole("menuitem", { name: "New policy" }).click();
  const dialog = page.getByRole("dialog", { name: "New policy" });
  await expect(dialog).toContainText("Only in this space.");
  await dialog.getByRole("button", { name: "Independent approval" }).click();
  await expect(dialog.getByRole("checkbox", { name: /Independent approval/ })).toBeChecked();
  await dialog.getByLabel("Name").fill("Reviewed");
  await dialog.getByRole("combobox", { name: "Approvers" }).fill("anyone");
  await page.getByRole("option", { name: /Anyone who can edit the thread/ }).click();
  await dialog.getByRole("button", { name: "Create policy" }).click();
  await expect(dialog).toBeHidden();
  await expect(picker(rename, "Rename")).toContainText("Reviewed");
  await expect(picker(rename, "Rename")).toHaveAttribute("title", /Independent/);
  await expect(page.getByRole("listitem", { name: "Reviewed" })).toContainText("1 tool");

  await page.goto(`/s/${spaceId}`);
  await startThread(page, '/tool thread.rename {"title":"Reviewed"}');
  await expect(card(page)).toContainText("Needs review");
  await expect(card(page).getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "Allow for now" })).toHaveCount(0);
  const reviewer = await someoneElse(browser, testInfo.parallelIndex);
  joinSpaceOf(adaEmail, await signUp(reviewer, "Grace Hopper"), "messager");
  await reviewer.goto(page.url());
  await expect(card(reviewer).getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
  await card(reviewer).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(line(page, /^Thread › Rename · Ran · allowed by Grace Hopper/)).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Reviewed");
});

test("changing independent approval to sign-off updates a pending approval for the requester", async ({
  page,
}) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await makePolicy(page, { name: "Independent review", independent: true });
  await makePolicy(page);
  await setInSpace(page, spaceId, "Rename", "Independent review");
  await startThread(page, '/tool thread.rename {"title":"Engines"}');
  const threadUrl = page.url();
  await expect(card(page)).toContainText("Needs review");
  await expect(card(page).getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  await setInSpace(page, spaceId, "Rename", "Sign-off");
  await page.goto(threadUrl);
  await expect(card(page)).toContainText("Asks each time");
  await expect(card(page)).not.toContainText("Needs review");
  await expect(card(page).getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(line(page, /^Thread › Rename · Ran · allowed by Ada Lovelace/)).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Engines");
});

test("built-in toolset switches preserve policies and obey the org switch", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await makePolicy(page);
  await makePolicy(page, { name: "Independent review", independent: true });
  await setInSpace(page, spaceId, "Rename", "Sign-off");
  await openTools(page, `/s/${spaceId}/settings/tools`);
  const local = page.getByRole("switch", { name: "Thread: on in this space" });
  await expect(local).toBeChecked();
  await local.click();
  await expect(local).not.toBeChecked();
  await page.reload();
  await expect(local).not.toBeChecked();
  // Asking stays on, and Details goes off with the rest.
  const ask = picker(page.getByRole("listitem", { name: "Ask" }), "Ask");
  await expect(ask).toContainText("On");
  await expect(ask).toBeDisabled();
  await ask.hover({ force: true });
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText("Always on");
  await expect(picker(page.getByRole("listitem", { name: "Details" }), "Details")).toBeEnabled();
  const rename = page.getByRole("listitem", { name: "Rename" });
  await expect(picker(rename, "Rename")).toContainText("Sign-off");
  await picker(rename, "Rename").click();
  await choose(page, "Independent review");
  await expect(picker(rename, "Rename")).toContainText("Independent review");
  await page.goto(`/s/${spaceId}`);
  await startThread(page, '/tool thread.rename {"title":"Unavailable"}');
  await expect(replies(page).last()).toContainText("I cannot use thread.rename here.");
  await openTools(page, "/org/tools");
  const global = page.getByRole("switch", { name: "Thread: on", exact: true });
  await global.click();
  await expect(global).not.toBeChecked();
  await openTools(page, `/s/${spaceId}/settings/tools`);
  await expect(local).not.toBeChecked();
  await expect(local).toBeDisabled();
  await expect(page.getByRole("region", { name: "Thread" })).toContainText("Off by organization");
  await openTools(page, "/org/tools");
  await global.click();
  await expect(global).toBeChecked();
  await openTools(page, `/s/${spaceId}/settings/tools`);
  await expect(local).not.toBeChecked();
  await expect(local).toBeEnabled();
  await local.click();
  await expect(local).toBeChecked();
  await expect(picker(rename, "Rename")).toContainText("Independent review");
});

test("tools have their own settings page in the org and in a space", async ({ page }) => {
  await signUp(page, "Ada Lovelace");
  const spaceId = spaceIdOf(page);
  await page.goto("/org/general");
  await expect(page.getByRole("region", { name: "Thread" })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name: "Tools and MCPs" })
    .click();
  await expect(page).toHaveURL(/\/org\/tools$/);
  // The page's title is the only "Tools and MCPs" heading; the toolsets are in a card for their source.
  await expect(page.getByRole("heading", { name: "Tools and MCPs", exact: true })).toHaveCount(1);
  await expect(builtIn(page)).toHaveCount(1);
  await expect(builtIn(page).getByRole("region", { name: "Thread" })).toContainText("6 tools");
  // What is always on shows with its switch on and disabled.
  const rich = builtIn(page).getByRole("region", { name: "Rich replies" });
  await expect(rich).toContainText("Cards, tables and buttons in the agent's replies");
  await expect(rich.getByRole("switch")).toBeChecked();
  await expect(rich.getByRole("switch")).toBeDisabled();
  await rich.getByRole("switch").hover({ force: true });
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText("Always on");

  // A person's own space has no members to set.
  await page.goto(`/s/${spaceId}/settings`);
  const nav = page.getByRole("navigation", { name: "Space settings" });
  await expect(nav.getByRole("link")).toHaveText(["General", "Tools and MCPs", "Skills"]);
  await expect(page.getByRole("region", { name: "Thread" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Tools and MCPs" }).click();
  await expect(page).toHaveURL(/\/settings\/tools$/);
  await expect(page.getByRole("region", { name: "Thread" })).toContainText("6 tools");
  await expect(page.getByRole("heading", { name: "Tools and MCPs", exact: true })).toHaveCount(1);
  await expect(builtIn(page).getByRole("region", { name: "Thread" })).toHaveCount(1);
  await page.goto(`/s/${spaceId}/settings/members`);
  await expect(page).toHaveURL(/\/settings$/);
});
