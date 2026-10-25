import { expect, type Page, test } from "@playwright/test";

import { MCP_API_KEY, MCP_BEARER_TOKEN } from "./mcp-server.ts";
import { mcpServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 250;
test.beforeEach(async ({ context }, testInfo) => {
  client += 1;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.${testInfo.parallelIndex}.${client}`,
  });
});

async function signUp(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  return new URL(page.url()).pathname.split("/")[2]!;
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

async function write(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

// Adds a server from the open Tools page's dialog, and returns its id from its page.
async function addServer(
  page: Page,
  name: string,
  url: string,
  auth: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>,
  submit = "Add server",
) {
  await page.getByRole("button", { name: "Add server" }).click();
  const dialog = page.getByRole("dialog", { name: "Add MCP server" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Server URL").fill(url);
  await auth(dialog);
  await dialog.getByRole("button", { name: submit }).click();
  await expect(page).toHaveURL(/\/tools\/mcp\/[^/]+$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

function withBearer(token: string) {
  return async (dialog: ReturnType<Page["getByRole"]>) => {
    await dialog.getByRole("button", { name: "Headers" }).click();
    await dialog.getByLabel("Bearer token").fill(token);
  };
}

test("an org's header-authorized MCP server lists its tools, and a call that asks shows its result", async ({
  page,
}) => {
  const spaceId = await signUp(page);
  await page.goto("/org/tools");
  const serverId = await addServer(
    page,
    "Notes",
    `${mcpServer}/headers/mcp`,
    withBearer(MCP_BEARER_TOKEN),
  );

  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(page.getByText("Streamable HTTP")).toBeVisible();
  await expect(page.getByText(MCP_BEARER_TOKEN)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Read-only tools", exact: true })).toContainText(
    "Echo",
  );
  const row = page.getByRole("listitem", { name: "Add note" });
  await row.getByRole("button", { name: "Needs approval" }).click();
  await expect(row.getByRole("button", { name: "Needs approval" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.goto("/org/tools");
  await expect(page.getByRole("listitem", { name: "Notes" })).toContainText("3 tools");

  await page.goto(`/s/${spaceId}`);
  await write(page, `/tool mcp:${serverId}/add_note {"title":"Engines","body":"They compute"}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = transcript(page).getByRole("article", { name: "Approval request" });
  await expect(card).toContainText("The agent wants to use Add note");
  await card.getByRole("button", { name: "Allow", exact: true }).click();

  const line = transcript(page).getByRole("button", { name: /^Add note · Ran · allowed by/ });
  await expect(line).toBeVisible();
  await line.click();
  const output = transcript(page).getByRole("region", { name: "Output" });
  await expect(output).toContainText("Title");
  await expect(output).toContainText("Engines");
  await expect(output).toContainText("Words");
});

test("an OAuth MCP server is authorized in the browser and lists its tools", async ({ page }) => {
  await signUp(page);
  await page.goto("/org/tools");
  await addServer(
    page,
    "Tracker",
    `${mcpServer}/oauth/mcp`,
    (dialog) => dialog.getByRole("button", { name: "OAuth" }).click(),
    "Add and sign in",
  );

  await expect(page.getByRole("heading", { name: "Tracker" })).toBeVisible();
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(page.getByText("Client registered by the server")).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Delete note" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
});

test("a space's own MCP server is used in that space's threads alone", async ({ page }) => {
  const own = await signUp(page);
  const res = await page.request.post("/api/v1/spaces", { data: { name: "Lab" } });
  const lab = ((await res.json()) as { id: string }).id;

  await page.goto(`/s/${lab}/settings/tools`);
  const card = page.locator("[data-slot=card]").filter({ hasText: "This space's MCP servers" });
  await expect(card).toContainText("No servers yet");
  const serverId = await addServer(
    page,
    "Lab notes",
    `${mcpServer}/headers/mcp`,
    withBearer(MCP_BEARER_TOKEN),
  );
  await expect(page.getByText("This space", { exact: true })).toBeVisible();

  await page.goto("/org/tools");
  await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Lab notes" })).toHaveCount(0);

  await page.goto(`/s/${lab}`);
  await write(page, `/tool mcp:${serverId}/echo {"text":"hello lab"}`);
  await expect(transcript(page).getByRole("button", { name: /^Echo · Ran/ })).toBeVisible();

  await page.goto(`/s/${own}`);
  await write(page, `/tool mcp:${serverId}/echo {"text":"hello"}`);
  await expect(transcript(page)).toContainText(`I cannot use mcp:${serverId}/echo here.`);
});

test("an MCP server's headers and address are changed in the form it was added with", async ({
  page,
}) => {
  await signUp(page);
  await page.goto("/org/tools");
  await addServer(page, "Notes", `${mcpServer}/headers/mcp`, async (dialog) => {
    await dialog.getByRole("button", { name: "Headers" }).click();
    await dialog.getByRole("button", { name: "Add header" }).click();
    await dialog.getByLabel("Header name").fill("X-Api-Key");
    await dialog.getByLabel("Value of X-Api-Key").fill("wrong-key-value");
  });
  await expect(page.getByText("Can't connect").first()).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit MCP server" });
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Notes");
  await expect(dialog.getByLabel("Server URL")).toHaveValue(`${mcpServer}/headers/mcp`);
  const value = dialog.getByLabel("Value of x-api-key");
  await expect(value).toHaveValue("");
  await expect(value).toHaveAttribute("placeholder", "…alue");
  await value.fill(MCP_API_KEY);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Connected").first()).toBeVisible();
  const row = page.getByRole("listitem", { name: "Add note" });
  await row.getByRole("button", { name: "Needs approval" }).click();
  await expect(row.getByRole("button", { name: "Needs approval" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Moved to the open server, given by its address alone, which answers at /mcp.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Server URL").fill(mcpServer);
  await dialog.getByRole("button", { name: "None" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`${mcpServer}/mcp`, { exact: true })).toBeVisible();
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(row.getByRole("button", { name: "Needs approval" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
