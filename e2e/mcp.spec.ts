import { expect, type Page, test } from "@playwright/test";

import { MCP_API_KEY, MCP_BEARER_TOKEN, MODERN_REVISION } from "./mcp-server.ts";
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

// Makes an org policy every call of which waits for anyone who can edit the thread.
async function makeSignOff(page: Page) {
  const res = await page.request.post("/api/v1/org/tool-policies", {
    data: {
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: ["editors"],
      independent: false,
    },
  });
  expect(res.ok()).toBe(true);
}

// Sets the tool, in its row, to a policy, Off, or nothing, and waits for the picker to say so.
async function setTool(page: Page, tool: string, choice: string, shown = choice) {
  const button = page.getByRole("listitem", { name: tool }).getByRole("button", {
    name: new RegExp(`^${tool} (policy|policy in this space)$`),
  });
  await button.click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${choice}`) }).click();
  await expect(button).toContainText(shown);
  return button;
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
  await makeSignOff(page);
  await page.reload();
  await setTool(page, "Add note", "Sign-off");

  await page.goto("/org/tools");
  const notes = page.getByRole("region", { name: "Notes" });
  await expect(notes).toContainText("3 tools");
  await expect(notes).toContainText("1 Sign-off");
  // Its tools open in the list too.
  await notes.getByRole("button", { name: /^Notes 3 tools/ }).click();
  await expect(notes.getByRole("listitem", { name: "Echo" })).toBeVisible();

  await page.goto(`/s/${spaceId}`);
  await write(page, `/tool mcp:${serverId}/add_note {"title":"Engines","body":"They compute"}`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const card = transcript(page).getByRole("article", {
    name: "Approval request",
  });
  await expect(card).toContainText("Notes");
  await expect(card).toContainText("Add note");
  await card.getByRole("button", { name: "Allow", exact: true }).click();

  const line = transcript(page).getByRole("button", {
    name: /^Notes › Add note · Ran · allowed by/,
  });
  await expect(line).toBeVisible();
  await line.click();
  const output = transcript(page).getByRole("region", { name: "Output" });
  await expect(output).toContainText("Title");
  await expect(output).toContainText("Engines");
  await expect(output).toContainText("Words");

  // A call that was allowed and then failed still says who allowed it.
  await write(page, `/tool mcp:${serverId}/delete_note {"id":"missing"}`);
  await expect(card).toContainText("Delete note");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    transcript(page).getByRole("button", {
      name: /^Notes › Delete note · Failed · allowed by Ada Lovelace/,
    }),
  ).toBeVisible();
});

test("OAuth MCP servers of either revision are authorized in the browser and list their tools", async ({
  page,
}) => {
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
  await expect(page.getByText("2025-11-25", { exact: true })).toBeVisible();

  // One that speaks only the 2026-07-28 revision, and refuses the older handshake.
  await page.goto("/org/tools");
  await addServer(
    page,
    "Modern tracker",
    `${mcpServer}/modern/oauth/mcp`,
    (dialog) => dialog.getByRole("button", { name: "OAuth" }).click(),
    "Add and sign in",
  );
  await expect(page.getByRole("heading", { name: "Modern tracker" })).toBeVisible();
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(page.getByText(MODERN_REVISION, { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Delete note" })).toBeVisible();
});

test("a space's own MCP server is used in that space's threads alone", async ({ page }) => {
  const own = await signUp(page);
  const res = await page.request.post("/api/v1/spaces", {
    data: { name: "Lab" },
  });
  const lab = ((await res.json()) as { id: string }).id;

  await page.goto(`/s/${lab}/settings/tools`);
  const card = page.locator("[data-slot=card]").filter({ hasText: "MCP servers" });
  await expect(card).toContainText("No servers yet");
  const serverId = await addServer(
    page,
    "Lab notes",
    `${mcpServer}/headers/mcp`,
    withBearer(MCP_BEARER_TOKEN),
  );
  await expect(page.getByRole("heading", { name: "Lab notes", exact: true })).toBeVisible();
  await expect(page.getByText("This space", { exact: true })).toBeVisible();

  await page.goto("/org/tools");
  await expect(page.getByRole("heading", { name: "Tools and MCPs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Lab notes" })).toHaveCount(0);

  await page.goto(`/s/${lab}`);
  await write(page, `/tool mcp:${serverId}/echo {"text":"hello lab"}`);
  await expect(
    transcript(page).getByRole("button", { name: /^Lab notes › Echo · Ran/ }),
  ).toBeVisible();

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
  await makeSignOff(page);
  await page.reload();
  const picker = await setTool(page, "Add note", "Sign-off");

  // Moved to the open server, given by its address alone, which answers at /mcp.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Server URL").fill(mcpServer);
  await dialog.getByRole("button", { name: "None" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`${mcpServer}/mcp`, { exact: true })).toBeVisible();
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(picker).toContainText("Sign-off");
});

test("a space turns one of the org's MCP servers off for itself alone", async ({ page }) => {
  const own = await signUp(page);
  await page.goto("/org/tools");
  const serverId = await addServer(
    page,
    "Notes",
    `${mcpServer}/headers/mcp`,
    withBearer(MCP_BEARER_TOKEN),
  );
  await makeSignOff(page);

  await page.goto(`/s/${own}/settings/tools`);
  const row = page.getByRole("region", { name: "Notes" });
  await expect(row).not.toContainText("This space");
  await expect(row.getByRole("switch", { name: "Notes: on in this space" })).toBeChecked();

  // Its page in the space: the space's extra rules for its tools, and its switch; the rest is the
  // org's.
  await row.getByRole("link", { name: "Notes settings" }).click();
  await expect(page).toHaveURL(`/s/${own}/settings/tools/mcp/${serverId}`);
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(page.getByText("Managed by the organization")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await setTool(page, "Add note", "Sign-off");
  const inSpace = page.getByRole("switch", { name: "On in this space" });
  await expect(inSpace).toBeChecked();
  await inSpace.click();
  await expect(inSpace).not.toBeChecked();
  await expect(page.getByText("Off in this space", { exact: true })).toBeVisible();
  // Policies remain editable before the server is turned back on.
  const picker = await setTool(page, "Add note", "Off");
  await inSpace.click();
  await expect(inSpace).toBeChecked();
  await page.reload();
  await expect(picker).toContainText("Off");
  await inSpace.click();
  await expect(inSpace).not.toBeChecked();

  await page.goto(`/s/${own}`);
  await write(page, `/tool mcp:${serverId}/echo {"text":"hello"}`);
  await expect(transcript(page)).toContainText(`I cannot use mcp:${serverId}/echo here.`);

  await page.goto("/org/tools");
  const inOrg = page.getByRole("region", { name: "Notes" });
  await expect(inOrg.getByRole("switch", { name: "Notes: on" })).toBeChecked();
  await inOrg.getByRole("link", { name: "Notes settings" }).click();
  await expect(
    page
      .getByRole("listitem", { name: "Add note" })
      .getByRole("button", { name: "Add note policy" }),
  ).toContainText("Open");

  // A failed read must not invent an enabled space switch.
  await page.route(`**/api/v1/spaces/${own}/mcp-servers`, (route) =>
    route.fulfill({ status: 500, json: { error: "unavailable" } }),
  );
  await page.goto(`/s/${own}/settings/tools/mcp/${serverId}`);
  await expect(
    page.getByText("could not read the space's MCP servers", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(inSpace).toBeDisabled();
  await expect(inSpace).not.toBeChecked();
});
