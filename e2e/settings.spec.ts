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

// Opens the add-provider journey at the provider given, and the way of connecting given where it
// has several.
async function addProvider(page: Page, provider: string, method?: string) {
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: new RegExp(`^${provider} ·`) }).click();
  if (method) await dialog.getByRole("button", { name: new RegExp(`^${method}`) }).click();
  return dialog;
}

test("ChatGPT connects with a device code, and says when its models cannot be read", async ({
  page,
}) => {
  // Stands in for OpenAI's device sign-in, which needs a real account: the code is approved once
  // the journey says so, and the account's models then cannot be read.
  const connection = {
    id: "c1",
    host: "codex",
    authKind: "oauth",
    account: "ada@chatgpt.example",
    label: null,
    settings: {},
    hints: {},
    proxy: null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
  const failure = "Could not read the ChatGPT models. Try again.";
  let approved = false;
  let reads = 0;
  await page.route("**/api/v1/connections/codex/device", (route) =>
    route.fulfill({
      json: {
        attemptId: "a1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      },
    }),
  );
  await page.route("**/api/v1/connections/codex/attempts/a1", (route) =>
    route.fulfill({ json: approved ? { status: "connected", connection } : { status: "pending" } }),
  );
  await page.route("**/api/v1/connections", (route) =>
    approved ? route.fulfill({ json: [connection] }) : route.fallback(),
  );
  await page.route(/\/api\/v1\/models(\?.*)?$/, (route) =>
    approved
      ? route.fulfill({
          json: { models: [], errors: [{ connectionId: "c1", message: failure }], turnedOff: [] },
        })
      : route.fallback(),
  );
  await page.route("**/api/v1/connections/c1/models*", (route) => {
    reads += 1;
    return route.fulfill({ status: 502, json: { error: failure } });
  });

  await signUpToSettings(page);
  const dialog = await addProvider(page, "ChatGPT");
  await expect(dialog.getByRole("heading", { name: "Sign in with ChatGPT" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Browser" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Get a code" }).click();
  await expect(dialog.getByText("ABCD-EFGH")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "auth.openai.com/codex/device" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );

  approved = true;
  await expect(dialog.getByRole("status")).toContainText("Connected · couldn't load its models");
  await expect(dialog.getByText(failure)).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row", { name: "ChatGPT" });
  await expect(row).toContainText("Sign in with ChatGPT");
  await expect(row.getByText("Couldn't load")).toBeVisible();
  await row.getByText("Couldn't load").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(failure);
  const before = reads;
  await row.getByRole("button", { name: "Read the models of ChatGPT again" }).click();
  await expect.poll(() => reads).toBe(before + 1);
  await expect(row.getByText("Couldn't load")).toBeVisible();
});

test("Claude connects with the code its sign-in shows", async ({ page, context }) => {
  // The authorize page is never loaded from Claude.
  await context.route("https://claude.ai/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Claude</title>" }),
  );

  await signUpToSettings(page);
  const dialog = await addProvider(page, "Claude");
  await expect(dialog.getByRole("heading", { name: "Sign in with Claude" })).toBeVisible();

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    dialog.getByRole("button", { name: "Open Claude sign-in" }).click(),
  ]);
  await popup.waitForURL(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
  const authorize = new URL(popup.url());
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "https://platform.claude.com/oauth/code/callback",
  );

  await dialog.getByLabel("Code").fill("abc#another-sign-in");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByText("This is from a different sign-in. Start again.")).toBeVisible();
});

test("Anthropic connects with an API key, with no sign-in to choose", async ({ page }) => {
  await signUpToSettings(page);
  const dialog = await addProvider(page, "Anthropic");
  await expect(dialog.getByRole("heading", { name: "Add an Anthropic API key" })).toBeVisible();
  await expect(dialog.getByLabel("API key")).toBeFocused();
});

test("a connection's proxy is set from its row, its header values never shown", async ({
  page,
}) => {
  // Stands in for a connected ChatGPT account, which needs a real sign-in.
  const connection = {
    id: "c1",
    host: "codex",
    authKind: "oauth",
    account: "ada@chatgpt.example",
    label: null,
    settings: {},
    hints: {},
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
  const row = page.getByRole("row", { name: "ChatGPT" });
  await expect(row).toContainText("ada@chatgpt.example");
  await expect(row).toContainText("Sign in with ChatGPT");
  await expect(page.getByLabel("Base URL")).toBeHidden();
  await row.getByRole("button", { name: "Actions for ChatGPT" }).click();
  await page.getByRole("menuitem", { name: "Proxy settings" }).click();
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
  await row.getByRole("button", { name: "Actions for ChatGPT" }).click();
  await page.getByRole("menuitem", { name: "Proxy settings" }).click();
  await expect(page.getByLabel("Base URL")).toHaveValue("https://proxy.example.com/v1");

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Proxy cleared.")).toBeVisible();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Actions for ChatGPT" }).click();
  await page.getByRole("menuitem", { name: "Proxy settings" }).click();
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
