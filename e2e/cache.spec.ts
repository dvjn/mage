import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 30;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function signUp(page: Page, name: string) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("Your space");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
}

async function startThread(page: Page, text: string) {
  await page.getByLabel("First message").fill(text);
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.getByRole("log", { name: "Events" }).getByText(text)).toBeVisible();
}

// Everything the browser has persisted, as text.
async function persisted(context: BrowserContext) {
  return JSON.stringify(await context.storageState({ indexedDB: true }));
}

test("a thread paints from the cache while the server has not answered", async ({
  page,
  context,
}) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "How do engines compute?");
  await page.getByLabel("Message", { exact: true }).fill("And what about looms?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const messages = page.getByRole("log", { name: "Events" });
  await expect(messages.getByText("And what about looms?")).toBeVisible();
  // The agent's answer to it, kept once everything before it is.
  await expect.poll(() => persisted(context)).toContain("I have read 2 messages");

  // Reads of the API never answer; only the session check does.
  await page.route(/\/api\/v1\//, async (route) => {
    if (route.request().method() !== "GET") await route.continue();
  });
  await page.reload();
  await expect(messages.getByText("How do engines compute?")).toBeVisible();
  await expect(messages.getByText("And what about looms?")).toBeVisible();
  await expect(page.locator("[data-slot=breadcrumb-page]")).toHaveText("How do engines compute?");
  await expect(
    page.locator("[data-sidebar=sidebar]").getByRole("link", { name: "How do engines compute?" }),
  ).toBeVisible();
});

test("a thread the server cannot be reached for shows as cached while it reconnects", async ({
  page,
  context,
}) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "How do engines compute?");
  const messages = page.getByRole("log", { name: "Events" });
  await expect(messages.getByRole("article", { name: "Message from Agent" })).toContainText(
    "I have read 1 message",
  );
  await expect.poll(() => persisted(context)).toContain("I have read 1 message");

  // The thread's reads and its live events fail as when the network is down.
  const unreachable = /\/api\/v1\/threads\/[^/?]+(\/events)?(\?.*)?$/;
  await page.route(unreachable, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(messages.getByText("How do engines compute?")).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("Reconnecting…");
  await expect(page.getByText("This thread does not exist")).toBeHidden();

  await page.unroute(unreachable);
  await expect(page.getByRole("status", { name: "Connection" })).toBeHidden({ timeout: 15_000 });
  await expect(messages.getByText("How do engines compute?")).toBeVisible();
});

test("signing out leaves nothing of the user for the next one", async ({ page, context }) => {
  await signUp(page, "Ada Lovelace");
  await startThread(page, "Ada's private notes");
  await expect.poll(() => persisted(context)).toContain("Ada's private notes");
  await signOut(page);
  await expect.poll(() => persisted(context)).not.toContain("Ada's private notes");

  await signUp(page, "Grace Hopper");
  const sidebar = page.locator("[data-sidebar=sidebar]");
  await expect(sidebar.getByText("Grace Hopper").first()).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Ada's private notes" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Threads" })).toContainText("No threads yet.");
});
