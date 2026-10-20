import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; these journeys count as their own client.
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.7" } });

async function signUpToSettings(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Full Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
}

test("settings offers the Codex sign-in and rejects a pasted address from another sign-in", async ({
  page,
  context,
}) => {
  // The authorize page is never loaded from OpenAI.
  await context.route("https://auth.openai.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>OpenAI</title>" }),
  );

  await signUpToSettings(page);
  await expect(page.getByText("Sign in with Codex")).toBeVisible();
  await expect(page.getByRole("button", { name: "Device code" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Get a code" })).toBeVisible();

  await page.getByRole("button", { name: "Browser" }).click();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open the Codex sign-in" }).click(),
  ]);
  await popup.waitForURL(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  const authorize = new URL(popup.url());
  expect(authorize.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");

  await page
    .getByLabel("Callback URL")
    .fill("http://localhost:1455/auth/callback?code=abc&state=another-sign-in");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toContainText("different sign-in");
});

test("settings offers the Claude sign-in with its billing note", async ({ page, context }) => {
  // The authorize page is never loaded from Claude.
  await context.route("https://claude.ai/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Claude</title>" }),
  );

  await signUpToSettings(page);
  await expect(page.getByText("Sign in with Claude")).toBeVisible();
  await expect(page.getByRole("link", { name: "extra usage" })).toHaveAttribute(
    "href",
    "https://claude.ai/settings/usage",
  );

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open the Claude sign-in" }).click(),
  ]);
  await popup.waitForURL(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
  const authorize = new URL(popup.url());
  expect(authorize.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "https://platform.claude.com/oauth/code/callback",
  );

  await page.getByLabel("Code").fill("abc#another-sign-in");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toContainText("different sign-in");
});

test("settings needs a session", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL("/login");
});
