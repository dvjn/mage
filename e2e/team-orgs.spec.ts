import { type Browser, expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each person counts as their own client.
let client = 60;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.1.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function fillSignUp(page: Page, name: string, email?: string) {
  await page.getByLabel("Name", { exact: true }).fill(name);
  if (email) await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
}

async function someoneElse(browser: Browser, index: number) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  return context.newPage();
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

async function openSpaceMenu(page: Page) {
  await page.getByRole("button", { name: "Switch space" }).click();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
}

test("a team org: invites, groups, two orgs side by side, and removing a member", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const graceEmail = `grace-${crypto.randomUUID()}@example.com`;

  // Ada creates the org and lands on its settings.
  await page.goto("/signup");
  await fillSignUp(page, "Ada Lovelace", `ada-${crypto.randomUUID()}@example.com`);
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await openSpaceMenu(page);
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Analytical Engines");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL("/org/general");
  await expect(page.getByText("Get your organization started")).toBeVisible();
  await page.goto("/");
  await openSpaceMenu(page);
  await expect(page.getByRole("menuitem", { name: "Organization settings" })).toHaveText(
    "Analytical Engines",
  );
  await page.getByRole("menuitem", { name: "Organization settings" }).click();
  await expect(page).toHaveURL("/org/general");

  // An API key, through the stand-in provider; subscriptions are not offered.
  await page.getByRole("button", { name: "Add a model provider" }).click();
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option", { name: /^ChatGPT ·/ })).toHaveCount(0);
  await dialog.getByRole("option", { name: /^OpenAI ·/ }).click();
  await expect(dialog.getByRole("heading", { name: "Add an OpenAI API key" })).toBeVisible();
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByRole("option", { name: /^Anthropic ·/ }).click();
  await dialog.getByLabel("API key").fill("sk-ant-team-1234");
  await dialog.getByRole("button", { name: "Add key" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row", { name: /Anthropic/ })).toContainText("sk-ant-…1234");

  // Grace is invited by email.
  const nav = page.getByRole("navigation", { name: "Organization settings" });
  await nav.getByRole("link", { name: "People" }).click();
  await expect(page).toHaveURL("/org/people");
  await page.getByRole("button", { name: "Add people" }).click();
  // The directory other journeys fill may name groups here too.
  await page.getByLabel(/^Name(, email or group| or email)$/).fill(graceEmail);
  await expect(page.getByRole("list", { name: "Suggestions" })).toContainText(
    `Invite ${graceEmail} as`,
  );
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const link = page.getByRole("textbox", { name: "Invite link" });
  await expect(link).toHaveValue(/\/join\//);
  const joinUrl = await link.inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  // The invite is a row of the people table, found by its status.
  const people = page.getByRole("table", { name: "People" });
  await expect(people.getByRole("row", { name: graceEmail })).toContainText("expires");
  await page.getByRole("button", { name: "Status" }).click();
  await page.getByRole("option", { name: "Invited" }).click();
  await expect(page).toHaveURL(/status=invited/);
  await expect(people.getByRole("row", { name: "Ada Lovelace" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(people.getByRole("row", { name: "Ada Lovelace" })).toBeVisible();

  // Grace signs up through the link with the invited email and lands in General.
  const grace = await someoneElse(browser, testInfo.parallelIndex);
  await grace.goto(joinUrl);
  await expect(grace.getByText("Join Analytical Engines")).toBeVisible();
  await grace.getByRole("button", { name: "Create account" }).click();
  await expect(grace.getByLabel("Email")).toHaveValue(graceEmail);
  await fillSignUp(grace, "Grace Hopper");
  await expect(grace).toHaveURL(/\/s\/[^/]+$/);
  await expect(grace.locator("[data-slot=breadcrumb-page]")).toHaveText("General");
  await send(grace, "Hello from Grace");
  await expect(grace).toHaveURL(/\/t\/[^/]+$/);
  await expect(transcript(grace).getByRole("article", { name: "Message from Agent" })).toHaveText(
    /I have read 1 message/,
  );
  const generalThread = grace.url();

  // A second tab of Ada's works in her personal org beside the team org.
  const personal = await page.context().newPage();
  await personal.goto("/");
  await expect(personal).toHaveURL(/\/s\//);
  await openSpaceMenu(personal);
  await personal.getByRole("menuitem", { name: "Switch organization" }).click();
  await personal.getByRole("menuitem", { name: /Personal/ }).click();
  await expect(personal.getByRole("button", { name: "Switch space" })).toContainText("Personal");
  await page.goto(generalThread);
  await expect(page.getByRole("button", { name: "Switch space" })).toContainText(
    "Analytical Engines",
  );
  await send(personal, "A note to myself");
  await expect(personal).toHaveURL(/\/t\/[^/]+$/);
  await expect(
    transcript(personal).getByRole("article", { name: "Message from Agent" }),
  ).toHaveText(/I have read 1 message/);
  await send(page, "// Welcome, Grace");
  await expect(
    transcript(page).getByRole("article", { name: "Message from Ada Lovelace" }),
  ).toHaveText(/Welcome, Grace/);
  await personal.close();

  // The old address of groups leads to the people, and searching narrows them on the server.
  await page.goto("/org/groups");
  await expect(page).toHaveURL("/org/people");
  await page.getByLabel("Search people").fill("grace");
  await expect(page).toHaveURL(/q=grace/);
  await expect(people.getByRole("row", { name: "Ada Lovelace" })).toHaveCount(0);
  await expect(people.getByRole("row", { name: "Grace Hopper" })).toBeVisible();

  // Grace gets the viewer role in a new space.
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "New space" }).click();
  await page.getByLabel("Name").fill("Loom room");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  const loomRoom = page.url();
  await send(page, "Patterns on punched cards");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const loomThread = page.url();
  await page.goto(`${loomRoom}/settings/members`);
  await page.getByRole("button", { name: "Add people" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Person").click();
  await page.getByLabel("Search people and groups").fill("grace");
  await page.getByRole("option", { name: /Grace Hopper/ }).click();
  await add.getByLabel("Role").click();
  await page.getByRole("option", { name: "Viewer" }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  const spaceMembers = page.getByRole("table", { name: "Members" });
  await expect(spaceMembers.getByRole("row", { name: "Grace Hopper" })).toBeVisible();
  // Wide, the role column changes everyone's role, so their row has no menu.
  await expect(
    spaceMembers.getByRole("button", { name: /^Actions for Everyone in / }),
  ).toBeHidden();
  // A glance at a name says who they are.
  await spaceMembers.getByRole("button", { name: "About Grace Hopper" }).hover();
  await expect(page.getByText(graceEmail).last()).toBeVisible();

  // Owners see every space of the org, members' private ones marked with their person.
  await page.goto("/org/general");
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name: "Spaces" })
    .click();
  await expect(page).toHaveURL("/org/spaces");
  const spaces = page.getByRole("table", { name: "Spaces" });
  await expect(spaces.getByRole("row", { name: "Loom room" })).toBeVisible();
  await expect(spaces.getByRole("row", { name: "Grace Hopper's Space" })).toContainText("Private");
  await expect(page.getByLabel("Who can create spaces")).toContainText("Every member");

  // Grace reads the thread but cannot write in it.
  await grace.goto(loomThread);
  await expect(transcript(grace)).toContainText("Patterns on punched cards");
  await expect(grace.getByText("You can view this thread")).toBeVisible();

  // Grace's message waits while the agent replies very slowly to Ada; then Ada removes her.
  await grace.goto(generalThread);
  await page.goto(generalThread);
  await send(page, "Tell us about engines very slowly");
  await expect(
    transcript(page).getByRole("article", { name: "Message from Agent" }).last(),
  ).toContainText("I have read 3 messages");
  await send(grace, "Me next");
  const waiting = (who: Page) =>
    who.getByRole("listitem", { name: "Waiting message from Grace Hopper" });
  await expect(waiting(page)).toBeVisible();
  await expect(waiting(grace)).toBeVisible();
  await page.goto("/org/people");
  await page.getByRole("row", { name: "Grace Hopper" }).hover();
  await page.getByRole("button", { name: "Actions for Grace Hopper" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove Grace Hopper?");
  await expect(confirm).toContainText("They lose access to Analytical Engines and its spaces.");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("row", { name: "Grace Hopper" })).toBeHidden();

  // Her waiting message is dropped, her stream ends and she is back in her own org, and what she
  // wrote says she left.
  await expect(waiting(grace)).toBeHidden();
  await expect(grace.getByRole("button", { name: "Switch space" })).toContainText("Personal", {
    timeout: 25_000,
  });
  await page.goto(generalThread);
  await expect(waiting(page)).toBeHidden();
  await expect(
    transcript(page).getByRole("article", { name: "Message from Grace Hopper" }).first(),
  ).toContainText("former member");
});

test("an owner renames an org and then deletes it", async ({ page }) => {
  await page.goto("/signup");
  await fillSignUp(page, "Ada Lovelace", `ada-${crypto.randomUUID()}@example.com`);
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await openSpaceMenu(page);
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Scratch");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL("/org/general");

  await page.getByLabel("Organization name").fill("Scratch Works");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeHidden();
  await openSpaceMenu(page);
  await expect(page.getByRole("menuitem", { name: "Organization settings" })).toHaveText(
    "Scratch Works",
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Delete organization" }).click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Delete organization" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type Scratch Works to confirm").fill("Scratch Works");
  await confirm.click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(page.getByRole("button", { name: "Switch space" })).toContainText("Personal");
  await openSpaceMenu(page);
  await expect(page.getByRole("menuitem", { name: "Switch organization" })).toBeHidden();
});
