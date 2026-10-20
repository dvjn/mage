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

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
}

test("settings shows the default model card", async ({ page }) => {
  await signUpToSettings(page);
  await expect(page.getByText("Default model", { exact: true })).toBeVisible();
  await expect(page.getByText("Pick a default model for new threads.")).toBeVisible();
  await expect(page.getByPlaceholder("Connect an account first")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh models" })).toBeVisible();
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
            authKind: "codex",
          },
          {
            ref: "claude/claude-big",
            id: "claude-big",
            name: "Claude Big",
            connectionId: "c2",
            authKind: "claude",
          },
        ],
        errors: [{ connectionId: "c3", message: "Could not read the Claude models. Try again." }],
      },
    }),
  );

  await signUpToSettings(page);
  await expect(page.getByRole("alert").filter({ hasText: "Could not read" })).toBeVisible();
  await page.getByPlaceholder("Pick a default").click();
  const list = page.getByRole("listbox");
  await expect(list.getByText("Codex", { exact: true })).toBeVisible();
  await expect(list.getByText("Claude", { exact: true })).toBeVisible();
  await list.getByRole("option", { name: "Claude Big" }).click();
  // The server refuses a model its connections do not offer.
  await expect(page.getByRole("alert").filter({ hasText: "not a model" })).toBeVisible();
});
