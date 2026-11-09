import { expect, type Page, test } from "@playwright/test";

import { MCP_BEARER_TOKEN } from "./mcp-server.ts";
import { mcpServer } from "./servers.ts";

// Sign-ups are rate limited per client address; each person counts as their own client, in every
// worker running this file.
let client = 320;
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
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Events" });
}

function box(page: Page) {
  return page.getByLabel("Message", { exact: true });
}

async function write(page: Page, text: string) {
  await box(page).fill(text);
  await expect(box(page)).toHaveValue(text);
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
}

// Starts a thread and waits for the agent's first reply, so the thread's commands are there.
async function startThread(page: Page) {
  await write(page, "Hello");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(transcript(page)).toContainText("I have read 1 message");
}

async function addSkill(page: Page, name: string, description: string, body: string) {
  const res = await page.request.post("/api/v1/org/skills", { data: { name, description, body } });
  expect(res.ok()).toBe(true);
}

test("the menu opens on a slash, filters as one types, and sends the skill picked", async ({
  page,
}) => {
  await signUp(page);
  // The stand-in model says back what follows a /say line.
  await addSkill(page, "pirate", "Talk like a pirate", "/say\nArr, $ARGUMENTS!");
  await addSkill(page, "haiku", "Write a haiku", "Write three lines.");
  await startThread(page);

  await box(page).fill("/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  await expect(menu.getByRole("option")).toHaveText([
    /^\/btw/,
    /^\/compact/,
    /^\/haiku/,
    /^\/pirate/,
  ]);
  await expect(menu.getByRole("option", { name: /^\/pirate/ })).toContainText("Skill");
  await box(page).fill("/pi");
  await expect(menu.getByRole("option")).toHaveText([/^\/pirate.*Talk like a pirate/]);
  await box(page).press("Escape");
  await expect(menu).toBeHidden();
  await box(page).fill("/p");
  await box(page).press("Enter");
  await expect(menu).toBeHidden();
  await expect(box(page)).toHaveValue("/pirate ");
  await box(page).pressSequentially("matey");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");

  const sent = transcript(page).getByRole("article", { name: "Message from Ada Lovelace" }).last();
  await expect(sent.locator("code")).toHaveText("/pirate");
  await expect(sent).toContainText("/pirate matey");
  await expect(transcript(page).getByText("Arr, matey!")).toBeVisible();
});

test("an MCP server's prompt runs with the arguments given and its text reaches the agent", async ({
  page,
}) => {
  await signUp(page);
  const res = await page.request.post("/api/v1/org/mcp-servers", {
    data: {
      name: "Notes",
      url: `${mcpServer}/headers/mcp`,
      auth: {
        kind: "headers",
        headers: [{ name: "Authorization", value: `Bearer ${MCP_BEARER_TOKEN}` }],
      },
    },
  });
  expect(res.ok()).toBe(true);
  await startThread(page);

  await box(page).fill("/notes");
  await expect(page.getByRole("listbox", { name: "Commands" }).getByRole("option")).toHaveText([
    /^\/notes:greet.*<name> \[tone\].*Greet someone by name\./,
  ]);
  // Without the name it needs, nothing is sent and the text stays.
  await box(page).fill("/notes:greet");
  await box(page).press("Enter");
  await expect(page.getByText("/notes:greet needs name")).toBeVisible();
  await expect(box(page)).toHaveValue("/notes:greet");

  await write(page, "/notes:greet Grace");
  await expect(transcript(page).getByText("Hello, Grace!")).toBeVisible();
});
