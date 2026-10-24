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

test("threads read before can be read again offline, and the app picks up once back online", async ({
  page,
  context,
}) => {
  await signUp(page, "Ada Lovelace");
  await send(page, "How do engines compute?");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const messages = page.getByRole("log", { name: "Events" });
  await expect(messages.getByRole("article", { name: "Message from Agent" })).toContainText(
    "I have read 1 message",
  );
  await expect.poll(() => persisted(context)).toContain("I have read 1 message");
  // The app's own files are kept once its service worker runs the page.
  await expect.poll(() => page.evaluate("navigator.serviceWorker.controller !== null")).toBe(true);

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
