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
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
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
  await add.getByRole("button", { name: new RegExp(groupName) }).click();
  await add.getByRole("button", { name: "Link group" }).click();
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
  await expect(
    transcript(page).getByRole("article", { name: "Message from Grace Hopper" }),
  ).toContainText("former member");
  await page.goto("/org/people");
  await expect(people.getByRole("row", { name: groupName })).toContainText("0 people");
});
