import { type Browser, expect, type Page, test } from "@playwright/test";

import { JOURNEY_SCIM_TOKEN, scimClient } from "./scim-client.ts";

// Sign-ups are rate limited per client address; each person counts as their own client.
let client = 60;
function nextClient(index: number) {
  client += 1;
  return { "X-Forwarded-For": `192.3.${index}.${client}` };
}
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders(nextClient(testInfo.parallelIndex));
});

async function someoneElse(browser: Browser, index: number) {
  const context = await browser.newContext({ extraHTTPHeaders: nextClient(index) });
  return context.newPage();
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

// Signs in at the stand-in provider as the person with `email`.
async function continueWithIdp(page: Page, name: string, email: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Test IdP" }).click();
  await expect(page.getByRole("heading", { name: "Test IdP" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
}

test("a directory group linked to a team org lets its people in, and leaving it takes them out", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  const unique = crypto.randomUUID();
  const graceEmail = `grace-${unique}@example.com`;
  const groupName = `Looms ${unique.slice(0, 8)}`;
  const directory = scimClient({ baseUrl: baseURL ?? "", token: JOURNEY_SCIM_TOKEN });

  // Ada makes a team org and starts a thread in its General space.
  await continueWithIdp(page, "Ada Lovelace", `ada-${unique}@example.com`);
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Analytical Engines");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL("/org/general");

  // The directory brings Grace in a group, and Ada links the group.
  const grace = await directory.createUser({ name: "Grace Hopper", email: graceEmail });
  const looms = await directory.createGroup(groupName, [grace]);
  await page.goto("/org/people");
  await page.getByRole("button", { name: "Add people" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Name, email or group").fill(groupName);
  await page.getByRole("option", { name: new RegExp(groupName) }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  const people = page.getByRole("table", { name: "People" });
  await expect(people.getByRole("row", { name: groupName })).toContainText("1 person");
  await expect(people.getByRole("row", { name: groupName })).toContainText("Directory");
  // In only through the group, Grace has no row of her own; the group's lists her.
  await expect(people.getByRole("row", { name: "Grace Hopper" })).toHaveCount(0);
  await people.getByRole("button", { name: `People in ${groupName}` }).hover();
  await expect(page.locator("[data-slot=hover-card-content]")).toContainText("Grace Hopper");

  // Grace signs in through the identity provider and writes in General.
  await page.goto("/");
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "General" }).click();
  await send(page, "// Welcome");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const generalThread = page.url();
  const graceTab = await someoneElse(browser, testInfo.parallelIndex);
  await continueWithIdp(graceTab, "Grace Hopper", graceEmail);
  await graceTab.goto(generalThread);
  await expect(graceTab.getByRole("button", { name: "Switch space" })).toContainText(
    "Analytical Engines",
  );
  await send(graceTab, "// Hello from the directory");
  await expect(
    transcript(page).getByRole("article", { name: "Message from Grace Hopper" }),
  ).toContainText("Hello from the directory");

  // The directory takes her out of the group: her tab goes back to her own org, and what she
  // wrote says she left.
  await directory.removeMembers(looms, [grace]);
  await expect(graceTab.getByRole("button", { name: "Switch space" })).toContainText("Personal", {
    timeout: 25_000,
  });
  await page.reload();
  await transcript(page)
    .getByRole("article", { name: "Message from Grace Hopper" })
    .getByRole("button", { name: "About Grace Hopper" })
    .hover();
  await expect(page.locator("[data-slot=hover-card-content]")).toContainText("Former member");
  await page.goto("/org/people");
  await expect(people.getByRole("row", { name: groupName })).toContainText("0 people");
});

test("a thread and an artifact are shared with a directory group, as View and as Edit", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const unique = crypto.randomUUID();
  const graceEmail = `grace-${unique}@example.com`;
  const groupName = `Weavers ${unique.slice(0, 8)}`;
  const directory = scimClient({ baseUrl: baseURL ?? "", token: JOURNEY_SCIM_TOKEN });

  // Ada's team org, with a directory group of Grace linked to it.
  await continueWithIdp(page, "Ada Lovelace", `ada-${unique}@example.com`);
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Weaving Works");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL("/org/general");
  const grace = await directory.createUser({ name: "Grace Hopper", email: graceEmail });
  await directory.createGroup(groupName, [grace]);
  await page.goto("/org/people");
  await page.getByRole("button", { name: "Add people" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Name, email or group").fill(groupName);
  await page.getByRole("option", { name: new RegExp(groupName) }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  const graceTab = await someoneElse(browser, testInfo.parallelIndex);
  await continueWithIdp(graceTab, "Grace Hopper", graceEmail);

  // Ada's own space and a thread in it, which Grace is not in.
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "New space" }).click();
  await page.getByLabel("Name").fill("Loom room");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await send(page, "// Looms");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // Someone in the space is listed and marked, not left out.
  await page.getByRole("button", { name: "Share" }).click();
  const share = page.getByRole("dialog", { name: "Share this thread" });
  await share.getByPlaceholder("Add people").fill("Ada");
  await expect(page.getByRole("option", { name: /Ada Lovelace/ })).toContainText("Owner");
  await share.getByPlaceholder("Add people").fill("");
  await share
    .getByRole("group", { name: "Access for the person added" })
    .getByRole("button", { name: "View", exact: true })
    .click();
  await share.getByPlaceholder("Add people").fill(groupName);
  await page.getByRole("option", { name: new RegExp(groupName) }).click();
  await expect(share.getByRole("listitem", { name: groupName })).toContainText("Group · 1 person");

  // Grace finds it under Shared with you and can only read it.
  await graceTab.goto("/shared");
  await graceTab.getByRole("link", { name: /Looms/ }).first().click();
  await expect(transcript(graceTab).getByText("// Looms")).toBeVisible();
  await expect(graceTab.getByText("You can view this thread")).toBeVisible();

  // An artifact in the space, shared with the group to edit.
  await share.getByRole("button", { name: "Close" }).click();
  await expect(share).toBeHidden();
  await send(
    page,
    `/tool artifact.publish ${JSON.stringify({
      html: "<title>Loom chart</title><h1>Looms</h1>",
      description: "Looms by year",
      icon: "chart",
    })}`,
  );
  await page.getByTestId("artifact-card").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/artifacts\/[^/]+$/);
  const artifactUrl = page.url();
  await page.getByRole("button", { name: "Share" }).click();
  const sheet = page.getByRole("dialog", { name: "Share this artifact" });
  await sheet
    .getByRole("group", { name: "Access for the person added" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await sheet.getByPlaceholder("Add people").fill(groupName);
  await page.getByRole("option", { name: new RegExp(groupName) }).click();
  await expect(sheet.getByRole("listitem", { name: groupName })).toContainText("Group");

  await graceTab.goto(artifactUrl);
  await graceTab.getByRole("button", { name: "Share" }).click();
  const hers = graceTab.getByRole("dialog", { name: "Share this artifact" });
  await hers.getByRole("radio", { name: "Organization" }).click();
  await expect(hers.getByRole("radio", { name: "Organization" })).toBeChecked();
});

test("a directory group is found in Add people by its email", async ({ page, baseURL }) => {
  const unique = crypto.randomUUID();
  const groupName = `Spinners ${unique.slice(0, 8)}`;
  const groupEmail = `spinners-${unique.slice(0, 8)}@example.com`;
  const directory = scimClient({ baseUrl: baseURL ?? "", token: JOURNEY_SCIM_TOKEN });

  await continueWithIdp(page, "Ada Lovelace", `ada-${unique}@example.com`);
  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Spinning Works");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL("/org/general");
  await directory.createGroup(groupName, [], groupEmail);

  await page.goto("/org/people");
  await page.getByRole("button", { name: "Add people" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Name, email or group").fill(groupEmail);
  const option = page.getByRole("option", { name: new RegExp(groupName) });
  await expect(option).toContainText(groupEmail);
  // The email is the group's, so there is no one to invite by it.
  await expect(add.getByText(`Invite ${groupEmail}`)).toHaveCount(0);
  await option.click();
  await expect(add.getByRole("button", { name: "Add", exact: true })).toBeVisible();
});
