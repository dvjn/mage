import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; these journeys count as their own client.
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.8" } });

async function signUpToSettings(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);

  await page.getByRole("button", { name: "Switch space" }).click();
  await page.getByRole("menuitem", { name: "Organization settings" }).click();
  await expect(page).toHaveURL("/org/general");
}

test("settings shows the default model card", async ({ page }) => {
  await signUpToSettings(page);
  await expect(page.getByText("Default model", { exact: true })).toBeVisible();
  await expect(page.getByText("Pick a default model for new threads.")).toBeVisible();
  await expect(page.getByLabel("Default model")).toBeDisabled();
  await expect(page.getByLabel("Default model")).toContainText("Add a model provider first");
  await expect(page.getByRole("button", { name: "Refresh models" })).toBeVisible();
  await expect(page.getByLabel("Title model")).toContainText("Automatic · each thread's model");
});

test("the default model picker groups models by connection and shows list errors", async ({
  page,
}) => {
  // Stands in for the server's live lists, which need real provider accounts.
  await page.route("**/api/v1/models?*", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            ref: "codex/gpt-big",
            id: "gpt-big",
            name: "GPT Big",
            connectionId: "c1",
            host: "codex",
            maker: "openai",
            authKind: "oauth",
            connectionLabel: "ChatGPT",
            connectionName: null,
          },
          {
            ref: "c2/claude-big",
            id: "claude-big",
            name: "Claude Big",
            connectionId: "c2",
            host: "anthropic",
            maker: "anthropic",
            authKind: "api_key",
            connectionLabel: "Anthropic API key",
            connectionName: null,
          },
        ],
        errors: [{ connectionId: "c3", message: "Could not read the Claude models. Try again." }],
        turnedOff: [],
      },
    }),
  );

  await signUpToSettings(page);
  await expect(page.getByRole("alert").filter({ hasText: "Could not read" })).toBeVisible();
  await page.getByLabel("Default model").click();
  const list = page.getByRole("listbox");
  await expect(list.getByText("ChatGPT", { exact: true })).toBeVisible();
  await expect(list.getByText("Anthropic API key", { exact: true })).toBeVisible();
  await list.getByRole("option", { name: "Claude Big" }).click();
  // The server refuses a model its connections do not offer.
  await expect(page.getByRole("alert").filter({ hasText: "not a model" })).toBeVisible();
});
