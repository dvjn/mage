import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; each journey counts as its own client, in every
// worker running this file.
let client = 230;
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
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
}

// Everything the browser has persisted, as text.
async function persisted(context: BrowserContext) {
  return JSON.stringify(await context.storageState({ indexedDB: true }));
}

// Signs up, has a thread answered, and waits until it is kept and the app's own files are too.
async function threadKept(page: Page, context: BrowserContext) {
  await signUp(page, "Ada Lovelace");
  await send(page, "How do engines compute?");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(
    page.getByRole("log", { name: "Events" }).getByRole("article", { name: "Message from Agent" }),
  ).toContainText("I have read 1 message");
  await expect.poll(() => persisted(context)).toContain("I have read 1 message");
  // The app's own files are kept once its service worker runs the page.
  await expect.poll(() => page.evaluate("navigator.serviceWorker.controller !== null")).toBe(true);
}

test("threads read before can be read again offline, and the app picks up once back online", async ({
  page,
  context,
}) => {
  await threadKept(page, context);
  const messages = page.getByRole("log", { name: "Events" });

  await context.setOffline(true);
  await page.reload();
  const sidebar = page.locator("[data-sidebar=sidebar]");
  const offline = page.getByRole("status").filter({ hasText: "Offline" });
  await expect(offline).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^How do engines compute\?/ })).toBeVisible();
  await expect(messages.getByText("How do engines compute?")).toBeVisible();
  await expect(messages.getByText("I have read 1 message")).toBeVisible();
  await expect(sidebar.getByText("Ada Lovelace").first()).toBeVisible();
  // Nothing is sent while offline, and nothing says the thread is missing or failing.
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByText("You can send once you are back online.")).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection" })).toBeHidden();
  await expect(page.getByText("This thread does not exist")).toBeHidden();

  await context.setOffline(false);
  await expect(offline).toBeHidden();
  await send(page, "And what about looms?");
  await expect(messages.getByText("And what about looms?")).toBeVisible();
  await expect(messages.getByText("I have read 2 messages")).toBeVisible();
});

test("a server that cannot be reached counts as offline until it answers again", async ({
  page,
  context,
}) => {
  await threadKept(page, context);
  const messages = page.getByRole("log", { name: "Events" });

  // The network is up, but nothing reaches the server.
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  const offline = page.getByRole("status").filter({ hasText: "Offline" });
  await expect(offline).toBeVisible();
  await offline.hover();
  await expect(page.getByText("The server cannot be reached.")).toBeVisible();
  await expect(messages.getByText("I have read 1 message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByText("You can send once you are back online.")).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection" })).toBeHidden();

  // On a phone the sidebar is out of sight, and the header says it instead.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("status", { name: "Offline" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(offline).toBeVisible();

  // The app asks the server again, less often each time, and picks up once it answers.
  await page.unroute("**/api/**");
  await expect(offline).toBeHidden({ timeout: 35_000 });
  await expect(page.getByRole("status", { name: "Connection" })).toBeHidden();
  await send(page, "And what about looms?");
  await expect(messages.getByText("I have read 2 messages")).toBeVisible();
});
