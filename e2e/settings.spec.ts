import { expect, type Page, test } from "@playwright/test";

// Sign-ups are rate limited per client address; these journeys count as their own client.
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.7" } });

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
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name: "Model providers" })
    .click();
  await expect(page).toHaveURL("/org/providers");
}

// Opens the add-provider journey at the provider and way of connecting given.
async function addProvider(page: Page, provider: string, method: string) {
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: new RegExp(`^${provider}`) }).click();
  await dialog.getByRole("button", { name: new RegExp(`^${method}`) }).click();
  return dialog;
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
  await addProvider(page, "OpenAI", "Sign in with ChatGPT");
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

test("Anthropic connects with an API key, with no sign-in to choose", async ({ page }) => {
  await signUpToSettings(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Anthropic/ }).click();
  await expect(dialog.getByRole("heading", { name: "Add an Anthropic API key" })).toBeVisible();
  await expect(dialog.getByLabel("API key")).toBeFocused();
});

test("a connection's proxy is set from its row, its header values never shown", async ({
  page,
}) => {
  // Stands in for a connected ChatGPT account, which needs a real sign-in.
  const connection = {
    id: "c1",
    provider: "openai",
    authKind: "codex",
    account: "ada@chatgpt.example",
    label: null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
  let proxy: { baseUrl: string | null; headerNames: string[] } | null = null;
  const sent: unknown[] = [];
  await page.route("**/api/v1/connections", (route) =>
    route.fulfill({ json: [{ ...connection, proxy }] }),
  );
  await page.route("**/api/v1/connections/c1/proxy", async (route) => {
    const body = route.request().postDataJSON() as {
      baseUrl: string | null;
      headers: Record<string, string | null>;
    };
    sent.push(body);
    proxy =
      body.baseUrl || Object.keys(body.headers).length > 0
        ? { baseUrl: body.baseUrl, headerNames: Object.keys(body.headers) }
        : null;
    await route.fulfill({ json: { ...connection, proxy } });
  });

  await signUpToSettings(page);
  const row = page.getByRole("row", { name: "Codex" });
  await expect(row).toContainText("ada@chatgpt.example");
  await expect(row).toContainText("ChatGPT sign-in");
  await expect(page.getByLabel("Base URL")).toBeHidden();
  await row.getByRole("button", { name: "Actions for Codex" }).click();
  await page.getByRole("menuitem", { name: "Proxy settings…" }).click();
  await expect(page.getByLabel("Base URL")).toHaveAttribute(
    "placeholder",
    "https://chatgpt.com/backend-api/codex",
  );

  await page.getByLabel("Base URL").fill("https://proxy.example.com/v1");
  await page.getByRole("button", { name: "Add header" }).click();
  await page.getByLabel("Header name").fill("X-Team");
  await page.getByLabel("Value of X-Team").fill("blue");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Proxy saved.")).toBeVisible();
  await expect(page.getByLabel("Value of x-team")).toHaveValue("");
  await expect(page.getByLabel("Value of x-team")).toHaveAttribute("placeholder", "••••");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => sent.length).toBe(2);
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Actions for Codex" }).click();
  await page.getByRole("menuitem", { name: "Proxy settings…" }).click();
  await expect(page.getByLabel("Base URL")).toHaveValue("https://proxy.example.com/v1");

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Proxy cleared.")).toBeVisible();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Actions for Codex" }).click();
  await page.getByRole("menuitem", { name: "Proxy settings…" }).click();
  await expect(page.getByLabel("Base URL")).toHaveValue("");
  expect(sent).toEqual([
    { baseUrl: "https://proxy.example.com/v1", headers: { "X-Team": "blue" } },
    { baseUrl: "https://proxy.example.com/v1", headers: { "x-team": null } },
    { baseUrl: null, headers: {} },
  ]);
});

test("settings needs a session", async ({ page }) => {
  await page.goto("/org/providers");
  await expect(page).toHaveURL("/login");
});
